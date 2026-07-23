export const PROTOCOL_VERSION = 1;
export const MESSAGE_TYPES = new Set(['hello','subscribe','snapshot','delta','command','ack','reject','heartbeat','resync']);

export class ProtocolError extends Error {}

export function validateEnvelope(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new ProtocolError('message must be an object');
  if (message.v !== PROTOCOL_VERSION) throw new ProtocolError(`unsupported protocol version: ${message.v}`);
  if (!MESSAGE_TYPES.has(message.type)) throw new ProtocolError(`unsupported message type: ${message.type}`);
  if (message.rev != null && (!Number.isSafeInteger(message.rev) || message.rev < 0)) throw new ProtocolError('rev must be a non-negative integer');
  if (message.id != null && (typeof message.id !== 'string' || !message.id)) throw new ProtocolError('id must be a non-empty string');
  return message;
}

export function initialProtocolState() {
  return {status:'connecting',revision:null,data:null,resyncRequired:false,resyncReason:null,lastHeartbeatAt:null};
}

function clone(value) { return value == null ? value : structuredClone(value); }
const DELETE = Symbol('delete');
const BLOCKED_PATH_KEYS = new Set(['__proto__','prototype','constructor']);

function assertPathKey(container,key) {
  const valid=typeof key==='string'||(Number.isSafeInteger(key)&&key>=0);
  if(!valid)throw new ProtocolError('operation path keys must be strings or non-negative integers');
  if(typeof key==='string'&&BLOCKED_PATH_KEYS.has(key))throw new ProtocolError(`unsafe operation path key: ${key}`);
  if(Array.isArray(container)&&(!Number.isSafeInteger(key)||key<0))throw new ProtocolError('array operation path keys must be non-negative integers');
}

function ownValue(container,key) {
  assertPathKey(container,key);
  return Object.getOwnPropertyDescriptor(container,key)?.value;
}

function ownSet(target,key,value) {
  assertPathKey(target,key);
  Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});
}

function cloneContainer(value,nextKey) {
  if(Array.isArray(value))return value.slice();
  if(value&&typeof value==='object')return {...value};
  return Number.isSafeInteger(nextKey)?[]:{};
}

function updateAt(root,path,updater,index=0) {
  if(!Array.isArray(path)||path.length===0)return updater(root);
  const key=path[index];
  const out=cloneContainer(root,key);
  assertPathKey(out,key);
  if(index===path.length-1){
    const value=updater(ownValue(out,key));
    if(value===DELETE){
      if(Array.isArray(out))out.splice(key,1);
      else Reflect.deleteProperty(out,key);
    }else ownSet(out,key,value);
    return out;
  }
  ownSet(out,key,updateAt(ownValue(out,key),path,updater,index+1));
  return out;
}

export function applyOperations(data, operations) {
  if (!Array.isArray(operations)) throw new ProtocolError('delta operations must be an array');
  let next = clone(data);
  for (const operation of operations) {
    if (!operation || !Array.isArray(operation.path)) throw new ProtocolError('operation path must be an array');
    if (operation.op === 'set') next = updateAt(next, operation.path, () => clone(operation.value));
    else if (operation.op === 'delete') next = updateAt(next, operation.path, () => DELETE);
    else throw new ProtocolError(`unsupported operation: ${operation.op}`);
  }
  return next;
}

export function reduceProtocolState(state, rawMessage, now = Date.now()) {
  const message = validateEnvelope(rawMessage);
  if (message.type === 'snapshot') {
    if (message.rev == null) throw new ProtocolError('snapshot requires rev');
    return {...state,status:'synced',revision:message.rev,data:clone(message.state),resyncRequired:false,resyncReason:null};
  }
  if (message.type === 'delta') {
    if (message.rev == null) throw new ProtocolError('delta requires rev');
    const expected = state.revision == null ? null : state.revision + 1;
    if (state.status !== 'synced' || expected !== message.rev) {
      return {...state,status:'resyncing',resyncRequired:true,resyncReason:{expected,received:message.rev}};
    }
    return {...state,revision:message.rev,data:applyOperations(state.data,message.operations),resyncRequired:false,resyncReason:null};
  }
  if (message.type === 'heartbeat') return {...state,lastHeartbeatAt:now};
  return state;
}

export function resyncRequest(state) {
  return {v:PROTOCOL_VERSION,type:'resync',from_rev:state.revision,reason:state.resyncReason || 'explicit'};
}

export class CommandTracker {
  constructor() { this.next = 1; this.pending = new Map(); }
  create(command, now = Date.now()) {
    const id = `cmd-${this.next++}`;
    this.pending.set(id,{command,createdAt:now,status:'pending'});
    return {v:PROTOCOL_VERSION,type:'command',id,command};
  }
  cancel(id,{status='cancelled',error=null}={}) {
    const pending=this.pending.get(id);
    if(!pending)return null;
    this.pending.delete(id);
    return {...pending,status,revision:null,error};
  }
  settle(message) {
    validateEnvelope(message);
    if (message.type !== 'ack' && message.type !== 'reject') throw new ProtocolError('command settlement must be ack or reject');
    const pending = this.pending.get(message.id);
    if (!pending) return null;
    this.pending.delete(message.id);
    return {...pending,status:message.type,revision:message.rev ?? null,error:message.error ?? null};
  }
}

export class OutboundQueue {
  constructor({reliableLimit=128,coalescibleLimit=128,ephemeralLimit=64}={}) {
    this.reliableLimit=reliableLimit;this.coalescibleLimit=coalescibleLimit;this.ephemeralLimit=ephemeralLimit;
    this.reliable=[];this.coalescible=new Map();this.ephemeral=new Map();
  }
  enqueue(message,{delivery='reliable',key=null,final=false}={}) {
    validateEnvelope(message);
    const displaced=[];
    if (delivery === 'reliable') {
      if (this.reliable.length >= this.reliableLimit) throw new ProtocolError('reliable queue overflow');
      this.reliable.push(message); return displaced;
    }
    if (!key) throw new ProtocolError(`${delivery} messages require a key`);
    const map = delivery === 'coalescible' ? this.coalescible : delivery === 'ephemeral' ? this.ephemeral : null;
    if (!map) throw new ProtocolError(`unknown delivery class: ${delivery}`);
    const limit = delivery === 'coalescible' ? this.coalescibleLimit : this.ephemeralLimit;
    if (!map.has(key) && map.size >= limit) {
      const oldest=map.keys().next().value;
      const evicted=map.get(oldest);
      if(evicted)displaced.push(evicted.message);
      map.delete(oldest);
    }
    const previous = map.get(key);
    if(previous)displaced.push(previous.message);
    map.set(key,{message,final:Boolean(final || previous?.final)});
    return displaced;
  }
  drain() {
    const out = this.reliable.splice(0);
    for (const {message,final} of this.coalescible.values()) out.push(final ? {...message,final:true} : message);
    for (const {message} of this.ephemeral.values()) out.push(message);
    this.coalescible.clear();this.ephemeral.clear();return out;
  }
  get size(){return this.reliable.length+this.coalescible.size+this.ephemeral.size;}
}
