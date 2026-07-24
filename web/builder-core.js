export const BUILDER_SCHEMA_VERSION = 1;
export const BUILDER_WIDGET_LIMIT = 64;
export const BUILDER_STORAGE_PREFIX = 'ingenue.builder.v1:';

const WIDGET_TYPES = new Set(['key', 'encoder', 'param', 'label', 'spacer']);
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const PARAM_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export class BuilderError extends Error {}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BuilderError(`${label} must be an object`);
  return value;
}

function text(value, label, max, {empty = false} = {}) {
  const result = String(value ?? '').trim();
  if ((!empty && !result) || result.length > max) throw new BuilderError(`${label} is invalid`);
  return result;
}

function integer(value, label, low, high) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < low || result > high) {
    throw new BuilderError(`${label} must be an integer between ${low} and ${high}`);
  }
  return result;
}

function finite(value, label, low, high) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < low || result > high) {
    throw new BuilderError(`${label} must be between ${low} and ${high}`);
  }
  return result;
}

function safeId(value, label = 'widget id') {
  const result = String(value ?? '');
  if (!SAFE_ID.test(result)) throw new BuilderError(`${label} is invalid`);
  return result;
}

export function builderStorageKey(script) {
  return `${BUILDER_STORAGE_PREFIX}${encodeURIComponent(text(script, 'script name', 256))}`;
}

export function defaultBuilderSchema(script) {
  const name = text(script, 'script name', 256);
  return {version: BUILDER_SCHEMA_VERSION, script: name, name: `${name} controls`, columns: 2, widgets: []};
}

export function createBuilderWidget(type, id) {
  const normalizedType = String(type ?? '');
  if (!WIDGET_TYPES.has(normalizedType)) throw new BuilderError('widget type is unsupported');
  const base = {id: safeId(id), type: normalizedType, span: 1};
  if (normalizedType === 'key') return {...base, label: 'K1', n: 1};
  if (normalizedType === 'encoder') return {...base, label: 'E1', n: 1, step: 1};
  if (normalizedType === 'param') return {...base, label: 'Parameter', paramId: 'cutoff', step: 0.01};
  if (normalizedType === 'label') return {...base, label: 'Section', span: 2};
  return base;
}

export function normalizeBuilderWidget(raw) {
  const source = object(raw, 'widget');
  const id = safeId(source.id);
  const type = String(source.type ?? '');
  if (!WIDGET_TYPES.has(type)) throw new BuilderError('widget type is unsupported');
  const span = integer(source.span ?? 1, 'widget span', 1, 4);
  if (type === 'key') return {
    id, type, span,
    label: text(source.label ?? `K${source.n ?? 1}`, 'key label', 80),
    n: integer(source.n, 'key number', 1, 3),
  };
  if (type === 'encoder') return {
    id, type, span,
    label: text(source.label ?? `E${source.n ?? 1}`, 'encoder label', 80),
    n: integer(source.n, 'encoder number', 1, 3),
    step: integer(source.step ?? 1, 'encoder step', 1, 64),
  };
  if (type === 'param') {
    const paramId = String(source.paramId ?? source.param_id ?? '');
    if (!PARAM_ID.test(paramId)) throw new BuilderError('parameter id is invalid');
    return {
      id, type, span,
      label: text(source.label ?? paramId, 'parameter label', 80),
      paramId,
      step: finite(source.step ?? 0.01, 'parameter step', 0.0001, 1),
    };
  }
  if (type === 'label') return {
    id, type, span,
    label: text(source.label, 'label text', 500),
  };
  return {id, type, span};
}

export function normalizeBuilderSchema(raw, expectedScript = null) {
  const source = object(raw, 'builder schema');
  const version = integer(source.version, 'schema version', BUILDER_SCHEMA_VERSION, BUILDER_SCHEMA_VERSION);
  const script = text(source.script, 'script name', 256);
  if (expectedScript != null && script !== String(expectedScript)) {
    throw new BuilderError(`schema belongs to ${script}, not ${expectedScript}`);
  }
  const name = text(source.name, 'surface name', 120);
  const columns = integer(source.columns, 'column count', 1, 4);
  if (!Array.isArray(source.widgets) || source.widgets.length > BUILDER_WIDGET_LIMIT) {
    throw new BuilderError(`widgets must be an array with at most ${BUILDER_WIDGET_LIMIT} items`);
  }
  const widgets = source.widgets.map(normalizeBuilderWidget);
  const ids = new Set();
  for (const widget of widgets) {
    if (ids.has(widget.id)) throw new BuilderError(`duplicate widget id: ${widget.id}`);
    ids.add(widget.id);
    if (widget.span > columns) widget.span = columns;
  }
  return {version, script, name, columns, widgets};
}

