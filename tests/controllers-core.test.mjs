import test from 'node:test';
import assert from 'node:assert/strict';
import {buildControllerReadiness} from '../web/controllers-core.js';

const hello = {capabilities:{
  channels:['device','script','grid','arc','params'],
  commands:['control.enc','control.key','grid.key','arc.delta','param.catalog','gamepad.button','gamepad.analog'],
  midi:{normalized_params:true}, gamepad:{normalized:true},
}};
const state = {status:'synced',data:{
  script:{active:true,name:'awake'},
  grid:{ports:{'1':{virtual:true}}},
  arc:{ports:{'2':{virtual:true}}},
  params:{items:[{id:'cutoff'},{id:'level'}]},
}};

test('readiness summarizes native controller surfaces',()=>{
  const result=buildControllerReadiness({hello,state,webMidiSupported:true,secureContext:true,pingMs:12.4});
  assert.equal(result.protocolReady,true);
  assert.equal(result.scriptName,'awake');
  assert.equal(result.cards.find(card=>card.id==='grid').status,'ready');
  assert.equal(result.cards.find(card=>card.id==='params').detail,'2 catalog entries');
  assert.equal(result.cards.find(card=>card.id==='transport').detail,'12 ms browser ↔ server');
});

test('Web MIDI reports insecure and unsupported browsers honestly',()=>{
  const insecure=buildControllerReadiness({hello,state,webMidiSupported:true,secureContext:false});
  assert.equal(insecure.cards.find(card=>card.id==='midi').status,'warn');
  assert.match(insecure.cards.find(card=>card.id==='midi').detail,/secure context/);
  const unsupported=buildControllerReadiness({hello,state,webMidiSupported:false,secureContext:true});
  assert.match(unsupported.cards.find(card=>card.id==='midi').detail,/does not expose/);
});

test('missing hello or snapshot keeps cards unavailable',()=>{
  const result=buildControllerReadiness({state:{status:'connecting',data:null}});
  assert.equal(result.protocolReady,false);
  assert.equal(result.cards.find(card=>card.id==='gamepad').status,'off');
  assert.equal(result.readyCount,0);
});

test('published device counts are reflected without assuming hardware',()=>{
  const result=buildControllerReadiness({hello,state:{...state,data:{...state.data,grid:{ports:{}},arc:{ports:{}}}}});
  assert.equal(result.cards.find(card=>card.id==='grid').detail,'no Grid frame published');
  assert.equal(result.cards.find(card=>card.id==='arc').detail,'no Arc frame published');
  assert.equal(result.cards.find(card=>card.id==='grid').status,'warn');
  assert.equal(result.cards.find(card=>card.id==='arc').status,'warn');
  assert.equal(result.cards.find(card=>card.id==='launchpad').status,'warn');
});

test('missing active script or parameter catalog is limited, not falsely ready',()=>{
  const limitedState={...state,data:{...state.data,script:{active:false,name:'none'},params:{items:[]}}};
  const result=buildControllerReadiness({hello,state:limitedState});
  assert.equal(result.cards.find(card=>card.id==='performance').status,'warn');
  assert.equal(result.cards.find(card=>card.id==='params').status,'warn');
});
