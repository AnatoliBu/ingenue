export class GamepadSurfaceError extends Error {}

export const GAMEPAD_BUTTONS = Object.freeze([
  'A', 'B', 'X', 'Y', 'L1', 'R1', 'L2', 'R2', 'L3', 'R3', 'SELECT', 'START',
]);
export const GAMEPAD_ANALOG_AXES = Object.freeze([
  'leftx', 'lefty', 'rightx', 'righty', 'triggerleft', 'triggerright',
]);

function finite(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new GamepadSurfaceError(`${label} must be finite`);
  return numeric;
}

export function clampUnit(value) {
  return Math.min(1, Math.max(-1, finite(value, 'axis value')));
}

export function normalizeStickVector(x, y, deadzone = 0.12) {
  const rawX = finite(x, 'stick x');
  const rawY = finite(y, 'stick y');
  const zone = finite(deadzone, 'deadzone');
  if (zone < 0 || zone >= 1) throw new GamepadSurfaceError('deadzone must be between 0 and 1');
  const magnitude = Math.hypot(rawX, rawY);
  if (magnitude <= zone) return {x: 0, y: 0, magnitude: 0};
  const limited = Math.min(1, magnitude);
  const scaled = (limited - zone) / (1 - zone);
  const factor = scaled / magnitude;
  return {
    x: Number((rawX * factor).toFixed(4)),
    y: Number((rawY * factor).toFixed(4)),
    magnitude: Number(scaled.toFixed(4)),
  };
}

export function pointerStickVector(rect, clientX, clientY, deadzone = 0.12) {
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
    throw new GamepadSurfaceError('stick bounds are invalid');
  }
  const radius = Math.min(rect.width, rect.height) / 2;
  const x = (finite(clientX, 'pointer x') - (rect.left + rect.width / 2)) / radius;
  const y = (finite(clientY, 'pointer y') - (rect.top + rect.height / 2)) / radius;
  return normalizeStickVector(x, y, deadzone);
}

export function axisSign(value, threshold = 2 / 3) {
  const normalized = clampUnit(value);
  const edge = finite(threshold, 'axis threshold');
  if (edge <= 0 || edge > 1) throw new GamepadSurfaceError('axis threshold must be between 0 and 1');
  if (normalized >= edge) return 1;
  if (normalized <= -edge) return -1;
  return 0;
}

export function normalizeTrigger(value) {
  return Number(Math.min(1, Math.max(0, finite(value, 'trigger value'))).toFixed(4));
}

function sameDirection(left, right) {
  return Boolean(left && right && left.axis === right.axis && left.sign === right.sign);
}

export class DirectionLedger {
  constructor(send) {
    if (typeof send !== 'function') throw new GamepadSurfaceError('direction sender is required');
    this.send = send;
    this.pointers = new Map();
    this.axes = new Map();
  }

  press(pointerId, target) {
    if (!target || !['X', 'Y'].includes(target.axis) || ![-1, 1].includes(target.sign)) {
      throw new GamepadSurfaceError('invalid d-pad target');
    }
    const current = this.pointers.get(pointerId);
    if (sameDirection(current, target)) return false;
    if (current) this.release(pointerId);
    const displaced = this.axes.get(target.axis);
    if (displaced != null && displaced !== pointerId) this.release(displaced);
    const normalized = {axis: target.axis, sign: target.sign};
    this.pointers.set(pointerId, normalized);
    this.axes.set(normalized.axis, pointerId);
    this.send(normalized.axis, normalized.sign);
    return true;
  }

  release(pointerId) {
    const current = this.pointers.get(pointerId);
    if (!current) return false;
    this.pointers.delete(pointerId);
    if (this.axes.get(current.axis) === pointerId) {
      this.axes.delete(current.axis);
      this.send(current.axis, 0);
    }
    return true;
  }

  releaseAll() {
    for (const pointerId of [...this.pointers.keys()]) this.release(pointerId);
  }
}
