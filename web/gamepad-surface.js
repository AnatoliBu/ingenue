import {RealtimeSession} from './realtime-session.js';
import {realtimeUrl} from './realtime-inspector.js';
import {AppliedValueLane, PressLedger} from './performance-core.js';
import {
  DirectionLedger,
  normalizeStickVector,
  normalizeTrigger,
  pointerStickVector,
} from './gamepad-core.js';

function command(session, action, args, options = {}) {
  return session.command({target: 'gamepad', action, args}, options);
}

function releasePointerCapture(element, pointerId) {
  try {
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
  } catch {}
}

function disabled(element) {
  return Boolean(element.disabled || element.dataset.disabled === 'true');
}

function setReady(root, ready) {
  root.body?.toggleAttribute('data-ready', ready);
  root.querySelectorAll('[data-gamepad-control]').forEach(element => {
    element.dataset.disabled = ready ? 'false' : 'true';
    if ('disabled' in element) element.disabled = !ready;
  });
}

function bindMomentary(button, ledger, target) {
  const down = event => {
    if (disabled(button) || event.button > 0) return;
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
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
    if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat) return;
    down({button: 0, pointerId: `key:${event.key}`, preventDefault: () => event.preventDefault()});
  });
  button.addEventListener('keyup', event => {
    if (event.key === ' ' || event.key === 'Enter') up({pointerId: `key:${event.key}`});
  });
}

function bindDirection(button, ledger, target) {
  const down = event => {
    if (disabled(button) || event.button > 0) return;
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    ledger.press(event.pointerId, target);
    button.parentElement?.querySelectorAll(`[data-gamepad-direction^="${target.axis}:"]`).forEach(element => {
      element.dataset.pressed = 'false';
    });
    button.dataset.pressed = 'true';
  };
  const up = event => {
    ledger.release(event.pointerId);
    button.dataset.pressed = 'false';
    releasePointerCapture(button, event.pointerId);
  };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
  button.addEventListener('lostpointercapture', up);
  button.addEventListener('keydown', event => {
    if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat) return;
    down({button: 0, pointerId: `key:${event.key}`, preventDefault: () => event.preventDefault()});
  });
  button.addEventListener('keyup', event => {
    if (event.key === ' ' || event.key === 'Enter') up({pointerId: `key:${event.key}`});
  });
}

function createAxisLanes(session) {
  const lanes = new Map();
  const settlements = new Map();
  const laneFor = axis => {
    if (!lanes.has(axis)) {
      const lane = new AppliedValueLane(value => {
        const id = command(session, 'analog', {axis, value});
        settlements.set(id, lane);
        return id;
      });
      lanes.set(axis, lane);
    }
    return lanes.get(axis);
  };
  return {
    push(axis, value) { laneFor(axis).push(value); },
    settle(detail) {
      const lane = settlements.get(detail.id);
      if (!lane) return;
      settlements.delete(detail.id);
      const next = lane.settle(detail.id, detail.status);
      if (next) settlements.set(next, lane);
    },
    center() {
      for (const axis of ['leftx', 'lefty', 'rightx', 'righty']) laneFor(axis).push(0);
      for (const axis of ['triggerleft', 'triggerright']) laneFor(axis).push(0);
    },
  };
}

function renderStick(element, vector) {
  const knob = element.querySelector('.gamepad-stick-knob');
  knob.style.setProperty('--stick-x', String(vector.x));
  knob.style.setProperty('--stick-y', String(vector.y));
  element.querySelector('.gamepad-stick-value').textContent = `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}`;
}

function bindStick(element, prefix, lanes) {
  let pointerId = null;
  const apply = event => {
    const vector = pointerStickVector(element.getBoundingClientRect(), event.clientX, event.clientY);
    renderStick(element, vector);
    lanes.push(`${prefix}x`, vector.x);
    lanes.push(`${prefix}y`, vector.y);
  };
  const center = event => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    const vector = normalizeStickVector(0, 0);
    renderStick(element, vector);
    lanes.push(`${prefix}x`, 0);
    lanes.push(`${prefix}y`, 0);
    releasePointerCapture(element, event.pointerId);
  };
  element.addEventListener('pointerdown', event => {
    if (disabled(element) || event.button > 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    element.setPointerCapture?.(event.pointerId);
    apply(event);
  });
  element.addEventListener('pointermove', event => {
    if (pointerId !== event.pointerId) return;
    event.preventDefault();
    apply(event);
  });
  element.addEventListener('pointerup', center);
  element.addEventListener('pointercancel', center);
  element.addEventListener('lostpointercapture', center);
  renderStick(element, normalizeStickVector(0, 0));
  return () => {
    if (pointerId != null) center({pointerId});
    else {
      renderStick(element, normalizeStickVector(0, 0));
      lanes.push(`${prefix}x`, 0);
      lanes.push(`${prefix}y`, 0);
    }
  };
}

