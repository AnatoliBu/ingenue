export class MlrSurfaceError extends Error {}

export const MLR_VIEWS = Object.freeze({1: 'rec', 2: 'cut', 3: 'clip', 15: 'time'});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MlrSurfaceError(`${label} must be an object`);
  return value;
}

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new MlrSurfaceError(`${label} is invalid`);
  return parsed;
}

function finite(value, label, minimum = -Infinity, maximum = Infinity) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new MlrSurfaceError(`${label} is invalid`);
  return parsed;
}

function flag(value) { return Boolean(value); }
function text(value, maximum = 256) {
  const parsed = String(value ?? '');
  if (parsed.length > maximum) throw new MlrSurfaceError('MLR text is too long');
  return parsed;
}

function normalizeMap(raw, count, normalize) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  for (let index = 1; index <= count; index += 1) {
    const candidate = source[String(index)] ?? source[index];
    result[String(index)] = normalize(candidate || {}, index);
  }
  return result;
}

export function normalizeMlrState(raw) {
  const state = object(raw, 'MLR state');
  const view = integer(state.view ?? 1, 'MLR view', 1, 15);
  if (!MLR_VIEWS[view]) throw new MlrSurfaceError('MLR view is unsupported');
  const tracks = normalizeMap(state.tracks, 6, (item, index) => ({
    index,
    play: flag(item.play),
    rec: flag(item.rec),
    loop: flag(item.loop),
    loop_start: integer(item.loop_start ?? 0, 'MLR loop start', 0, 16),
    loop_end: integer(item.loop_end ?? 16, 'MLR loop end', 0, 16),
    clip: integer(item.clip ?? index, 'MLR track clip', 1, 16),
    pos_grid: integer(item.pos_grid ?? -1, 'MLR playhead', -1, 16),
    speed: integer(item.speed ?? 0, 'MLR speed', -16, 16),
    reverse: flag(item.reverse),
    tempo_map: flag(item.tempo_map),
    volume: finite(item.volume ?? 1, 'MLR volume', -16, 16),
    record_level: finite(item.record_level ?? 1, 'MLR record level', -16, 16),
    pre_level: finite(item.pre_level ?? 0, 'MLR pre level', -16, 16),
    clip_name: text(item.clip_name ?? '-'),
    clip_length: finite(item.clip_length ?? 0, 'MLR clip length', 0, 3600),
    clip_bpm: finite(item.clip_bpm ?? 0, 'MLR clip BPM', 0, 10000),
  }));
  for (const item of Object.values(tracks)) {
    if (item.loop && item.loop_start > item.loop_end) throw new MlrSurfaceError('MLR loop range is invalid');
  }
  return {
    active: flag(state.active),
    version: text(state.version ?? '2.2.5', 32),
    view,
    view_name: MLR_VIEWS[view],
    focus: integer(state.focus ?? 1, 'MLR focus', 1, 6),
    alt: flag(state.alt),
    quantize: flag(state.quantize),
    tracks,
    clips: normalizeMap(state.clips, 7, (item, index) => ({
      index,
      name: text(item.name ?? '-'),
      length: finite(item.length ?? 0, 'MLR clip length', 0, 3600),
      bpm: finite(item.bpm ?? 0, 'MLR clip BPM', 0, 10000),
    })),
    patterns: normalizeMap(state.patterns, 4, (item, index) => ({
      index,
      recording: flag(item.recording),
      playing: flag(item.playing),
      count: integer(item.count ?? 0, 'MLR pattern count', 0, 1000000),
    })),
    recalls: normalizeMap(state.recalls, 4, (item, index) => ({
      index,
      recording: flag(item.recording),
      has_data: flag(item.has_data),
      active: flag(item.active),
      event_count: integer(item.event_count ?? 0, 'MLR recall count', 0, 1000000),
    })),
  };
}

export function decodeMlrGridFrame(raw) {
  const frame = object(raw, 'MLR Grid frame');
  const cols = integer(frame.cols, 'MLR Grid columns', 1, 32);
  const rows = integer(frame.rows, 'MLR Grid rows', 1, 32);
  if (cols !== 16 || rows !== 8) throw new MlrSurfaceError('MLR requires a 16×8 Grid');
  const payload = String(frame.frame ?? '').toLowerCase();
  if (payload.length !== 128 || !/^[0-9a-f]+$/.test(payload)) throw new MlrSurfaceError('MLR Grid frame payload is invalid');
  return {
    port: integer(frame.port ?? 1, 'MLR Grid port', 1, 4),
    cols,
    rows,
    values: Array.from(payload, digit => Number.parseInt(digit, 16)),
    intensity: integer(frame.intensity ?? 15, 'MLR Grid intensity', 0, 15),
    sequence: integer(frame.sequence ?? 0, 'MLR Grid sequence', 0, 2147483647),
    virtual: Boolean(frame.virtual),
  };
}

function mlrGridEntries(ports) {
  return Object.entries(ports || {})
    .map(([key, value]) => [Number(key), value])
    .filter(([port, value]) => Number.isSafeInteger(port) && port >= 1 && port <= 4 && value?.cols === 16 && value?.rows === 8)
    .sort(([left], [right]) => left - right);
}

export function selectMlrGridPort(ports, preferred = null) {
  const entries = mlrGridEntries(ports);
  const requested = Number(preferred);
  if (Number.isSafeInteger(requested) && entries.some(([port]) => port === requested)) return requested;
  return entries.find(([, value]) => value.virtual)?.[0] ?? entries[0]?.[0] ?? null;
}

export function selectMlrVirtualGridPort(ports, preferred = null) {
  const entries = mlrGridEntries(ports).filter(([, value]) => Boolean(value?.virtual));
  const requested = Number(preferred);
  if (Number.isSafeInteger(requested) && entries.some(([port]) => port === requested)) return requested;
  return entries[0]?.[0] ?? null;
}

export function gridIndex(x, y) {
  return (integer(y, 'Grid y', 1, 8) - 1) * 16 + integer(x, 'Grid x', 1, 16) - 1;
}

export function viewHelp(view) {
  const name = typeof view === 'string' ? view : MLR_VIEWS[Number(view)];
  if (name === 'rec') return 'record · focus / tempo map · reverse · speed · start/stop';
  if (name === 'cut') return 'tap to cut · hold two positions for a loop · ALT toggles play';
  if (name === 'clip') return 'assign clip slots · E2 chooses action · K2 executes · E3 resizes';
  if (name === 'time') return 'E2 tempo · E3 quantization division';
  return 'waiting for MLR view';
}

export function loopChordCommands(port, row, firstColumn, secondColumn) {
  const first = integer(firstColumn, 'first loop column', 1, 16);
  const second = integer(secondColumn, 'second loop column', 1, 16);
  const y = integer(row, 'loop row', 2, 7);
  const p = integer(port, 'Grid port', 1, 4);
  return [
    {target: 'grid', action: 'key', args: {port: p, x: first, y, z: 1}},
    {target: 'grid', action: 'key', args: {port: p, x: second, y, z: 1}},
    {target: 'grid', action: 'key', args: {port: p, x: second, y, z: 0}},
    {target: 'grid', action: 'key', args: {port: p, x: first, y, z: 0}},
  ];
}
