export class MidiError extends Error {}

export function parseMidiMessage(data) {
  const bytes = Array.from(data || []);
  if (bytes.length < 1 || !Number.isInteger(bytes[0])) return null;
  const status = bytes[0];
  const command = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  if (command === 0xb0 && bytes.length >= 3) {
    const number = bytes[1] & 0x7f;
    const raw = bytes[2] & 0x7f;
    return {type:'cc',channel,number,raw,normalized:raw/127,gate:raw>0};
  }
  if ((command === 0x80 || command === 0x90) && bytes.length >= 3) {
    const number = bytes[1] & 0x7f;
    const velocity = bytes[2] & 0x7f;
    const gate = command === 0x90 && velocity > 0;
    return {type:'note',channel,number,raw:velocity,normalized:velocity/127,gate};
  }
  if (command === 0xe0 && bytes.length >= 3) {
    const raw = (bytes[1] & 0x7f) | ((bytes[2] & 0x7f) << 7);
    return {type:'pitchbend',channel,number:null,raw,normalized:raw/16383,gate:true};
  }
  return null;
}

export function sourceKey(source) {
  if (!source || !['cc','note','pitchbend'].includes(source.type)) throw new MidiError('unsupported MIDI source');
  const channel = Number(source.channel);
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) throw new MidiError('MIDI channel must be 1–16');
  if (source.type === 'pitchbend') return `pitchbend:${channel}`;
  const number = Number(source.number);
  if (!Number.isInteger(number) || number < 0 || number > 127) throw new MidiError('MIDI number must be 0–127');
  return `${source.type}:${channel}:${number}`;
}

export function deviceFingerprint(input) {
  if (!input) throw new MidiError('MIDI input is required');
  const fields = [input.manufacturer, input.name, input.id].map(value => String(value || '').trim());
  if (!fields.some(Boolean)) throw new MidiError('MIDI input has no identity');
  return fields.join('\u241f');
}

export function relativeDelta(event, mode) {
  if (!event || event.type !== 'cc') throw new MidiError('relative encoder modes require CC input');
  const value = event.raw;
  if (mode === 'relative-twos') return value < 64 ? value : value === 64 ? 0 : value - 128;
  if (mode === 'relative-offset') return value - 64;
  if (mode === 'relative-sign') return value === 64 ? 0 : value < 64 ? value : -(value - 64);
  throw new MidiError(`unsupported relative mode: ${mode}`);
}

export class SoftTakeover {
  constructor(epsilon = 2 / 127) {
    this.epsilon = epsilon;
    this.target = null;
    this.last = null;
    this.picked = false;
  }
  arm(target) {
    if (!Number.isFinite(target)) throw new MidiError('pickup target must be finite');
    this.target = Math.min(1, Math.max(0, target));
    this.last = null;
    this.picked = false;
  }
  accept(value) {
    if (!Number.isFinite(value) || this.target == null) return false;
    const current = Math.min(1, Math.max(0, value));
    if (!this.picked) {
      const close = Math.abs(current - this.target) <= this.epsilon;
      const crossed = this.last != null && ((this.last <= this.target && current >= this.target) || (this.last >= this.target && current <= this.target));
      this.picked = close || crossed;
    }
    this.last = current;
    return this.picked;
  }
  updateApplied(value) {
    if (Number.isFinite(value)) this.target = Math.min(1, Math.max(0, value));
  }
}

function validateSource(source) {
  sourceKey(source);
  return {type:source.type,channel:Number(source.channel),number:source.type==='pitchbend'?null:Number(source.number)};
}

export function validateMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new MidiError('mapping must be an object');
  const id = String(mapping.id || '').trim();
  if (!id) throw new MidiError('mapping id is required');
  const source = validateSource(mapping.source);
  const target = mapping.target || {};
  if (target.kind === 'param') {
    const paramId = String(target.id || '').trim();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(paramId)) throw new MidiError('invalid target param id');
    const mode = mapping.mode || 'absolute';
    if (!['absolute','relative-twos','relative-offset','relative-sign'].includes(mode)) throw new MidiError('invalid param mapping mode');
    return {id,source,target:{kind:'param',id:paramId},mode,pickup:mapping.pickup !== false};
  }
  if (target.kind === 'key') {
    const n = Number(target.n);
    if (![1,2,3].includes(n)) throw new MidiError('key target must be K1–K3');
    return {id,source,target:{kind:'key',n},mode:'gate',pickup:false};
  }
  if (target.kind === 'encoder') {
    const n = Number(target.n);
    if (![1,2,3].includes(n)) throw new MidiError('encoder target must be E1–E3');
    const mode = mapping.mode || 'relative-twos';
    if (!['relative-twos','relative-offset','relative-sign'].includes(mode)) throw new MidiError('encoder target requires a relative mode');
    return {id,source,target:{kind:'encoder',n},mode,pickup:false};
  }
  throw new MidiError('unsupported mapping target');
}

export class ProfileStore {
  constructor(storage, key = 'ingenue:midi:v1') {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new MidiError('storage is required');
    this.storage = storage;
    this.key = key;
  }
  readAll() {
    try {
      const parsed = JSON.parse(this.storage.getItem(this.key) || '{}');
      return parsed && parsed.version === 1 && parsed.profiles && typeof parsed.profiles === 'object' ? parsed : {version:1,profiles:{}};
    } catch {
      return {version:1,profiles:{}};
    }
  }
  load(scriptName, fingerprint) {
    const script = String(scriptName || '');
    const device = String(fingerprint || '');
    const raw = this.readAll().profiles?.[script]?.[device];
    if (!Array.isArray(raw)) return [];
    const valid = [];
    for (const mapping of raw) {
      try { valid.push(validateMapping(mapping)); } catch { /* skip corrupt rows */ }
    }
    return valid;
  }
  save(scriptName, fingerprint, mappings) {
    const script = String(scriptName || '').trim();
    const device = String(fingerprint || '').trim();
    if (!script || !device) throw new MidiError('script and MIDI device are required');
    const data = this.readAll();
    data.profiles[script] ||= {};
    data.profiles[script][device] = mappings.map(validateMapping);
    this.storage.setItem(this.key, JSON.stringify(data));
    return data.profiles[script][device];
  }
}

export function mappingMatches(mapping, event) {
  return sourceKey(mapping.source) === sourceKey(event);
}