function bindTrigger(input, axis, lanes, valueEl) {
  const push = () => {
    const value = normalizeTrigger(input.value);
    valueEl.textContent = value.toFixed(2);
    lanes.push(axis, value);
  };
  input.addEventListener('input', push);
  input.addEventListener('change', push);
  valueEl.textContent = normalizeTrigger(input.value).toFixed(2);
  return () => {
    input.value = '0';
    valueEl.textContent = '0.00';
    lanes.push(axis, 0);
  };
}

export function mountGamepadSurface(root = document, options = {}) {
  const url = options.url || realtimeUrl(options.locationLike || location);
  const session = options.session || new RealtimeSession({
    socketFactory: value => new WebSocket(value),
    url,
    channels: ['device', 'script'],
  });
  const status = root.getElementById('gamepad-status');
  const revision = root.getElementById('gamepad-revision');
  const script = root.getElementById('gamepad-script');
  const endpoint = root.getElementById('gamepad-endpoint');
  const notice = root.getElementById('gamepad-notice');
  endpoint.textContent = url;

  const buttons = new PressLedger((target, z) => command(session, 'button', {name: target.name, z}));
  const directions = new DirectionLedger((axis, sign) => command(session, 'dpad', {axis, sign}));
  const lanes = createAxisLanes(session);

  root.querySelectorAll('[data-gamepad-button]').forEach(button => {
    bindMomentary(button, buttons, {name: button.dataset.gamepadButton});
  });
  root.querySelectorAll('[data-gamepad-direction]').forEach(button => {
    const [axis, sign] = button.dataset.gamepadDirection.split(':');
    bindDirection(button, directions, {axis, sign: Number(sign)});
  });

  const resetLeft = bindStick(root.getElementById('gamepad-left-stick'), 'left', lanes);
  const resetRight = bindStick(root.getElementById('gamepad-right-stick'), 'right', lanes);
  const resetLeftTrigger = bindTrigger(
    root.getElementById('gamepad-left-trigger'), 'triggerleft', lanes,
    root.getElementById('gamepad-left-trigger-value'),
  );
  const resetRightTrigger = bindTrigger(
    root.getElementById('gamepad-right-trigger'), 'triggerright', lanes,
    root.getElementById('gamepad-right-trigger-value'),
  );

  const releaseAll = () => {
    buttons.releaseAll();
    directions.releaseAll();
    resetLeft();
    resetRight();
    resetLeftTrigger();
    resetRightTrigger();
    root.querySelectorAll('[data-pressed="true"]').forEach(element => { element.dataset.pressed = 'false'; });
  };
  globalThis.addEventListener?.('pagehide', releaseAll);
  globalThis.addEventListener?.('blur', releaseAll);
  root.addEventListener?.('visibilitychange', () => {
    if (root.visibilityState === 'hidden') releaseAll();
  });

  session.addEventListener('state', event => {
    const state = event.detail;
    const ready = state.status === 'synced' && Boolean(state.data);
    status.textContent = state.status;
    revision.textContent = state.revision ?? '—';
    script.textContent = ready && state.data.script?.active ? state.data.script.name : 'no active script';
    setReady(root, ready);
    if (!ready) releaseAll();
    notice.textContent = ready
      ? 'Virtual gamepad callbacks are Lua-applied inside norns.'
      : state.status === 'reconnecting'
        ? 'Connection lost. Buttons, directions, sticks and triggers were released.'
        : 'Waiting for authoritative session state…';
  });
  session.addEventListener('command', event => {
    lanes.settle(event.detail);
    if (event.detail.status === 'reject' || event.detail.status === 'uncertain') {
      notice.textContent = event.detail.error || `Gamepad command ${event.detail.status}`;
    }
  });
  session.addEventListener('protocolerror', event => {
    notice.textContent = `Protocol error: ${event.detail.message}`;
  });

  setReady(root, false);
  session.connect();
  return session;
}
