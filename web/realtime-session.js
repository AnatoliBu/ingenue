import {
  PROTOCOL_VERSION,
  CommandTracker,
  OutboundQueue,
  initialProtocolState,
  reduceProtocolState,
  resyncRequest,
  validateEnvelope,
} from './realtime-protocol.js';

export class SessionError extends Error {}

export class RealtimeSession extends EventTarget {
  constructor({socketFactory,url,channels=[],reconnect={minMs:250,maxMs:5000,factor:2},heartbeatTimeoutMs=5000,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}) {
    super();
    if (typeof socketFactory !== 'function') throw new SessionError('socketFactory is required');
    this.socketFactory=socketFactory;this.url=url;this.channels=[...channels];this.reconnect=reconnect;this.heartbeatTimeoutMs=heartbeatTimeoutMs;this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;
    this.state=initialProtocolState();this.commands=new CommandTracker();this.queue=new OutboundQueue();this.socket=null;this.stopped=true;this.reconnectAttempt=0;this.reconnectTimer=null;this.heartbeatTimer=null;
  }
  connect(){this.stopped=false;this.#open();}
  disconnect(){this.stopped=true;this.#clearTimers();if(this.socket)this.socket.close();this.socket=null;this.#setConnectionState('disconnected');}
  command(command,options={}){const message=this.commands.create(command,this.now());this.queue.enqueue(message,options);this.flush();return message.id;}
  publish(message,options={}){validateEnvelope(message);this.queue.enqueue(message,options);this.flush();}
  flush(){if(!this.socket||this.socket.readyState!==1)return false;for(const message of this.queue.drain())this.socket.send(JSON.stringify(message));return true;}
  #open(){this.#clearReconnect();this.#setConnectionState('connecting');const socket=this.socketFactory(this.url);this.socket=socket;socket.addEventListener('open',()=>this.#onOpen(socket));socket.addEventListener('message',event=>this.#onMessage(socket,event));socket.addEventListener('close',()=>this.#onClose(socket));socket.addEventListener('error',error=>this.#emit('error',error));}
  #onOpen(socket){if(socket!==this.socket)return;this.reconnectAttempt=0;this.#setConnectionState('subscribing');socket.send(JSON.stringify({v:PROTOCOL_VERSION,type:'hello',client:'ingenue-browser'}));socket.send(JSON.stringify({v:PROTOCOL_VERSION,type:'subscribe',channels:this.channels}));this.flush();this.#armHeartbeatWatchdog();}
  #onMessage(socket,event){if(socket!==this.socket)return;let message;try{message=validateEnvelope(JSON.parse(String(event.data)));}catch(error){this.#emit('protocolerror',error);return;}if(message.type==='ack'||message.type==='reject'){const settled=this.commands.settle(message);if(settled)this.#emit('command',{id:message.id,...settled});return;}const previous=this.state;this.state=reduceProtocolState(this.state,message,this.now());if(message.type==='heartbeat')this.#armHeartbeatWatchdog();if(this.state.resyncRequired&&!previous.resyncRequired)socket.send(JSON.stringify(resyncRequest(this.state)));if(this.state!==previous)this.#emit('state',this.snapshot());}
  #onClose(socket){if(socket!==this.socket)return;this.socket=null;this.#clearHeartbeat();if(this.stopped)return;this.#setConnectionState('reconnecting');const{minMs,maxMs,factor}=this.reconnect;const delay=Math.min(maxMs,minMs*factor**this.reconnectAttempt++);this.reconnectTimer=this.setTimer(()=>this.#open(),delay);this.#emit('reconnectscheduled',{delay,attempt:this.reconnectAttempt});}
  #armHeartbeatWatchdog(){this.#clearHeartbeat();this.heartbeatTimer=this.setTimer(()=>{if(!this.socket)return;this.#emit('stale',{lastHeartbeatAt:this.state.lastHeartbeatAt});this.socket.close();},this.heartbeatTimeoutMs);}
  #setConnectionState(status){this.state={...this.state,status};this.#emit('state',this.snapshot());}
  snapshot(){return structuredClone(this.state);}
  #emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}
  #clearReconnect(){if(this.reconnectTimer!=null)this.clearTimer(this.reconnectTimer);this.reconnectTimer=null;}
  #clearHeartbeat(){if(this.heartbeatTimer!=null)this.clearTimer(this.heartbeatTimer);this.heartbeatTimer=null;}
  #clearTimers(){this.#clearReconnect();this.#clearHeartbeat();}
}
