import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeCommandRegistry,
  RuntimeContractError,
  RuntimeEventLog,
  runtimeFailure,
} from '../web/runtime-contract.js';
import {RealtimeSession} from '../web/realtime-session.js';

if(!globalThis.CustomEvent){globalThis.CustomEvent=class CustomEvent extends Event{constructor(type,init={}){super(type);this.detail=init.detail;}};}

const context={session_generation:'runtime-browser-test',script_generation:3};
const commandRegistry=[
  {
    name:'control.key',target:'control',action:'key',runtime_context:true,ownership:true,
    args_schema:{type:'object',additional:false,required:['n','z'],properties:{
      n:{type:'integer',minimum:1,maximum:3},z:{type:'integer',enum:[0,1]},
    }},
  },
  {name:'system.ping',target:'system',action:'ping',runtime_context:false,ownership:false,args_schema:{type:'object',additional:false,required:[],properties:{}}},
  {name:'session.release_all',target:'session',action:'release_all',runtime_context:false,ownership:false,args_schema:{type:'object',additional:false,required:[],properties:{}}},
];

class FakeSocket extends EventTarget{
  constructor(){super();this.readyState=0;this.sent=[];}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
  receive(message){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(message)}));}
  send(message){this.sent.push(JSON.parse(message));}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}

function harness(options={}){
  const sockets=[];
  const session=new RealtimeSession({
    socketFactory:()=>{const socket=new FakeSocket();sockets.push(socket);return socket;},
    url:'ws://device/realtime',channels:['control','script'],clientId:'browser-runtime-client',logger:null,
    setTimer:()=>({}),clearTimer:()=>{},...options,
  });
  return{session,sockets};
}

function synchronize(session,socket){
  session.connect();
  socket.open();
  socket.receive({v:1,type:'hello',server:'fixture',client_id:'browser-runtime-client',capabilities:{command_registry:commandRegistry}});
  socket.receive({v:1,type:'snapshot',rev:1,state:{runtime:context,script:{active:true,name:'fixture',generation:3}}});
}

test('published command schemas reject invalid and unsupported browser commands before transport',()=>{
  const registry=new RuntimeCommandRegistry(commandRegistry);
  assert.equal(registry.validate({target:'control',action:'key',args:{n:2,z:1}}).name,'control.key');
  assert.throws(
    ()=>registry.validate({target:'control',action:'key',args:{n:4,z:1}}),
    error=>error instanceof RuntimeContractError&&error.code==='validation',
  );
  assert.throws(
    ()=>registry.validate({target:'control',action:'enc',args:{n:1,d:1}}),
    error=>error instanceof RuntimeContractError&&error.code==='unavailable',
  );
});

test('session uses the registry for context policy and normalized failures',()=>{
  const{session,sockets}=harness();
  synchronize(session,sockets[0]);
  const before=sockets[0].sent.length;
  const keyId=session.command({target:'control',action:'key',args:{n:1,z:1}});
  const pingId=session.command({target:'system',action:'ping',args:{}});
  const sent=sockets[0].sent.slice(before);
  const key=sent.find(message=>message.id===keyId);
  const ping=sent.find(message=>message.id===pingId);
  assert.deepEqual(key.context,context);
  assert.equal(Object.hasOwn(ping,'context'),false);
  assert.throws(()=>session.command({target:'control',action:'key',args:{n:9,z:1}}),RuntimeContractError);
  assert.equal(sockets[0].sent.length,before+2);

  let settlement;
  session.addEventListener('command',event=>{settlement=event.detail;});
  sockets[0].receive({v:1,type:'reject',id:keyId,rev:1,error:'controlled elsewhere',code:'ownership',retryable:false,context});
  assert.deepEqual(settlement.failure,{code:'ownership',message:'controlled elsewhere',retryable:false,context});
});

test('runtime event log is bounded, ordered and clone-safe',()=>{
  const log=new RuntimeEventLog({limit:16,now:(()=>{let value=100;return()=>++value;})()});
  for(let index=0;index<25;index+=1)log.append(index%2?'debug':'info',`event-${index}`,{index,error:new Error('safe')});
  const snapshot=log.snapshot();
  assert.equal(snapshot.length,16);
  assert.equal(snapshot[0].sequence,10);
  assert.equal(snapshot.at(-1).sequence,25);
  assert.equal(snapshot.at(-1).detail.error.message,'safe');
  snapshot[0].detail.index=-1;
  assert.notEqual(log.snapshot()[0].detail.index,-1);
});

test('session exposes structured events for diagnostics and CI assertions',()=>{
  const{session,sockets}=harness({eventLimit:16});
  const observed=[];
  session.addEventListener('runtimeevent',event=>observed.push(event.detail));
  synchronize(session,sockets[0]);
  const id=session.command({target:'system',action:'ping',args:{}});
  sockets[0].receive({v:1,type:'ack',id,rev:1,result:{pong:true},context});
  const events=session.eventSnapshot();
  assert.ok(events.some(entry=>entry.event==='server hello'));
  assert.ok(events.some(entry=>entry.event==='snapshot'));
  assert.ok(events.some(entry=>entry.event==='command ACK'));
  assert.ok(observed.length>0);
});

test('runtime failure always returns one stable machine-readable shape',()=>{
  assert.deepEqual(runtimeFailure({message:'lost',code:'connection-lost',retryable:true}),{
    code:'connection-lost',message:'lost',retryable:true,context:null,
  });
  assert.equal(runtimeFailure({message:'unknown',code:'nonsense'}).code,'runtime-error');
});
