import {RUNTIME_ERROR_CODES} from './realtime-protocol.js';

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export class RuntimeContractError extends Error {
  constructor(message, {code = 'runtime-error', retryable = false, context = null} = {}) {
    super(String(message));
    this.name = 'RuntimeContractError';
    this.code = RUNTIME_ERROR_CODES.has(code) ? code : 'runtime-error';
    this.retryable = Boolean(retryable);
    this.context = cloneValue(context);
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneValue(value) {
  if (value == null) return value;
  try { return structuredClone(value); } catch {}
  if (value instanceof Error) return {name: value.name, message: value.message, code: value.code || null};
  if (plainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 64)) out[key] = cloneValue(item);
    return out;
  }
  if (Array.isArray(value)) return value.slice(0, 64).map(cloneValue);
  return String(value);
}

export function commandName(command) {
  return `${command?.target || 'unknown'}.${command?.action || 'unknown'}`;
}

export function validateCommandShape(command) {
  if (!plainObject(command)) throw new RuntimeContractError('command must be an object', {code: 'validation'});
  if (!SAFE_NAME.test(String(command.target || ''))) throw new RuntimeContractError('command target is invalid', {code: 'validation'});
  if (!SAFE_NAME.test(String(command.action || ''))) throw new RuntimeContractError('command action is invalid', {code: 'validation'});
  if (!plainObject(command.args)) throw new RuntimeContractError('command args must be an object', {code: 'validation'});
  if (Object.keys(command.args).length > 32) throw new RuntimeContractError('command args contain too many fields', {code: 'validation'});
  return command;
}

function validateField(name, value, specification) {
  const type = specification?.type;
  if (type === 'integer' && (!Number.isSafeInteger(value))) {
    throw new RuntimeContractError(`${name} must be an integer`, {code: 'validation'});
  }
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new RuntimeContractError(`${name} must be finite`, {code: 'validation'});
  }
  if (type === 'string' && typeof value !== 'string') {
    throw new RuntimeContractError(`${name} must be a string`, {code: 'validation'});
  }
  if (Array.isArray(specification?.enum) && !specification.enum.includes(value)) {
    throw new RuntimeContractError(`${name} is unsupported`, {code: 'validation'});
  }
  if (typeof value === 'number') {
    if (Number.isFinite(specification?.minimum) && value < specification.minimum) {
      throw new RuntimeContractError(`${name} must be at least ${specification.minimum}`, {code: 'validation'});
    }
    if (Number.isFinite(specification?.maximum) && value > specification.maximum) {
      throw new RuntimeContractError(`${name} must be at most ${specification.maximum}`, {code: 'validation'});
    }
  }
  if (typeof value === 'string' && specification?.pattern) {
    let expression;
    try { expression = new RegExp(specification.pattern); }
    catch { throw new RuntimeContractError(`server schema for ${name} is invalid`, {code: 'unavailable'}); }
    if (!expression.test(value)) throw new RuntimeContractError(`${name} has an invalid format`, {code: 'validation'});
  }
}

function validateArgs(args, schema) {
  if (!schema) return;
  if (!plainObject(schema) || schema.type !== 'object') {
    throw new RuntimeContractError('server command schema is invalid', {code: 'unavailable'});
  }
  const properties = plainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) {
    if (!Object.hasOwn(args, name)) throw new RuntimeContractError(`${name} is required`, {code: 'validation'});
  }
  if (schema.additional === false) {
    const unknown = Object.keys(args).find(name => !Object.hasOwn(properties, name));
    if (unknown) throw new RuntimeContractError(`${unknown} is not accepted by this command`, {code: 'validation'});
  }
  for (const [name, value] of Object.entries(args)) {
    if (Object.hasOwn(properties, name)) validateField(name, value, properties[name]);
  }
}

