const ACTIVE_SELECTOR = '[data-key], [data-encoder]';

function disabled(element) {
  return Boolean(element?.disabled || element?.dataset?.disabled === 'true');
}

function boundedSend(session, n, delta) {
  let remaining = delta;
  while (remaining !== 0) {
    const part = Math.max(-127, Math.min(127, remaining));
    session.command({target: 'control', action: 'enc', args: {n, d: part}});
    remaining -= part;
  }
}

export function encoderKeyDelta(event) {
  const key = String(event?.key || '');
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return 0;
  const direction = key === 'ArrowRight' || key === 'ArrowUp' ? 1 : -1;
  return direction * (event.shiftKey ? 8 : 1);
}

function syntheticPointerCancel(globalLike, pointerId) {
  try { return new globalLike.PointerEvent('pointercancel', {bubbles: true, pointerId}); }
  catch {
    const event = new Event('pointercancel', {bubbles: true});
    Object.defineProperty(event, 'pointerId', {value: pointerId});
    return event;
  }
}

function syntheticKeyUp(globalLike, key) {
  try { return new globalLike.KeyboardEvent('keyup', {bubbles: true, key}); }
  catch {
    const event = new Event('keyup', {bubbles: true});
    Object.defineProperty(event, 'key', {value: key});
    return event;
  }
}

export function mountKEHardening(session, root = document, globalLike = globalThis) {
  if (!session || typeof session.command !== 'function') throw new TypeError('realtime session is required');
  const host = root.body || root;
  if (host.dataset?.ingenueKeHardening === 'true') return host._ingenueKeHardening;
  if (host.dataset) host.dataset.ingenueKeHardening = 'true';

  const pointers = new Map();
  const keys = new Map();

  const closestControl = target => target?.closest?.(ACTIVE_SELECTOR) || null;
  const onPointerDown = event => {
    if (event.button > 0 || !Number.isInteger(event.pointerId)) return;
    const control = closestControl(event.target);
    if (!control || disabled(control)) return;
    pointers.set(event.pointerId, control);
  };
  const onPointerEnd = event => {
    if (Number.isInteger(event.pointerId)) pointers.delete(event.pointerId);
  };
  const onKeyDown = event => {
    const control = closestControl(event.target);
    if (!control || disabled(control)) return;
    if (control.matches('[data-key]') && (event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      keys.set(`${control.dataset.key}:${event.key}`, {control, key: event.key});
    }
  };
  const onKeyUp = event => {
    const control = closestControl(event.target);
    if (control?.matches?.('[data-key]')) keys.delete(`${control.dataset.key}:${event.key}`);
  };

  const releaseAll = () => {
    for (const [pointerId, control] of [...pointers]) {
      pointers.delete(pointerId);
      control.dispatchEvent(syntheticPointerCancel(globalLike, pointerId));
      control.dataset.pressed = 'false';
    }
    for (const [id, active] of [...keys]) {
      keys.delete(id);
      active.control.dispatchEvent(syntheticKeyUp(globalLike, active.key));
      active.control.dataset.pressed = 'false';
    }
    root.querySelectorAll?.(`${ACTIVE_SELECTOR}[data-pressed="true"]`).forEach(control => {
      control.dataset.pressed = 'false';
    });
  };

  host.addEventListener('pointerdown', onPointerDown, true);
  host.addEventListener('pointerup', onPointerEnd, true);
  host.addEventListener('pointercancel', onPointerEnd, true);
  host.addEventListener('lostpointercapture', onPointerEnd, true);
  host.addEventListener('keydown', onKeyDown, true);
  host.addEventListener('keyup', onKeyUp, true);

  root.querySelectorAll('[data-encoder]').forEach(control => {
    if (!control.hasAttribute('tabindex')) control.tabIndex = 0;
    control.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown');
    control.addEventListener('keydown', event => {
      if (event.target !== control || disabled(control) || event.repeat) return;
      const delta = encoderKeyDelta(event);
      if (!delta) return;
      event.preventDefault();
      boundedSend(session, Number(control.dataset.encoder), delta);
    });
  });

  const onBlur = () => releaseAll();
  const onPageHide = () => releaseAll();
  const onVisibility = () => { if (root.visibilityState === 'hidden') releaseAll(); };
  const onState = event => { if (event.detail?.status !== 'synced') releaseAll(); };
  globalLike.addEventListener?.('blur', onBlur);
  globalLike.addEventListener?.('pagehide', onPageHide);
  root.addEventListener?.('visibilitychange', onVisibility);
  session.addEventListener?.('state', onState);

  const api = {
    releaseAll,
    get activePointers() { return pointers.size; },
    get activeKeys() { return keys.size; },
    destroy() {
      releaseAll();
      host.removeEventListener('pointerdown', onPointerDown, true);
      host.removeEventListener('pointerup', onPointerEnd, true);
      host.removeEventListener('pointercancel', onPointerEnd, true);
      host.removeEventListener('lostpointercapture', onPointerEnd, true);
      host.removeEventListener('keydown', onKeyDown, true);
      host.removeEventListener('keyup', onKeyUp, true);
      globalLike.removeEventListener?.('blur', onBlur);
      globalLike.removeEventListener?.('pagehide', onPageHide);
      root.removeEventListener?.('visibilitychange', onVisibility);
      session.removeEventListener?.('state', onState);
      if (host.dataset) delete host.dataset.ingenueKeHardening;
      delete host._ingenueKeHardening;
    },
  };
  host._ingenueKeHardening = api;
  return api;
}