function normalizedCopy(schema) {
  return normalizeBuilderSchema(structuredClone(schema), schema.script);
}

export function appendBuilderWidget(schema, widget) {
  const next = normalizedCopy(schema);
  if (next.widgets.length >= BUILDER_WIDGET_LIMIT) throw new BuilderError('widget limit reached');
  const normalized = normalizeBuilderWidget(widget);
  if (next.widgets.some(item => item.id === normalized.id)) throw new BuilderError('widget id already exists');
  normalized.span = Math.min(normalized.span, next.columns);
  next.widgets.push(normalized);
  return next;
}

export function updateBuilderWidget(schema, widgetId, patch) {
  const next = normalizedCopy(schema);
  const index = next.widgets.findIndex(item => item.id === widgetId);
  if (index < 0) throw new BuilderError('widget was not found');
  next.widgets[index] = normalizeBuilderWidget({...next.widgets[index], ...object(patch, 'widget patch'), id: widgetId});
  next.widgets[index].span = Math.min(next.widgets[index].span, next.columns);
  return next;
}

export function removeBuilderWidget(schema, widgetId) {
  const next = normalizedCopy(schema);
  const before = next.widgets.length;
  next.widgets = next.widgets.filter(item => item.id !== widgetId);
  if (next.widgets.length === before) throw new BuilderError('widget was not found');
  return next;
}

export function moveBuilderWidget(schema, widgetId, direction) {
  const next = normalizedCopy(schema);
  const index = next.widgets.findIndex(item => item.id === widgetId);
  if (index < 0) throw new BuilderError('widget was not found');
  const offset = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
  if (!offset) throw new BuilderError('move direction must be up or down');
  const target = index + offset;
  if (target < 0 || target >= next.widgets.length) return next;
  [next.widgets[index], next.widgets[target]] = [next.widgets[target], next.widgets[index]];
  return next;
}

export function updateBuilderLayout(schema, patch) {
  const next = normalizedCopy(schema);
  const source = object(patch, 'layout patch');
  if (Object.hasOwn(source, 'name')) next.name = text(source.name, 'surface name', 120);
  if (Object.hasOwn(source, 'columns')) next.columns = integer(source.columns, 'column count', 1, 4);
  next.widgets = next.widgets.map(widget => ({...widget, span: Math.min(widget.span, next.columns)}));
  return normalizeBuilderSchema(next, next.script);
}

export function serializeBuilderSchema(schema) {
  return JSON.stringify(normalizeBuilderSchema(schema, schema.script), null, 2);
}

export function parseBuilderSchema(serialized, expectedScript) {
  let parsed;
  try { parsed = JSON.parse(String(serialized)); }
  catch (error) { throw new BuilderError(`schema JSON is invalid: ${error.message}`); }
  return normalizeBuilderSchema(parsed, expectedScript);
}

export function writableParameterOptions(rawCatalog) {
  const items = Array.isArray(rawCatalog?.items) ? rawCatalog.items : [];
  return items.filter(item => item && item.writable && typeof item.id === 'string' && PARAM_ID.test(item.id))
    .map(item => ({id: item.id, name: String(item.name || item.id), normalized: Number(item.normalized)}));
}

export class BuilderStore {
  constructor(storage) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new BuilderError('browser storage is unavailable');
    }
    this.storage = storage;
  }

  load(script) {
    const fallback = defaultBuilderSchema(script);
    const serialized = this.storage.getItem(builderStorageKey(script));
    if (serialized == null) return fallback;
    return parseBuilderSchema(serialized, script);
  }

  save(schema) {
    const normalized = normalizeBuilderSchema(schema, schema.script);
    this.storage.setItem(builderStorageKey(normalized.script), JSON.stringify(normalized));
    return normalized;
  }

  remove(script) {
    this.storage.removeItem?.(builderStorageKey(script));
    return defaultBuilderSchema(script);
  }
}