function normalizeEntry(raw) {
  if (!plainObject(raw)) throw new RuntimeContractError('command registry entries must be objects', {code: 'unavailable'});
  const name = String(raw.name || '');
  const [target, action, ...rest] = name.split('.');
  if (rest.length || !SAFE_NAME.test(target || '') || !SAFE_NAME.test(action || '')) {
    throw new RuntimeContractError('command registry name is invalid', {code: 'unavailable'});
  }
  if (raw.target != null && raw.target !== target) throw new RuntimeContractError(`command registry target mismatch for ${name}`, {code: 'unavailable'});
  if (raw.action != null && raw.action !== action) throw new RuntimeContractError(`command registry action mismatch for ${name}`, {code: 'unavailable'});
  return Object.freeze({
    name,
    target,
    action,
    runtime_context: raw.runtime_context !== false,
    ownership: Boolean(raw.ownership),
    args_schema: cloneValue(raw.args_schema || null),
  });
}

export class RuntimeCommandRegistry {
  constructor(entries = []) {
    if (!Array.isArray(entries) || entries.length > 128) {
      throw new RuntimeContractError('command registry must contain at most 128 entries', {code: 'unavailable'});
    }
    this.entries = new Map();
    for (const raw of entries) {
      const entry = normalizeEntry(raw);
      if (this.entries.has(entry.name)) throw new RuntimeContractError(`duplicate command registry entry: ${entry.name}`, {code: 'unavailable'});
      this.entries.set(entry.name, entry);
    }
  }

  static fromCapabilities(capabilities) {
    if (!plainObject(capabilities)) return new RuntimeCommandRegistry();
    if (capabilities.command_registry != null) return new RuntimeCommandRegistry(capabilities.command_registry);
    const legacy = Array.isArray(capabilities.commands) ? capabilities.commands : [];
    return new RuntimeCommandRegistry(legacy.map(name => ({
      name,
      runtime_context: !String(name).startsWith('session.') && !String(name).startsWith('system.'),
      ownership: /^(control|param|grid|arc|gamepad)\./.test(String(name)),
    })));
  }

  get size() { return this.entries.size; }
  descriptor(command) { return this.entries.get(commandName(command)) || null; }

  validate(command, {allowUnknown = false} = {}) {
    validateCommandShape(command);
    const descriptor = this.descriptor(command);
    if (!descriptor) {
      if (allowUnknown) return null;
      throw new RuntimeContractError(`server does not advertise ${commandName(command)}`, {code: 'unavailable'});
    }
    validateArgs(command.args, descriptor.args_schema);
    return descriptor;
  }

  snapshot() { return [...this.entries.values()].map(entry => cloneValue(entry)); }
}

export function runtimeFailure(value, fallback = {}) {
  const code = RUNTIME_ERROR_CODES.has(value?.errorCode)
    ? value.errorCode
    : RUNTIME_ERROR_CODES.has(value?.code)
      ? value.code
      : RUNTIME_ERROR_CODES.has(fallback.code)
        ? fallback.code
        : 'runtime-error';
  return Object.freeze({
    code,
    message: String(value?.error || value?.message || fallback.message || code),
    retryable: Boolean(value?.retryable ?? fallback.retryable),
    context: cloneValue(value?.settlementContext ?? value?.context ?? fallback.context ?? null),
  });
}

export class RuntimeEventLog {
  constructor({limit = 256, now = () => Date.now()} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 16 || limit > 4096) throw new RuntimeContractError('event log limit must be between 16 and 4096', {code: 'validation'});
    this.limit = limit;
    this.now = now;
    this.nextSequence = 1;
    this.entries = [];
  }

  append(level, event, detail = undefined) {
    const entry = Object.freeze({
      sequence: this.nextSequence++,
      at: this.now(),
      level: String(level || 'info'),
      event: String(event || 'event'),
      ...(detail === undefined ? {} : {detail: cloneValue(detail)}),
    });
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    return entry;
  }

  snapshot() { return this.entries.map(entry => cloneValue(entry)); }
  clear() { this.entries.length = 0; }
  get size() { return this.entries.length; }
}
