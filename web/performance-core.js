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

function decodeHexFrame(frame, expected, label) {
  const payload = String(frame ?? '').toLowerCase();
  if (payload.length !== expected || !/^[0-9a-f]+$/.test(payload)) {
    throw new SurfaceError(`${label} payload does not match its dimensions`);
  }
  return Array.from(payload, digit => Number.parseInt(digit, 16));
}

export function decodeGridFrame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SurfaceError('grid frame must be an object');
  }
  const cols = positiveInteger(raw.cols, 'grid cols');
  const rows = positiveInteger(raw.rows, 'grid rows');
  const intensity = Number.isSafeInteger(raw.intensity) ? clamp(raw.intensity, 0, 15) : 15;
  return {
    port: positiveInteger(Number(raw.port ?? 1), 'grid port', 4),
    cols,
    rows,
    values: decodeHexFrame(raw.frame, cols * rows, 'grid frame'),
    sequence: Number.isSafeInteger(raw.sequence) && raw.sequence >= 0 ? raw.sequence : 0,
    intensity,
    virtual: Boolean(raw.virtual),
  };
}

export function decodeArcFrame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SurfaceError('arc frame must be an object');
  }
  const rings = positiveInteger(raw.rings, 'arc rings', 4);
  if (![2, 4].includes(rings)) throw new SurfaceError('arc rings must be 2 or 4');
  const intensity = Number.isSafeInteger(raw.intensity) ? clamp(raw.intensity, 0, 15) : 15;
  return {
    port: positiveInteger(Number(raw.port ?? 1), 'arc port', 4),
    rings,
    values: decodeHexFrame(raw.frame, rings * 64, 'arc frame'),
    sequence: Number.isSafeInteger(raw.sequence) && raw.sequence >= 0 ? raw.sequence : 0,
    intensity,
    virtual: Boolean(raw.virtual),
  };
}

function selectPort(ports, preferredPort = null) {
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

export function selectGridPort(ports, preferredPort = null) {
  return selectPort(ports, preferredPort);
}

export function selectArcPort(ports, preferredPort = null) {
  return selectPort(ports, preferredPort);
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

export function arcAngularSteps(previousAngle, currentAngle, stepsPerTurn = 1024) {
  if (!Number.isFinite(previousAngle) || !Number.isFinite(currentAngle) ||
      !Number.isFinite(stepsPerTurn) || stepsPerTurn <= 0) {
    throw new SurfaceError('invalid Arc gesture');
  }
  const tau = Math.PI * 2;
  let delta = currentAngle - previousAngle;
  while (delta > Math.PI) delta -= tau;
  while (delta < -Math.PI) delta += tau;
  return delta / tau * stepsPerTurn;
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
    if (status === 'reject') return null;
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
