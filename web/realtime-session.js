import {
  PROTOCOL_VERSION,
  CommandTracker,
  OutboundQueue,
  initialProtocolState,
  reduceProtocolState,
  resyncRequest,
  validateEnvelope,
} from './realtime-protocol.js';

const CLIENT_ID_KEY = 'ingenue.realtime.client-id';
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export class SessionError extends Error {}

function availableSessionStorage() {
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

export function stableClientId({storage=availableSessionStorage(),randomUUID=globalThis.crypto?.randomUUID?.bind(globalThis.crypto),now=()=>Date.now(),random=Math.random}={}) {
  try {
    const existing=storage?.getItem?.(CLIENT_ID_KEY);
    if(CLIENT_ID_PATTERN.test(existing||''))return existing;
  } catch {}
  const generated=`browser-${randomUUID?.()||`${now().toString(36)}-${Math.floor(random()*0x100000000).toString(36)}`}`;
  if(!CLIENT_ID_PATTERN.test(generated))throw new SessionError('could not create a valid browser client id');
  try{storage?.setItem?.(CLIENT_ID_KEY,generated);}catch{}
  return generated;
}

export class RealtimeSession extends EventTarget {
  constructor({socketFactory,url,channels=[],clientId=null,clientStorage=null,randomUUID=null,reconnect={minMs:250,maxMs:5000,factor:2},heartbeatTimeoutMs=5000,now=()=>Date.now(),setTimer=(fn,ms)=>globalThis.setTimeout(fn,ms),clearTimer=id=>globalThis.clearTimeout(id)}) {
    super();
    if (typeof socketFactory !== 'function') throw new SessionError('socketFactory is required');
    this.socketFactory=socketFactory;
    this.url=url;
    this.channels=[...new Set([...channels,'ownership'])];
    this.clientId=clientId||stableClientId({storage:clientStorage||availableSessionStorage(),randomUUID:randomUUID||globalThis.crypto?.randomUUID?.bind(globalThis.crypto),now});
    if(!CLIENT_ID_PATTERN.test(this.clientId))throw new SessionError('clientId must contain 8–128 safe characters');
    this.reconnect=reconnect;this.heartbeatTimeoutMs=heartbeatTimeoutMs;this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;
    this.state=initialProtocolState();this.commands=new CommandTracker();this.queue=new OutboundQueue();this.inflight=new Set();this.socket=null;this.stopped=true;this.reconnectAttempt=0;this.reconnectTimer=null;this.heartbeatTimer=null;
  }
  connect(){this.stopped=false;this.#open();}
  disconnect(){this.stopped=true;this.#clearTimers();if(this.socket)this.socket.close();this.socket=null;this.#setConnectionState('disconnected');}
  command(command,options={}){const message=this.commands.create(command,this.now());const displaced=this.queue.enqueue(message,options);for(const previous of displaced){if(previous?.type==='command'&&previous.id)this.commands.cancel(previous.id,{status:'coalesced'});}this.flush();return message.id;}
  claim(resource){return this.command({target:'session',action:'claim',args:{resource}});}
  release(resource){return this.command({target:'session',action:'release',args:{resource}});}
  releaseAll(){return this.command({target:'session',action:'release_all',args:{}});}
  owns(resource){return this.state.data?.ownership?.resources?.[resource]?.client_id===this.clientId;}
  publish(message,options={}){validateEnvelope(message);this.queue.enqueue(message,options);this.flush();}
  flush(){if(!this.socket||this.socket.readyState!==1)return false;for(const message of this.queue.drain()){this.socket.send(JSON.stringify(message));if(message.type==='command'&&message.id&&this.commands.pending.has(message.id))this.inflight.add(message.id);}return true;}
  #open(){this.#clearReconnect();this.#setConnectionState('connecting');const socket=this.socketFactory(this.url);this.socket=socket;socket.addEventListener('open',()=>this.#onOpen(socket));socket.addEventListener('message',event=>this.#onMessage(socket,event));socket.addEventListener('close',()=>this.#onClose(socket));socket.addEventListener('error',error=>this.#emit('error',error));}
  #onOpen(socket){if(socket!==this.socket)return;this.reconnectAttempt=0;this.#setConnectionState('subscribing');socket.send(JSON.stringify({v:PROTOCOL_VERSION,type:'hello',client:'ingenue-browser',client_id:this.clientId}));socket.send(JSON.stringify({v:PROTOCOL_VERSION,type:'subscribe',channels:this.channels}));this.flush();this.#armHeartbeatWatchdog();}
  #onMessage(socket,event){if(socket!==this.socket)return;let message;try{message=validateEnvelope(JSON.parse(String(event.data)));}catch(error){this.#emit('protocolerror',error);return;}if(message.type==='hello')this.#emit('hello',structuredClone(message));if(message.type==='ack'||message.type==='reject'){this.inflight.delete(message.id);const settled=this.commands.settle(message);if(settled)this.#emit('command',{id:message.id,...settled,result:message.result??null});return;}const previous=this.state;this.state=reduceProtocolState(this.state,message,this.now());if(message.type==='heartbeat')this.#armHeartbeatWatchdog();if(this.state.resyncRequired&&!previous.resyncRequired)socket.send(JSON.stringify(resyncRequest(this.state)));if(this.state!==previous)this.#emit('state',this.snapshot());}
  #onClose(socket){if(socket!==this.socket)return;this.#settleInflightUncertain();this.socket=null;this.#clearHeartbeat();if(this.stopped)return;this.#setConnectionState('reconnecting');const{minMs,maxMs,factor}=this.reconnect;const delay=Math.min(maxMs,minMs*factor**this.reconnectAttempt++);this.reconnectTimer=this.setTimer(()=>this.#open(),delay);this.#emit('reconnectscheduled',{delay,attempt:this.reconnectAttempt});}
  #settleInflightUncertain(){for(const id of this.inflight){const settled=this.commands.cancel(id,{status:'uncertain',error:'connection lost before acknowledgement'});if(settled)this.#emit('command',{id,...settled,result:null});}this.inflight.clear();}
  #armHeartbeatWatchdog(){this.#clearHeartbeat();this.heartbeatTimer=this.setTimer(()=>{if(!this.socket)return;this.#emit('stale',{lastHeartbeatAt:this.state.lastHeartbeatAt});this.socket.close();},this.heartbeatTimeoutMs);}
  #setConnectionState(status){this.state={...this.state,status};this.#emit('state',this.snapshot());}
  snapshot(){return structuredClone(this.state);}
  #emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}
  #clearReconnect(){if(this.reconnectTimer!=null)this.clearTimer(this.reconnectTimer);this.reconnectTimer=null;}
  #clearHeartbeat(){if(this.heartbeatTimer!=null)this.clearTimer(this.heartbeatTimer);this.heartbeatTimer=null;}
  #clearTimers(){this.#clearReconnect();this.#clearHeartbeat();}
}
