import {RealtimeSession} from './realtime-session.js';
import {realtimeUrl} from './realtime-inspector.js';
import {
  PressLedger,
  decodeGridFrame,
  effectiveBrightness,
  selectGridPort,
} from './performance-core.js';
import {
  LAUNCHPAD_SIZE,
  mapLaunchpadPad,
  normalizeLaunchpadView,
  pageRail,
  projectLaunchpadFrame,
} from './launchpad-core.js';

function command(session, target, action, args) {
  return session.command({target, action, args});
}

function releasePointerCapture(element, pointerId) {
  try {
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // Browsers may cancel capture before the release handler runs.
  }
}

function setReady(root, ready) {
  root.body?.toggleAttribute('data-ready', ready);
  root.querySelectorAll('[data-launchpad-control]').forEach(element => {
    element.dataset.disabled = ready ? 'false' : 'true';
    if ('disabled' in element) element.disabled = !ready;
  });
}

function renderPortOptions(select, ports, selected) {
  const fragment = document.createDocumentFragment();
  for (const [key, value] of Object.entries(ports || {}).sort(([left], [right]) => Number(left) - Number(right))) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = `port ${key} · ${value.virtual ? 'virtual' : 'physical'} · ${value.cols}×${value.rows}`;
    fragment.append(option);
  }
  select.replaceChildren(fragment);
  select.value = selected == null ? '' : String(selected);
}

function createPad(index) {
  const x = index % LAUNCHPAD_SIZE + 1;
  const y = Math.floor(index / LAUNCHPAD_SIZE) + 1;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'launchpad-pad';
  button.dataset.launchpadControl = '';
  button.dataset.index = String(index);
  button.dataset.x = String(x);
  button.dataset.y = String(y);
  button.setAttribute('aria-label', `Launchpad ${x}, ${y}`);
  return button;
}

function buildPads(container) {
  if (container.childElementCount === LAUNCHPAD_SIZE * LAUNCHPAD_SIZE) return;
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < LAUNCHPAD_SIZE * LAUNCHPAD_SIZE; index += 1) {
    fragment.append(createPad(index));
  }
  container.replaceChildren(fragment);
}

function createRailButton(axis, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'launchpad-rail-key';
  button.dataset.launchpadControl = '';
  button.dataset.axis = axis;
  button.dataset.page = String(index);
  button.setAttribute('aria-label', `${axis.toUpperCase()} page ${index + 1}`);
  return button;
}

function buildRail(container, axis) {
  if (container.childElementCount === 8) return;
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 8; index += 1) fragment.append(createRailButton(axis, index));
  container.replaceChildren(fragment);
}

function updateRail(container, items, ready) {
  [...container.children].forEach((button, index) => {
    const item = items[index];
    button.textContent = item.label;
    button.disabled = !ready || !item.enabled;
    button.dataset.disabled = button.disabled ? 'true' : 'false';
    button.dataset.active = item.active ? 'true' : 'false';
  });
}

function padAt(root, event) {
  const direct = event.target?.closest?.('.launchpad-pad');
  if (direct) return direct;
  return root.elementFromPoint?.(event.clientX, event.clientY)?.closest?.('.launchpad-pad') || null;
}

function syncPressed(container, active) {
  const pressed = new Set([...active.values()].filter(Boolean));
  container.querySelectorAll('.launchpad-pad').forEach(button => {
    button.dataset.pressed = pressed.has(button) ? 'true' : 'false';
  });
}

