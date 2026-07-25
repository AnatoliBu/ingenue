import test from 'node:test';
import assert from 'node:assert/strict';
import {MidiRuntime} from '../web/midi-runtime.js';
import {midiPorts} from '../web/midi-access.js';

const mapping={id:'key',source:{type:'note',channel:1,number:60},target:{kind:'key',n:2}};
const note=gate=>({type:'note',channel:1,number:60,raw:gate?100:0,normalized:gate?.8:0,gate});

test('MIDI runtime releases held mapped keys when profile, device or session deactivates',async()=>{
  let sequence=0;const sent=[];
  const runtime=new MidiRuntime({send:command=>{sent.push(command);return`m${++sequence}`;},describe:async()=>null});
  await runtime.activate([mapping]);runtime.handle(note(true));
  assert.deepEqual(sent.map(item=>item.args.z),[1]);
  const released=runtime.deactivate();
  assert.equal(released.length,1);assert.deepEqual(sent.map(item=>item.args.z),[1,0]);
  runtime.deactivate();assert.deepEqual(sent.map(item=>item.args.z),[1,0]);
});

test('activating a replacement profile releases the previous held key first',async()=>{
  let sequence=0;const sent=[];
  const runtime=new MidiRuntime({send:command=>{sent.push(command);return`m${++sequence}`;},describe:async()=>null});
  await runtime.activate([mapping]);runtime.handle(note(true));
  await runtime.activate([{...mapping,id:'replacement',target:{kind:'key',n:3}}]);
  assert.deepEqual(sent.map(item=>[item.args.n,item.args.z]),[[2,1],[2,0]]);
});

test('MIDI hotplug inventory excludes disconnected ports before selection',()=>{
  const connected={id:'in-1',name:'Connected',manufacturer:'Fixture',state:'connected',connection:'open'};
  const disconnected={id:'in-2',name:'Gone',manufacturer:'Fixture',state:'disconnected',connection:'closed'};
  const output={id:'out-1',name:'Output',manufacturer:'Fixture',state:'connected',connection:'open'};
  const ports=midiPorts({inputs:new Map([[connected.id,connected],[disconnected.id,disconnected]]),outputs:new Map([[output.id,output]])});
  assert.deepEqual(ports.inputs.map(item=>item.id),['in-1']);
  assert.deepEqual(ports.outputs.map(item=>item.id),['out-1']);
});
