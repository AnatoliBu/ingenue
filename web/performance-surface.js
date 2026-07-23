import {RealtimeSession} from './realtime-session.js';
import {realtimeUrl} from './realtime-inspector.js';
import {
  AppliedValueLane,
  PressLedger,
  decodeGridFrame,
  effectiveBrightness,
  encoderSteps,
  selectGridPort,
} from './performance-core.js';

function command(session, target, action, args) {
  return session.command({target, action, args});
}

function releasePointerCapture(element, pointerId) {
  try {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // The pointer may already have been cancelled by the browser.
  }
}

function setControlsEnabled(root, enabled) {
  root.querySelectorAll('[data-performance-control]').forEach(element => {
    element.disabled = !enabled;
  });
  root.body?.toggleAttribute('data-ready', enabled);
}

function bindMomentaryButton(button, ledger, target) {
  const down = event => {
    if (button.disabled || event.button > 0) return;
    event.preventDefault();
    if (Number.isInteger(event.pointerId)) button.setPointerCapture?.(event.pointerId);
    ledger.press(event.pointerId, target);
    button.dataset.pressed = 'true';
  };
  const up = event => {
    if (ledger.release(event.pointerId)) button.dataset.pressed = 'false';
    releasePointerCapture(button, event.pointerId);
  };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
  button.addEventListener('lostpointercapture', up);
  button.addEventListener('keydown', event => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) down({
      button: 0,
      pointerId: `key:${event.key}`,
      preventDefault: () => event.preventDefault(),
    });
  });
  button.addEventListener('keyup', event => {
    if (event.key === ' ' || event.key === 'Enter') up({pointerId: `key:${event.key}`});
  });
}

function bindEncoder(element, n, session) {
  let gesture = null;
  const sendDelta = delta => {
    let remaining = delta;
    while (remaining !== 0) {
      const part = Math.max(-127, Math.min(127, remaining));
      command(session, 'control', 'enc', {n, d: part});
      remaining -= part;
    }
  };
  element.addEventListener('pointerdown', event => {
    if (element.disabled || event.button > 0) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    gesture = {pointerId: event.pointerId, startY: event.clientY, sent: 0};
    element.dataset.pressed = 'true';
  });
  element.addEventListener('pointermove', event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const steps = encoderSteps(gesture.startY, event.clientY);
    const delta = steps - gesture.sent;
    if (delta) {
      sendDelta(delta);
      gesture.sent = steps;
    }
  });
  const finish = event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture = null;
    element.dataset.pressed = 'false';
    releasePointerCapture(element, event.pointerId);
  };
  element.addEventListener('pointerup', finish);
  element.addEventListener('pointercancel', finish);
  element.addEventListener('lostpointercapture', finish);
  element.addEventListener('wheel', event => {
    if (element.disabled) return;
    event.preventDefault();
    sendDelta(event.deltaY < 0 ? 1 : -1);
  }, {passive: false});
  element.querySelector('[data-delta="-1"]')?.addEventListener('click', () => { if (!element.disabled) sendDelta(-1); });
  element.querySelector('[data-delta="1"]')?.addEventListener('click', () => { if (!element.disabled) sendDelta(1); });
}

function renderPortOptions(select, ports, selected) {
  const previous = select.value;
  const fragment = document.createDocumentFragment();
  for (const [key, value] of Object.entries(ports || {}).sort(([a], [b]) => Number(a) - Number(b))) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = `port ${key} · ${value.virtual ? 'virtual' : 'physical'} · ${value.cols}×${value.rows}`;
    fragment.append(option);
  }
  select.replaceChildren(fragment);
  select.value = String(selected ?? previous ?? '');
}

function renderGrid(container, frame, ledger) {
  const signature = `${frame.port}:${frame.cols}:${frame.rows}`;
  if (container.dataset.signature !== signature) {
    ledger.releaseAll();
    container.dataset.signature = signature;
    container.style.setProperty('--grid-cols', frame.cols);
    const fragment = document.createDocumentFragment();
    for (let y = 1; y <= frame.rows; y += 1) {
      for (let x = 1; x <= frame.cols; x += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'grid-key';
        button.dataset.performanceControl = '';
        button.dataset.index = String((y - 1) * frame.cols + (x - 1));
        button.setAttribute('aria-label', `Grid ${x}, ${y}`);
        bindMomentaryButton(button, ledger, {port: frame.port, x, y});
        fragment.append(button);
      }
    }
    container.replaceChildren(fragment);
  }
  container.querySelectorAll('.grid-key').forEach((button, index) => {
    const level = frame.values[index] ?? 0;
    const brightness = effectiveBrightness(level, frame.intensity);
    button.style.setProperty('--level', brightness);
    button.style.setProperty('--glow', `${Math.round(4 + brightness * 20)}px`);
    button.dataset.level = String(level);
  });
}

