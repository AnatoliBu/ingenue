import test from 'node:test';
import assert from 'node:assert/strict';
import {CommandTracker,runtimeContext,validateEnvelope} from '../web/realtime-protocol.js';
import {RealtimeSession} from '../web/realtime-session.js';

if(!globalThis.CustomEvent){globalThis.CustomEvent=class CustomEvent extends Event{constructor(type,init={}){super(type);this.detail=init.detail;}};}

class FakeSocket extends EventTarget{
  constructor(){super();this.readyState=0;this.sent=[];}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
  receive(message){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(message)}));}
  send(message){this.sent.push(JSON.parse(message));}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}

function harness(){
  const sockets=[];
  const session=new RealtimeSession({
    socketFactory:()=>{const socket=new FakeSocket();sockets.push(socket);return socket;},
    url:'ws://device/realtime',
    channels:['control','script'],
    clientId:'browser-runtime-test',
    logger:null,
    setTimer:()=>({}),
    clearTimer:()=>{},
  });
  return{session,sockets};
}

const context={session_generation:'runtime-abc123',script_generation:4};

test('runtime context is validated and attached to tracked commands',()=>{
  assert.deepEqual(runtimeContext({runtime:context}),context);
  assert.equal(runtimeContext({runtime:{session_generation:'x',script_generation:-1}}),null);
  const tracker=new CommandTracker();
  const message=tracker.create({target:'control',action:'enc',args:{n:1,d:1}},123,context);
  assert.deepEqual(message.context,context);
  assert.notEqual(message.context,context);
});

test('structured reject envelopes require published runtime error codes',()=>{
  const message=validateEnvelope({v:1,type:'reject',id:'cmd-1',rev:2,error:'stale',code:'stale-context',retryable:true,context});
  assert.equal(message.code,'stale-context');
  assert.throws(()=>validateEnvelope({...message,code:'made-up'}),/unsupported runtime error code/);
});

test('session commands carry snapshot generations and stale rejects trigger resync',()=>{
  const{session,sockets}=harness();
  const settlements=[];
  session.addEventListener('command',event=>settlements.push(event.detail));
  session.connect();
  sockets[0].open();
  sockets[0].receive({v:1,type:'snapshot',rev:1,state:{runtime:context,script:{active:true,name:'test',generation:4}}});
  const id=session.command({target:'control',action:'key',args:{n:2,z:1}});
  const command=sockets[0].sent.find(message=>message.type==='command'&&message.id===id);
  assert.deepEqual(command.context,context);
  const serverContext={session_generation:'runtime-abc123',script_generation:5};
  sockets[0].receive({v:1,type:'reject',id,rev:2,error:'active script changed before command application',code:'stale-context',retryable:true,context:serverContext});
  assert.equal(settlements[0].errorCode,'stale-context');
  assert.equal(settlements[0].retryable,true);
  assert.deepEqual(settlements[0].settlementContext,serverContext);
  assert.equal(session.state.status,'resyncing');
  assert.equal(sockets[0].sent.at(-1).type,'resync');
});

test('connection loss is exposed through the same machine-readable error shape',()=>{
  const{session,sockets}=harness();
  const settlements=[];
  session.addEventListener('command',event=>settlements.push(event.detail));
  session.connect();
  sockets[0].open();
  session.command({target:'system',action:'ping',args:{}});
  sockets[0].close();
  assert.equal(settlements[0].status,'uncertain');
  assert.equal(settlements[0].errorCode,'connection-lost');
  assert.equal(settlements[0].retryable,true);
});
