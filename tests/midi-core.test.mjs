import test from 'node:test';
import assert from 'node:assert/strict';
import {MidiError,ProfileStore,SoftTakeover,deviceFingerprint,mappingMatches,parseMidiMessage,relativeDelta,sourceKey,validateMapping} from '../web/midi-core.js';

test('parses CC, note gate and pitch bend',()=>{
  assert.deepEqual(parseMidiMessage([0xb2,74,127]),{type:'cc',channel:3,number:74,raw:127,normalized:1,gate:true});
  assert.equal(parseMidiMessage([0x90,60,0]).gate,false);
  assert.equal(parseMidiMessage([0x80,60,100]).gate,false);
  assert.equal(parseMidiMessage([0xe0,0,64]).raw,8192);
});
test('source keys distinguish type channel and number',()=>{
  assert.equal(sourceKey({type:'cc',channel:1,number:7}),'cc:1:7');
  assert.equal(sourceKey({type:'pitchbend',channel:16}),'pitchbend:16');
});
test('relative modes decode common controller formats',()=>{
  const e=raw=>({type:'cc',raw});
  assert.equal(relativeDelta(e(127),'relative-twos'),-1);
  assert.equal(relativeDelta(e(65),'relative-offset'),1);
  assert.equal(relativeDelta(e(65),'relative-sign'),-1);
  assert.equal(relativeDelta(e(1),'relative-sign'),1);
});
test('soft takeover accepts near or crossed target only',()=>{
  const pickup=new SoftTakeover();pickup.arm(.5);
  assert.equal(pickup.accept(.1),false);assert.equal(pickup.accept(.4),false);assert.equal(pickup.accept(.6),true);assert.equal(pickup.accept(.2),true);
});
test('profile storage is scoped by exact script and device',()=>{
  const memory=new Map();const storage={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)};const store=new ProfileStore(storage);
  const mapping={id:'m1',source:{type:'cc',channel:1,number:74},target:{kind:'param',id:'cutoff'},mode:'absolute'};
  store.save('awake','controller-a',[mapping]);
  assert.equal(store.load('awake','controller-a').length,1);
  assert.equal(store.load('other','controller-a').length,0);
  assert.equal(store.load('awake','controller-b').length,0);
});
test('corrupt stored mappings are ignored',()=>{
  const storage={getItem:()=>JSON.stringify({version:1,profiles:{awake:{dev:[{id:'bad'}]}}}),setItem:()=>{}};
  assert.deepEqual(new ProfileStore(storage).load('awake','dev'),[]);
});
test('mapping validation enforces target and relative source modes',()=>{
  assert.throws(()=>validateMapping({id:'x',source:{type:'cc',channel:1,number:1},target:{kind:'key',n:9}}),MidiError);
  const map=validateMapping({id:'x',source:{type:'cc',channel:1,number:1},target:{kind:'encoder',n:2},mode:'relative-twos'});
  assert.equal(map.target.n,2);
});
test('mapping matching uses learned source signature',()=>{
  const map=validateMapping({id:'x',source:{type:'note',channel:2,number:40},target:{kind:'key',n:1}});
  assert.equal(mappingMatches(map,{type:'note',channel:2,number:40}),true);
  assert.equal(mappingMatches(map,{type:'note',channel:1,number:40}),false);
});
test('device fingerprint includes manufacturer name and browser id',()=>{
  assert.equal(deviceFingerprint({manufacturer:'ACME',name:'Knobs',id:'42'}),'ACME␟Knobs␟42');
});