function installPadGestures(root, container, ledger, getContext) {
  const active = new Map();
  const targetFor = button => {
    const context = getContext();
    if (!button || !context?.frame || !context?.view) return null;
    const mapped = mapLaunchpadPad(Number(button.dataset.x), Number(button.dataset.y), context.view);
    return mapped ? {port: context.frame.port, ...mapped} : null;
  };
  const move = (pointerId, button) => {
    if (active.get(pointerId) === button) return;
    const target = targetFor(button);
    active.set(pointerId, target ? button : null);
    ledger.move(pointerId, target);
    syncPressed(container, active);
  };
  const capture = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  container.addEventListener('pointerdown', event => {
    if (container.dataset.disabled === 'true' || event.button > 0) return;
    const button = padAt(root, event);
    if (!button || button.disabled) return;
    capture(event);
    container.setPointerCapture?.(event.pointerId);
    move(event.pointerId, button);
  }, true);
  container.addEventListener('pointermove', event => {
    if (!active.has(event.pointerId)) return;
    capture(event);
    const button = padAt(root, event);
    move(event.pointerId, button?.disabled ? null : button);
  }, true);
  const finish = event => {
    if (!active.has(event.pointerId)) return;
    capture(event);
    active.delete(event.pointerId);
    ledger.release(event.pointerId);
    syncPressed(container, active);
    releasePointerCapture(container, event.pointerId);
  };
  container.addEventListener('pointerup', finish, true);
  container.addEventListener('pointercancel', finish, true);
  container.addEventListener('lostpointercapture', finish, true);
  container.addEventListener('keydown', event => {
    const button = event.target.closest?.('.launchpad-pad');
    if (!button || button.disabled || event.repeat || (event.key !== ' ' && event.key !== 'Enter')) return;
    event.preventDefault();
    const pointerId = `key:${button.dataset.index}:${event.key}`;
    if (!active.has(pointerId)) move(pointerId, button);
  });
  container.addEventListener('keyup', event => {
    const button = event.target.closest?.('.launchpad-pad');
    if (!button || (event.key !== ' ' && event.key !== 'Enter')) return;
    event.preventDefault();
    const pointerId = `key:${button.dataset.index}:${event.key}`;
    if (!active.has(pointerId)) return;
    active.delete(pointerId);
    ledger.release(pointerId);
    syncPressed(container, active);
  });
  return {
    releaseAll() {
      active.clear();
      ledger.releaseAll();
      syncPressed(container, active);
    },
  };
}

