export class SurfaceError extends Error {}

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function positiveInteger(value, label, max = 32) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new SurfaceError(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

export function decodeGridFrame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SurfaceError('grid frame must be an object');
  }
  const cols = positiveInteger(raw.cols, 'grid cols');
  const rows = positiveInteger(raw.rows, 'grid rows');
  const frame = String(raw.frame ?? '').toLowerCase();
  if (frame.length !== cols * rows || !/^[0-9a-f]+$/.test(frame)) {
    throw new SurfaceError('grid frame payload does not match its dimensions');
  }
  const intensity = Number.isSafeInteger(raw.intensity) ? clamp(raw.intensity, 0, 15) : 15;
  return {
    port: positiveInteger(Number(raw.port ?? 1), 'grid port', 4),
    cols,
    rows,
    values: Array.from(frame, digit => Number.parseInt(digit, 16)),
    sequence: Number.isSafeInteger(raw.sequence) && raw.sequence >= 0 ? raw.sequence : 0,
    intensity,
    virtual: Boolean(raw.virtual),
  };
}

export function selectGridPort(ports, preferredPort = null) {
  if (!ports || typeof ports !== 'object') return null;
  const entries = Object.entries(ports)
    .map(([key, value]) => [Number(key), value])
    .filter(([port, value]) => Number.isSafeInteger(port) && port >= 1 && port <= 4 && value)
    .sort(([left], [right]) => left - right);
  const preferred = Number(preferredPort);
  if (Number.isSafeInteger(preferred) && entries.some(([port]) => port === preferred)) return preferred;
  const physical = entries.find(([, value]) => !value.virtual);
  return physical?.[0] ?? entries[0]?.[0] ?? null;
}

export function effectiveBrightness(level, intensity = 15) {
  const led = clamp(Number(level) || 0, 0, 15) / 15;
  const global = clamp(Number(intensity) || 0, 0, 15) / 15;
  return Number((led * global).toFixed(4));
}

export function encoderSteps(startY, currentY, pixelsPerStep = 14) {
  if (!Number.isFinite(startY) || !Number.isFinite(currentY) || !Number.isFinite(pixelsPerStep) || pixelsPerStep <= 0) {
    throw new SurfaceError('invalid encoder gesture');
  }
  return Math.trunc((startY - currentY) / pixelsPerStep);
}

export class PressLedger {
  constructor(send) {
    if (typeof send !== 'function') throw new SurfaceError('press sender is required');
    this.send = send;
    this.pointers = new Map();
  }

  press(pointerId, target) {
    if (this.pointers.has(pointerId)) this.release(pointerId);
    const normalized = structuredClone(target);
    this.pointers.set(pointerId, normalized);
    this.send(normalized, 1);
  }

  release(pointerId) {
    const target = this.pointers.get(pointerId);
    if (!target) return false;
    this.pointers.delete(pointerId);
    this.send(target, 0);
    return true;
  }

  releaseAll() {
    for (const pointerId of [...this.pointers.keys()]) this.release(pointerId);
  }
}

export class AppliedValueLane {
  constructor(send) {
    if (typeof send !== 'function') throw new SurfaceError('value sender is required');
    this.send = send;
    this.inflight = null;
    this.queued = null;
    this.lastApplied = null;
  }

  push(value) {
    if (!Number.isFinite(value)) throw new SurfaceError('parameter value must be finite');
    if (this.inflight) {
      this.queued = value;
      return null;
    }
    return this.#dispatch(value);
  }

  settle(commandId, status) {
    if (!this.inflight || this.inflight.id !== commandId) return null;
    const completed = this.inflight;
    this.inflight = null;
    if (status === 'ack') this.lastApplied = completed.value;
    const desired = this.queued;
    this.queued = null;
    if (status === 'uncertain') return this.#dispatch(desired ?? completed.value);
    if (desired == null || Object.is(desired, this.lastApplied)) return null;
    return this.#dispatch(desired);
  }

  #dispatch(value) {
    const id = this.send(value);
    if (typeof id !== 'string' || !id) throw new SurfaceError('value sender must return a command id');
    this.inflight = {id, value};
    return id;
  }
}