function createParamController(root, session) {
  const idInput = root.getElementById('param-id');
  const slider = root.getElementById('param-slider');
  const number = root.getElementById('param-number');
  const minInput = root.getElementById('param-min');
  const maxInput = root.getElementById('param-max');
  const lanes = new Map();
  const settlements = new Map();

  const laneFor = id => {
    if (!lanes.has(id)) {
      lanes.set(id, new AppliedValueLane(value => {
        const commandId = command(session, 'param', 'set', {id, value});
        settlements.set(commandId, lanes.get(id));
        return commandId;
      }));
    }
    return lanes.get(id);
  };
  const configure = () => {
    const min = Number(minInput.value);
    const max = Number(maxInput.value);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return false;
    slider.min = String(min);
    slider.max = String(max);
    slider.step = number.step || '0.01';
    return true;
  };
  const push = raw => {
    const id = idInput.value.trim();
    const value = Number(raw);
    if (!id || !Number.isFinite(value) || !configure()) return;
    const bounded = Math.min(Number(maxInput.value), Math.max(Number(minInput.value), value));
    slider.value = String(bounded);
    number.value = String(bounded);
    laneFor(id).push(bounded);
  };
  slider.addEventListener('input', () => push(slider.value));
  number.addEventListener('change', () => push(number.value));
  minInput.addEventListener('change', configure);
  maxInput.addEventListener('change', configure);
  configure();

  return detail => {
    const lane = settlements.get(detail.id);
    if (!lane) return;
    settlements.delete(detail.id);
    const nextId = lane.settle(detail.id, detail.status);
    if (nextId) settlements.set(nextId, lane);
  };
}

export function mountPerformanceSurface(root = document, options = {}) {
  const url = options.url || realtimeUrl(options.locationLike || location);
  const session = options.session || new RealtimeSession({
    socketFactory: value => new WebSocket(value),
    url,
    channels: ['device', 'control', 'script', 'grid'],
  });
  const status = root.getElementById('surface-status');
  const revision = root.getElementById('surface-revision');
  const script = root.getElementById('surface-script');
  const connection = root.getElementById('surface-endpoint');
  const portSelect = root.getElementById('grid-port');
  const grid = root.getElementById('grid');
  const notice = root.getElementById('surface-notice');
  connection.textContent = url;

  let preferredPort = null;
  let lastPorts = {};
  const gridLedger = new PressLedger((target, z) => command(session, 'grid', 'key', {...target, z}));
  const keyLedger = new PressLedger((target, z) => command(session, 'control', 'key', {n: target.n, z}));
  const settleParam = createParamController(root, session);

  root.querySelectorAll('[data-key]').forEach(button => {
    bindMomentaryButton(button, keyLedger, {n: Number(button.dataset.key)});
  });
  root.querySelectorAll('[data-encoder]').forEach(element => {
    bindEncoder(element, Number(element.dataset.encoder), session);
  });
  portSelect.addEventListener('change', () => {
    preferredPort = Number(portSelect.value);
    const raw = lastPorts[String(preferredPort)];
    if (raw) renderGrid(grid, decodeGridFrame(raw), gridLedger);
  });

  const releaseEverything = () => {
    gridLedger.releaseAll();
    keyLedger.releaseAll();
  };
  globalThis.addEventListener?.('pagehide', releaseEverything);
  root.addEventListener?.('visibilitychange', () => {
    if (root.visibilityState === 'hidden') releaseEverything();
  });

  session.addEventListener('state', event => {
    const state = event.detail;
    const ready = state.status === 'synced' && state.data;
    status.textContent = state.status;
    revision.textContent = state.revision ?? '—';
    setControlsEnabled(root, Boolean(ready));
    if (!ready) {
      releaseEverything();
      notice.textContent = state.status === 'reconnecting' ? 'Connection lost. Held controls were released.' : 'Waiting for authoritative state…';
      return;
    }
    notice.textContent = '';
    script.textContent = state.data.script?.active ? state.data.script.name : 'no active script';
    lastPorts = state.data.grid?.ports || {};
    const selected = selectGridPort(lastPorts, preferredPort);
    preferredPort = selected;
    renderPortOptions(portSelect, lastPorts, selected);
    const raw = selected == null ? null : lastPorts[String(selected)];
    if (raw) {
      renderGrid(grid, decodeGridFrame(raw), gridLedger);
    } else {
      grid.removeAttribute('data-signature');
      grid.replaceChildren();
      notice.textContent = 'No Grid frame has been published yet.';
    }
  });
  session.addEventListener('command', event => {
    settleParam(event.detail);
    if (event.detail.status === 'reject' || event.detail.status === 'uncertain') {
      notice.textContent = event.detail.error || `Command ${event.detail.status}`;
    }
  });
  session.addEventListener('protocolerror', event => {
    notice.textContent = `Protocol error: ${event.detail.message}`;
  });

  setControlsEnabled(root, false);
  session.connect();
  return session;
}