export function mountLaunchpadSurface(root = document, options = {}) {
  const url = options.url || realtimeUrl(options.locationLike || location);
  const session = options.session || new RealtimeSession({
    socketFactory: value => new WebSocket(value),
    url,
    channels: ['device', 'script', 'grid'],
  });
  const status = root.getElementById('launchpad-status');
  const revision = root.getElementById('launchpad-revision');
  const script = root.getElementById('launchpad-script');
  const endpoint = root.getElementById('launchpad-endpoint');
  const portSelect = root.getElementById('launchpad-port');
  const rotationSelect = root.getElementById('launchpad-rotation');
  const flipX = root.getElementById('launchpad-flip-x');
  const flipY = root.getElementById('launchpad-flip-y');
  const xRail = root.getElementById('launchpad-x-pages');
  const yRail = root.getElementById('launchpad-y-pages');
  const pads = root.getElementById('launchpad-pads');
  const bank = root.getElementById('launchpad-bank');
  const notice = root.getElementById('launchpad-notice');

  endpoint.textContent = url;
  buildPads(pads);
  buildRail(xRail, 'x');
  buildRail(yRail, 'y');

  let ports = {};
  let preferredPort = null;
  let frame = null;
  let view = null;
  let ready = false;
  const viewState = {pageX: 0, pageY: 0, rotation: 0, flipX: false, flipY: false};
  const ledger = new PressLedger((target, z) => command(session, 'grid', 'key', {...target, z}));
  const gestures = installPadGestures(root, pads, ledger, () => ({frame, view}));

  const render = () => {
    if (!frame) {
      view = null;
      [...pads.children].forEach(button => {
        button.disabled = true;
        button.dataset.disabled = 'true';
        button.dataset.valid = 'false';
        button.style.setProperty('--level', '0');
        button.style.setProperty('--glow', '0px');
      });
      updateRail(xRail, pageRail(1, 0), false);
      updateRail(yRail, pageRail(1, 0), false);
      bank.textContent = 'no Grid frame';
      return;
    }

    const projection = projectLaunchpadFrame(frame, viewState);
    view = projection.view;
    Object.assign(viewState, {
      pageX: view.pageX,
      pageY: view.pageY,
      rotation: view.rotation,
      flipX: view.flipX,
      flipY: view.flipY,
    });
    rotationSelect.value = String(view.rotation);
    flipX.checked = view.flipX;
    flipY.checked = view.flipY;
    updateRail(xRail, pageRail(view.pagesX, view.pageX), ready);
    updateRail(yRail, pageRail(view.pagesY, view.pageY), ready);
    bank.textContent = `X ${view.pageX + 1}/${view.pagesX} · Y ${view.pageY + 1}/${view.pagesY}`;

    [...pads.children].forEach((button, index) => {
      const valid = projection.valid[index];
      const level = projection.values[index] ?? 0;
      const brightness = effectiveBrightness(level, frame.intensity);
      button.disabled = !ready || !valid;
      button.dataset.disabled = button.disabled ? 'true' : 'false';
      button.dataset.valid = valid ? 'true' : 'false';
      button.dataset.level = String(level);
      button.style.setProperty('--level', String(brightness));
      button.style.setProperty('--glow', `${Math.round(3 + brightness * 22)}px`);
    });
  };

  const selectFrame = state => {
    ports = state?.data?.grid?.ports || {};
    preferredPort = selectGridPort(ports, preferredPort);
    renderPortOptions(portSelect, ports, preferredPort);
    const raw = preferredPort == null ? null : ports[String(preferredPort)];
    frame = raw ? decodeGridFrame(raw) : null;
  };

  const changeView = updater => {
    gestures.releaseAll();
    updater();
    render();
  };

  xRail.addEventListener('click', event => {
    const button = event.target.closest?.('[data-page]');
    if (!button || button.disabled) return;
    changeView(() => { viewState.pageX = Number(button.dataset.page); });
  });
  yRail.addEventListener('click', event => {
    const button = event.target.closest?.('[data-page]');
    if (!button || button.disabled) return;
    changeView(() => { viewState.pageY = Number(button.dataset.page); });
  });
  portSelect.addEventListener('change', () => {
    changeView(() => {
      preferredPort = Number(portSelect.value) || null;
      viewState.pageX = 0;
      viewState.pageY = 0;
      selectFrame(session.state);
    });
  });
  rotationSelect.addEventListener('change', () => {
    changeView(() => { viewState.rotation = Number(rotationSelect.value); });
  });
  flipX.addEventListener('change', () => {
    changeView(() => { viewState.flipX = flipX.checked; });
  });
  flipY.addEventListener('change', () => {
    changeView(() => { viewState.flipY = flipY.checked; });
  });

  const releaseAll = () => gestures.releaseAll();
  globalThis.addEventListener?.('pagehide', releaseAll);
  globalThis.addEventListener?.('blur', releaseAll);
  root.addEventListener?.('visibilitychange', () => {
    if (root.visibilityState === 'hidden') releaseAll();
  });

  session.addEventListener('state', event => {
    const state = event.detail;
    ready = state.status === 'synced' && Boolean(state.data);
    status.textContent = state.status;
    revision.textContent = state.revision ?? '—';
    setReady(root, ready);
    if (!ready) releaseAll();
    if (ready) {
      script.textContent = state.data.script?.active ? state.data.script.name : 'no active script';
      selectFrame(state);
      notice.textContent = frame
        ? `Authoritative ${frame.cols}×${frame.rows} Grid on port ${frame.port}. Rails change browser pages only.`
        : 'No Grid frame has been published yet.';
    } else {
      frame = null;
      script.textContent = 'no active script';
      notice.textContent = state.status === 'reconnecting'
        ? 'Connection lost. Held pads were released.'
        : 'Waiting for authoritative Grid state…';
    }
    render();
  });
  session.addEventListener('command', event => {
    if (event.detail.status === 'reject' || event.detail.status === 'uncertain') {
      notice.textContent = event.detail.error || `Grid command ${event.detail.status}`;
    }
  });
  session.addEventListener('protocolerror', event => {
    notice.textContent = `Protocol error: ${event.detail.message}`;
  });

  setReady(root, false);
  render();
  session.connect();
  return session;
}
