import {
  PressLedger,
  decodeGridFrame,
  gridConfigurationFromFrame,
  normalizeGridConfiguration,
  selectGridPort,
} from './performance-core.js';

function send(session, target, action, args) {
  return session.command({target, action, args});
}

function buttonAt(root, event) {
  const direct = event.target?.closest?.('.grid-key');
  if (direct) return direct;
  return root.elementFromPoint?.(event.clientX, event.clientY)?.closest?.('.grid-key') || null;
}

function syncPressed(container, active) {
  const pressed = new Set([...active.values()].filter(Boolean));
  container.querySelectorAll('.grid-key').forEach(button => {
    button.dataset.pressed = pressed.has(button) ? 'true' : 'false';
  });
}

function targetFor(button, frame) {
  if (!button || !frame) return null;
  const index = Number(button.dataset.index);
  if (!Number.isSafeInteger(index) || index < 0 || index >= frame.cols * frame.rows) return null;
  return {
    port: frame.port,
    x: index % frame.cols + 1,
    y: Math.floor(index / frame.cols) + 1,
  };
}

function installGridGestures(root, container, ledger, getFrame) {
  const active = new Map();
  const moveTo = (pointerId, button) => {
    const previous = active.get(pointerId) || null;
    if (previous === button) return;
    const frame = getFrame();
    const target = targetFor(button, frame);
    active.set(pointerId, target ? button : null);
    ledger.move(pointerId, target);
    syncPressed(container, active);
  };
  const capture = event => {
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  container.addEventListener('pointerdown', event => {
    if (container.dataset.disabled === 'true' || event.button > 0) return;
    const button = buttonAt(root, event);
    if (!button) return;
    capture(event);
    container.setPointerCapture?.(event.pointerId);
    moveTo(event.pointerId, button);
  }, true);
  container.addEventListener('pointermove', event => {
    if (!active.has(event.pointerId)) return;
    capture(event);
    moveTo(event.pointerId, buttonAt(root, event));
  }, true);
  const finish = event => {
    if (!active.has(event.pointerId)) return;
    capture(event);
    active.delete(event.pointerId);
    ledger.release(event.pointerId);
    syncPressed(container, active);
    try {
      if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    } catch {}
  };
  container.addEventListener('pointerup', finish, true);
  container.addEventListener('pointercancel', finish, true);
  container.addEventListener('lostpointercapture', finish, true);
  return {
    releaseAll() {
      active.clear();
      ledger.releaseAll();
      syncPressed(container, active);
    },
  };
}

export function mountGridHardening(session, root = document) {
  const grid = root.getElementById('grid');
  const displayPort = root.getElementById('grid-port');
  const configPort = root.getElementById('grid-config-port');
  const shape = root.getElementById('grid-shape');
  const rotation = root.getElementById('grid-rotation');
  const apply = root.getElementById('grid-apply');
  const notice = root.getElementById('surface-notice');
  if (!grid || !displayPort || !configPort || !shape || !rotation || !apply || !notice) return null;

  let ports = {};
  let frame = null;
  let pending = null;
  const ledger = new PressLedger((target, z) => send(session, 'grid', 'key', {...target, z}));
  const gestures = installGridGestures(root, grid, ledger, () => frame);

  const chooseFrame = state => {
    ports = state?.data?.grid?.ports || {};
    const selected = selectGridPort(ports, Number(displayPort.value) || null);
    const raw = selected == null ? null : ports[String(selected)];
    frame = raw ? decodeGridFrame(raw) : null;
    if (frame?.virtual) {
      const config = gridConfigurationFromFrame(frame);
      if (config) {
        configPort.value = String(config.port);
        shape.value = `${config.cols}x${config.rows}`;
        rotation.value = String(config.rotation);
      }
    }
  };

  displayPort.addEventListener('change', () => {
    gestures.releaseAll();
    chooseFrame(session.state);
  });

  apply.addEventListener('click', () => {
    try {
      const config = normalizeGridConfiguration({
        port: Number(configPort.value),
        shape: shape.value,
        rotation: Number(rotation.value),
      });
      pending = send(session, 'grid', 'configure', config);
      notice.textContent = 'Applying persistent virtual Grid configuration…';
    } catch (error) {
      notice.textContent = error.message;
    }
  });

  session.addEventListener('state', event => {
    if (event.detail.status !== 'synced') gestures.releaseAll();
    chooseFrame(event.detail);
  });
  session.addEventListener('command', event => {
    if (event.detail.id !== pending) return;
    if (event.detail.status === 'ack') {
      notice.textContent = 'Virtual Grid saved. Reload the script after changing port or dimensions.';
    } else {
      notice.textContent = event.detail.error || `Grid configuration ${event.detail.status}`;
    }
    pending = null;
  });
  globalThis.addEventListener?.('pagehide', () => gestures.releaseAll());
  root.addEventListener?.('visibilitychange', () => {
    if (root.visibilityState === 'hidden') gestures.releaseAll();
  });
  chooseFrame(session.state);
  return gestures;
}
