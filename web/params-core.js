export class ParamsSurfaceError extends Error {}

const KINDS = new Set(['separator', 'group', 'number', 'option', 'control', 'taper', 'trigger', 'binary']);

function text(value, label, max = 512) {
  const result = String(value ?? '');
  if (!result || result.length > max) throw new ParamsSurfaceError(`${label} is invalid`);
  return result;
}

export function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ParamsSurfaceError('parameter catalog must be an object');
  const generation = text(raw.generation, 'catalog generation', 64);
  const script = text(raw.script, 'script name', 256);
  if (!Array.isArray(raw.items) || raw.items.length > 512) throw new ParamsSurfaceError('parameter catalog items are invalid');
  const items = raw.items.map((item, offset) => normalizeItem(item, offset + 1));
  return {generation, script, items};
}

export function normalizeItem(raw, expectedIndex = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ParamsSurfaceError('parameter item must be an object');
  const index = Number(raw.index);
  if (!Number.isSafeInteger(index) || index < 1 || index > 512 || (expectedIndex != null && index !== expectedIndex)) {
    throw new ParamsSurfaceError('parameter index is invalid');
  }
  const kind = text(raw.kind, 'parameter kind', 32);
  if (!KINDS.has(kind)) throw new ParamsSurfaceError('parameter kind is unsupported');
  const normalized = Number(raw.normalized);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) throw new ParamsSurfaceError('parameter value is invalid');
  const options = Array.isArray(raw.options) ? raw.options.map(value => text(value, 'option label')) : [];
  if (kind === 'option' && options.length !== Number(raw.option_count)) throw new ParamsSurfaceError('option catalog is incomplete');
  return {
    index,
    id: text(raw.id, 'parameter id', 128),
    type: Number(raw.type),
    name: text(raw.name, 'parameter name'),
    kind,
    normalized,
    valueText: String(raw.value_text ?? ''),
    minText: String(raw.min_text ?? ''),
    maxText: String(raw.max_text ?? ''),
    formatted: String(raw.formatted ?? ''),
    behavior: String(raw.behavior ?? ''),
    writable: Boolean(raw.writable),
    options,
  };
}

export function normalizedForOption(index, count) {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || index < 1 || index > count) {
    throw new ParamsSurfaceError('option selection is invalid');
  }
  return count === 1 ? 0 : (index - 1) / (count - 1);
}

export function optionIndexForNormalized(value, count) {
  if (!Number.isFinite(value) || value < 0 || value > 1 || !Number.isSafeInteger(count) || count < 1) {
    throw new ParamsSurfaceError('normalized option value is invalid');
  }
  return count === 1 ? 1 : 1 + Math.round(value * (count - 1));
}

export function controlModel(item) {
  const normalized = normalizeItem(item);
  if (normalized.kind === 'separator' || normalized.kind === 'group') return {surface: 'heading'};
  if (normalized.kind === 'trigger') return {surface: 'trigger'};
  if (normalized.kind === 'binary') return {surface: 'toggle', checked: normalized.normalized >= 0.5};
  if (normalized.kind === 'option') return {
    surface: 'option',
    selected: optionIndexForNormalized(normalized.normalized, normalized.options.length),
    options: normalized.options,
  };
  return {surface: 'range', value: normalized.normalized};
}
