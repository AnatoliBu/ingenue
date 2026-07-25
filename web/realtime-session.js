import {
  PROTOCOL_VERSION,
  CommandTracker,
  OutboundQueue,
  initialProtocolState,
  reduceProtocolState,
  resyncRequest,
  runtimeContext,
  validateEnvelope,
} from './realtime-protocol.js';
import {
  RuntimeCommandRegistry,
  RuntimeContractError,
  RuntimeEventLog,
  commandName,
  runtimeFailure,
} from './runtime-contract.js';

const CLIENT_ID_KEY = 'ingenue.realtime.client-id';
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const LOG_PREFIX = '[ingenue realtime]';

export class SessionError extends Error {}

function availableSessionStorage() {
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

function defaultLogger() {
  return typeof globalThis.document === 'object' ? globalThis.console || null : null;
}

function exposeDebugSession(session) {
  if (typeof globalThis.document !== 'object') return;
  try {
    const debug = globalThis.ingenueDebug || {sessions: []};
    if (!Array.isArray(debug.sessions)) debug.sessions = [];
    debug.sessions.push(session);
    debug.latest = session;
    globalThis.ingenueDebug = debug;
  } catch {}
}

function commandSummary(message) {
  const command = message?.command || {};
  return {
    id: message?.id,
    command: commandName(command),
    args: command.args || {},
    context: message?.context || null,
  };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
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
  constructor({socketFactory,url,channels=[],clientId=null,clientStorage=null,randomUUID=null,logger=undefined,reconnect={minMs:250,maxMs:5000,factor:2},heartbeatTimeoutMs=5000,eventLog=null,eventLimit=256,now=()=>Date.now(),setTimer=(fn,ms)=>globalThis.setTimeout(fn,ms),clearTimer=id=>globalThis.clearTimeout(id)}) {
    super();
    if (typeof socketFactory !== 'function') throw new SessionError('socketFactory is required');
    this.socketFactory=socketFactory;
    this.url=url;
    this.channels=[...new Set([...channels,'ownership'])];
    this.clientId=clientId||stableClientId({storage:clientStorage||availableSessionStorage(),randomUUID:randomUUID||globalThis.crypto?.randomUUID?.bind(globalThis.crypto),now});
    if(!CLIENT_ID_PATTERN.test(this.clientId))throw new SessionError('clientId must contain 8–128 safe characters');
    this.logger=logger===undefined?defaultLogger():logger;
    this.reconnect=reconnect;
    this.heartbeatTimeoutMs=heartbeatTimeoutMs;
    this.now=now;
    this.setTimer=setTimer;
    this.clearTimer=clearTimer;
    this.events=eventLog||new RuntimeEventLog({limit:eventLimit,now});
    this.capabilities=null;
    this.registry=new RuntimeCommandRegistry();
    this.state=initialProtocolState();
    this.commands=new CommandTracker();
    this.queue=new OutboundQueue();
    this.inflight=new Set();
    this.socket=null;
    this.stopped=true;
    this.reconnectAttempt=0;
    this.reconnectTimer=null;
    this.heartbeatTimer=null;
    exposeDebugSession(this);
    this.#log('info','session created',{url:this.url,clientId:this.clientId,channels:this.channels});
  }

  connect(){this.#log('info','connect requested',{url:this.url});this.stopped=false;this.#open();}
  disconnect(){this.#log('info','disconnect requested');this.stopped=true;this.#clearTimers();if(this.socket)this.socket.close();this.socket=null;this.#setConnectionState('disconnected');}

  command(command,options={}){
    let descriptor;
    try {
      descriptor=this.registry.validate(command,{allowUnknown:this.registry.size===0});
    } catch(error) {
      const failure=error instanceof RuntimeContractError?runtimeFailure(error):runtimeFailure(error,{code:'validation'});
      this.#log('warn','command rejected locally',{command:commandName(command),failure});
      throw error;
    }
    const requiresContext=descriptor ? descriptor.runtime_context : !['session','system'].includes(command.target);
    const context=requiresContext?runtimeContext(this.state.data):null;
    const message=this.commands.create(command,this.now(),context);
    this.#log('info','command queued',{...commandSummary(message),delivery:options.delivery||'reliable'});
    const displaced=this.queue.enqueue(message,options);
    for(const previous of displaced){
      if(previous?.type==='command'&&previous.id){
        this.commands.cancel(previous.id,{status:'coalesced'});
        this.#log('debug','command coalesced',commandSummary(previous));
      }
    }
    this.flush();
    return message.id;
  }

  claim(resource){return this.command({target:'session',action:'claim',args:{resource}});}
  release(resource){return this.command({target:'session',action:'release',args:{resource}});}
  releaseAll(){return this.command({target:'session',action:'release_all',args:{}});}
  owns(resource){return this.state.data?.ownership?.resources?.[resource]?.client_id===this.clientId;}
  publish(message,options={}){validateEnvelope(message);this.queue.enqueue(message,options);this.flush();}
  eventSnapshot(){return this.events.snapshot();}

  flush(){
    if(!this.socket||this.socket.readyState!==1)return false;
    for(const message of this.queue.drain()){
      this.#log(message.type==='command'?'info':'debug','send',message.type==='command'?commandSummary(message):message);
      this.socket.send(JSON.stringify(message));
      if(message.type==='command'&&message.id&&this.commands.pending.has(message.id))this.inflight.add(message.id);
    }
    return true;
  }

  #open(){
    this.#clearReconnect();
    this.#setConnectionState('connecting');
    let socket;
    try{socket=this.socketFactory(this.url);}
    catch(error){this.#log('error','WebSocket construction failed',{url:this.url,error:error?.message||String(error)});this.#emit('error',error);return;}
    this.socket=socket;
    socket.addEventListener('open',()=>this.#onOpen(socket));
    socket.addEventListener('message',event=>this.#onMessage(socket,event));
    socket.addEventListener('close',event=>this.#onClose(socket,event));
    socket.addEventListener('error',error=>{this.#log('error','WebSocket error',error);this.#emit('error',error);});
  }

  #onOpen(socket){
    if(socket!==this.socket)return;
    this.reconnectAttempt=0;
    this.#log('info','WebSocket open',{url:this.url});
    this.#setConnectionState('subscribing');
    socket.send(JSON.stringify({v:PROTOCOL_VERSION,type:'hello',client:'ingenue-browser',client_id:this.clientId}));
    socket.send(JSON.stringify({v:PROTOCOL_VERSION,type:'subscribe',channels:this.channels}));
    this.flush();
    this.#armHeartbeatWatchdog();
  }

  #onMessage(socket,event){
    if(socket!==this.socket)return;
    let message;
    try{message=validateEnvelope(JSON.parse(String(event.data)));}
    catch(error){this.#log('error','protocol parse failed',{error:error?.message||String(error),raw:String(event.data).slice(0,500)});this.#emit('protocolerror',error);return;}
    if(message.type==='hello'){
      try{
        this.capabilities=clone(message.capabilities||{});
        this.registry=RuntimeCommandRegistry.fromCapabilities(this.capabilities);
      }catch(error){
        this.#log('error','runtime capability registry rejected',{error:error?.message||String(error)});
        this.#emit('protocolerror',error);
        socket.close();
        return;
      }
      this.#log('info','server hello',{server:message.server,clientId:message.client_id,capabilities:this.capabilities,commands:this.registry.size});
      this.#emit('hello',clone(message));
    }
    if(message.type==='ack'||message.type==='reject'){
      this.inflight.delete(message.id);
      const settled=this.commands.settle(message);
      const detail=settled?{id:message.id,...settled,result:message.result??null}:null;
      if(detail)detail.failure=message.type==='reject'?runtimeFailure(detail):null;
      this.#log(message.type==='ack'?'info':'warn',message.type==='ack'?'command ACK':'command REJECT',detail||message);
      if(detail)this.#emit('command',detail);
      if(message.type==='reject'&&message.code==='stale-context')this.#requestResync({code:'stale-context',serverContext:message.context||null});
      return;
    }
    const previous=this.state;
    this.state=reduceProtocolState(this.state,message,this.now());
    if(message.type==='snapshot')this.#log('info','snapshot',{revision:message.rev,channels:Object.keys(message.state||{}),context:runtimeContext(message.state)});
    else if(message.type==='delta')this.#log('debug','delta',{revision:message.rev,operations:message.operations?.length||0});
    if(message.type==='heartbeat')this.#armHeartbeatWatchdog();
    if(this.state.resyncRequired&&!previous.resyncRequired){
      this.#log('warn','revision gap; requesting resync',this.state.resyncReason);
      socket.send(JSON.stringify(resyncRequest(this.state)));
    }
    if(this.state!==previous)this.#emit('state',this.snapshot());
  }

  #requestResync(reason){
    if(!this.socket||this.socket.readyState!==1)return;
    this.state={...this.state,status:'resyncing',resyncRequired:true,resyncReason:reason};
    this.#log('warn','runtime context stale; requesting resync',reason);
    this.socket.send(JSON.stringify(resyncRequest(this.state)));
    this.#emit('state',this.snapshot());
  }

  #onClose(socket,event){
    if(socket!==this.socket)return;
    this.#log('warn','WebSocket closed',{code:event?.code,reason:event?.reason||'',clean:event?.wasClean});
    this.#settleInflightUncertain();
    this.socket=null;
    this.capabilities=null;
    this.registry=new RuntimeCommandRegistry();
    this.#clearHeartbeat();
    if(this.stopped)return;
    this.#setConnectionState('reconnecting');
    const{minMs,maxMs,factor}=this.reconnect;
    const delay=Math.min(maxMs,minMs*factor**this.reconnectAttempt++);
    this.reconnectTimer=this.setTimer(()=>this.#open(),delay);
    this.#log('info','reconnect scheduled',{delay,attempt:this.reconnectAttempt});
    this.#emit('reconnectscheduled',{delay,attempt:this.reconnectAttempt});
  }

  #settleInflightUncertain(){
    for(const id of this.inflight){
      const settled=this.commands.cancel(id,{status:'uncertain',error:'connection lost before acknowledgement',errorCode:'connection-lost',retryable:true});
      if(settled){
        const detail={id,...settled,result:null};
        detail.failure=runtimeFailure(detail);
        this.#log('warn','command uncertain',detail);
        this.#emit('command',detail);
      }
    }
    this.inflight.clear();
  }

  #armHeartbeatWatchdog(){this.#clearHeartbeat();this.heartbeatTimer=this.setTimer(()=>{if(!this.socket)return;this.#log('warn','heartbeat timeout',{lastHeartbeatAt:this.state.lastHeartbeatAt});this.#emit('stale',{lastHeartbeatAt:this.state.lastHeartbeatAt});this.socket.close();},this.heartbeatTimeoutMs);}
  #setConnectionState(status){if(this.state.status!==status)this.#log('info','state',{from:this.state.status,to:status});this.state={...this.state,status};this.#emit('state',this.snapshot());}
  snapshot(){return clone(this.state);}
  #emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}

  #log(level,event,detail=undefined){
    const entry=this.events.append(level,event,detail);
    this.#emit('runtimeevent',entry);
    const method=this.logger?.[level]||this.logger?.log;
    if(typeof method!=='function')return;
    try{if(detail===undefined)method.call(this.logger,LOG_PREFIX,event);else method.call(this.logger,LOG_PREFIX,event,detail);}catch{}
  }

  #clearReconnect(){if(this.reconnectTimer!=null)this.clearTimer(this.reconnectTimer);this.reconnectTimer=null;}
  #clearHeartbeat(){if(this.heartbeatTimer!=null)this.clearTimer(this.heartbeatTimer);this.heartbeatTimer=null;}
  #clearTimers(){this.#clearReconnect();this.#clearHeartbeat();}
}
