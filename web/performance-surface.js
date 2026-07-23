import {RealtimeSession} from './realtime-session.js';
import {realtimeUrl} from './realtime-inspector.js';
import {
  AppliedValueLane,
  PressLedger,
  arcAngularSteps,
  decodeArcFrame,
  decodeGridFrame,
  effectiveBrightness,
  encoderSteps,
  selectArcPort,
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

function controlDisabled(element) {
  return Boolean(element.disabled || element.dataset.disabled === 'true');
}

function setControlsEnabled(root, enabled) {
  root.querySelectorAll('[data-performance-control]').forEach(element => {
    if ('disabled' in element) element.disabled = !enabled;
    element.dataset.disabled = enabled ? 'false' : 'true';
  });
  root.body?.toggleAttribute('data-ready', enabled);
}

function resolveTarget(target) {
  return typeof target === 'function' ? target() : target;
}

function bindMomentaryButton(button, ledger, target) {
  const down = event => {
    if (controlDisabled(button) || event.button > 0) return;
    event.preventDefault();
    if (Number.isInteger(event.pointerId)) button.setPointerCapture?.(event.pointerId);
    ledger.press(event.pointerId, resolveTarget(target));
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

function sendBoundedDelta(session, target, action, args, valueKey, delta) {
  let remaining = delta;
  while (remaining !== 0) {
    const part = Math.max(-127, Math.min(127, remaining));
    command(session, target, action, {...args, [valueKey]: part});
    remaining -= part;
  }
}

function bindEncoder(element, n, session) {
  let gesture = null;
  const sendDelta = delta => sendBoundedDelta(session, 'control', 'enc', {n}, 'd', delta);
  element.addEventListener('pointerdown', event => {
    if (controlDisabled(element) || event.button > 0) return;
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
    if (controlDisabled(element)) return;
    event.preventDefault();
    sendDelta(event.deltaY < 0 ? 1 : -1);
  }, {passive: false});
  element.querySelector('[data-delta="-1"]')?.addEventListener('click', () => {
    if (!controlDisabled(element)) sendDelta(-1);
  });
  element.querySelector('[data-delta="1"]')?.addEventListener('click', () => {
    if (!controlDisabled(element)) sendDelta(1);
  });
}

function pointerAngle(element, event) {
  const rect = element.getBoundingClientRect();
  const x = event.clientX - (rect.left + rect.width / 2);
  const y = event.clientY - (rect.top + rect.height / 2);
  return Math.atan2(y, x);
}

function bindArcRing(element, ring, getPort, session) {
  let gesture = null;
  const sendDelta = delta => {
    if (!delta) return;
    sendBoundedDelta(session, 'arc', 'delta', {port: getPort(), n: ring}, 'd', delta);
  };
  element.addEventListener('pointerdown', event => {
    if (controlDisabled(element) || event.button > 0 || event.target.closest('.arc-key')) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    gesture = {
      pointerId: event.pointerId,
      angle: pointerAngle(element, event),
      remainder: 0,
    };
    element.dataset.pressed = 'true';
  });
  element.addEventListener('pointermove', event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const angle = pointerAngle(element, event);
    const total = arcAngularSteps(gesture.angle, angle) + gesture.remainder;
    const delta = Math.trunc(total);
    gesture.remainder = total - delta;
    gesture.angle = angle;
    sendDelta(delta);
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
    if (controlDisabled(element)) return;
    event.preventDefault();
    sendDelta(event.deltaY < 0 ? 4 : -4);
  }, {passive: false});
  element.addEventListener('keydown', event => {
    if (controlDisabled(element)) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    sendDelta(direction * (event.shiftKey ? 8 : 1));
  });
}

function renderPortOptions(select, ports, selected, kind) {
  const previous = select.value;
  const fragment = document.createDocumentFragment();
  for (const [key, value] of Object.entries(ports || {}).sort(([a], [b]) => Number(a) - Number(b))) {
    const option = document.createElement('option');
    option.value = key;
    const shape = kind === 'grid' ? `${value.cols}×${value.rows}` : `${value.rings} rings`;
    option.textContent = `port ${key} · ${value.virtual ? 'virtual' : 'physical'} · ${shape}`;
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

function createArcLed(index) {
  const namespace = 'http://www.w3.org/2000/svg';
  const angle = index / 64 * Math.PI * 2 - Math.PI / 2;
  const circle = document.createElementNS(namespace, 'circle');
  circle.setAttribute('cx', String(60 + Math.cos(angle) * 48));
  circle.setAttribute('cy', String(60 + Math.sin(angle) * 48));
  circle.setAttribute('r', '2.7');
  circle.dataset.index = String(index);
  return circle;
}

function renderArc(container, frame, visibleRings, keyLedger, session, getPort) {
  const rings = Math.min(frame.rings, visibleRings);
  const signature = `${frame.port}:${frame.rings}:${rings}`;
  if (container.dataset.signature !== signature) {
    keyLedger.releaseAll();
    container.dataset.signature = signature;
    container.style.setProperty('--arc-rings', rings);
    const fragment = document.createDocumentFragment();
    for (let ring = 1; ring <= rings; ring += 1) {
      const wrapper = document.createElement('div');
      wrapper.className = 'arc-ring';
      wrapper.dataset.performanceControl = '';
      wrapper.dataset.ring = String(ring);
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'group');
      wrapper.setAttribute('aria-label', `Arc ring ${ring}`);

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('arc-leds');
      svg.setAttribute('viewBox', '0 0 120 120');
      for (let index = 0; index < 64; index += 1) svg.append(createArcLed(index));

      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'arc-key';
      key.dataset.performanceControl = '';
      key.textContent = `A${ring}`;
      key.setAttribute('aria-label', `Arc key ${ring}`);
      bindMomentaryButton(key, keyLedger, () => ({port: getPort(), n: ring}));

      wrapper.append(svg, key);
      bindArcRing(wrapper, ring, getPort, session);
      fragment.append(wrapper);
    }
    container.replaceChildren(fragment);
  }

  container.querySelectorAll('.arc-ring').forEach((wrapper, ringIndex) => {
    wrapper.querySelectorAll('circle').forEach((led, ledIndex) => {
      const level = frame.values[ringIndex * 64 + ledIndex] ?? 0;
      const brightness = effectiveBrightness(level, frame.intensity);
      led.style.setProperty('--level', brightness);
      led.style.setProperty('--glow', `${Math.round(1 + brightness * 7)}px`);
      led.dataset.level = String(level);
    });
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
    channels: ['device', 'control', 'script', 'grid', 'arc'],
  });
  const status = root.getElementById('surface-status');
  const revision = root.getElementById('surface-revision');
  const script = root.getElementById('surface-script');
  const connection = root.getElementById('surface-endpoint');
  const gridPortSelect = root.getElementById('grid-port');
  const grid = root.getElementById('grid');
  const gridNotice = root.getElementById('surface-notice');
  const arcPortSelect = root.getElementById('arc-port');
  const arcLayoutSelect = root.getElementById('arc-layout');
  const arc = root.getElementById('arc');
  const arcNotice = root.getElementById('arc-notice');
  connection.textContent = url;

  let preferredGridPort = null;
  let preferredArcPort = null;
  let lastGridPorts = {};
  let lastArcPorts = {};
  const gridLedger = new PressLedger((target, z) => command(session, 'grid', 'key', {...target, z}));
  const keyLedger = new PressLedger((target, z) => command(session, 'control', 'key', {n: target.n, z}));
  const arcKeyLedger = new PressLedger((target, z) => command(session, 'arc', 'key', {...target, z}));
  const settleParam = createParamController(root, session);

  const getArcPort = () => preferredArcPort || Number(arcPortSelect.value) || 1;

  root.querySelectorAll('[data-key]').forEach(button => {
    bindMomentaryButton(button, keyLedger, {n: Number(button.dataset.key)});
  });
  root.querySelectorAll('[data-encoder]').forEach(element => {
    bindEncoder(element, Number(element.dataset.encoder), session);
  });

  gridPortSelect.addEventListener('change', () => {
    preferredGridPort = Number(gridPortSelect.value);
    const raw = lastGridPorts[String(preferredGridPort)];
    if (raw) renderGrid(grid, decodeGridFrame(raw), gridLedger);
  });
  arcPortSelect.addEventListener('change', () => {
    arcKeyLedger.releaseAll();
    preferredArcPort = Number(arcPortSelect.value);
    const raw = lastArcPorts[String(preferredArcPort)];
    if (raw) renderArc(arc, decodeArcFrame(raw), Number(arcLayoutSelect.value), arcKeyLedger, session, getArcPort);
  });
  arcLayoutSelect.addEventListener('change', () => {
    arcKeyLedger.releaseAll();
    const raw = lastArcPorts[String(getArcPort())];
    if (raw) renderArc(arc, decodeArcFrame(raw), Number(arcLayoutSelect.value), arcKeyLedger, session, getArcPort);
  });

  const releaseEverything = () => {
    gridLedger.releaseAll();
    keyLedger.releaseAll();
    arcKeyLedger.releaseAll();
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
      const message = state.status === 'reconnecting'
        ? 'Connection lost. Held controls were released.'
        : 'Waiting for authoritative state…';
      gridNotice.textContent = message;
      arcNotice.textContent = message;
      return;
    }

    script.textContent = state.data.script?.active ? state.data.script.name : 'no active script';

    lastGridPorts = state.data.grid?.ports || {};
    preferredGridPort = selectGridPort(lastGridPorts, preferredGridPort);
    renderPortOptions(gridPortSelect, lastGridPorts, preferredGridPort, 'grid');
    const gridRaw = preferredGridPort == null ? null : lastGridPorts[String(preferredGridPort)];
    if (gridRaw) {
      renderGrid(grid, decodeGridFrame(gridRaw), gridLedger);
      gridNotice.textContent = '';
    } else {
      grid.removeAttribute('data-signature');
      grid.replaceChildren();
      gridNotice.textContent = 'No Grid frame has been published yet.';
    }

    lastArcPorts = state.data.arc?.ports || {};
    preferredArcPort = selectArcPort(lastArcPorts, preferredArcPort);
    renderPortOptions(arcPortSelect, lastArcPorts, preferredArcPort, 'arc');
    const arcRaw = preferredArcPort == null ? null : lastArcPorts[String(preferredArcPort)];
    if (arcRaw) {
      renderArc(arc, decodeArcFrame(arcRaw), Number(arcLayoutSelect.value), arcKeyLedger, session, getArcPort);
      arcNotice.textContent = '';
    } else {
      arc.removeAttribute('data-signature');
      arc.replaceChildren();
      arcNotice.textContent = 'No Arc frame has been published yet.';
    }
  });
  session.addEventListener('command', event => {
    settleParam(event.detail);
    if (event.detail.status === 'reject' || event.detail.status === 'uncertain') {
      const message = event.detail.error || `Command ${event.detail.status}`;
      gridNotice.textContent = message;
      arcNotice.textContent = message;
    }
  });
  session.addEventListener('protocolerror', event => {
    const message = `Protocol error: ${event.detail.message}`;
    gridNotice.textContent = message;
    arcNotice.textContent = message;
  });

  setControlsEnabled(root, false);
  session.connect();
  return session;
}
