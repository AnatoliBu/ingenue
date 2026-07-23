import test from 'node:test';
import assert from 'node:assert/strict';
import {adapterMessage,decodeGridLevels,encoderSteps} from '../web/performance.js';

test('grid hex frame decodes to brightness values',()=>{
  const levels=decodeGridLevels({cols:2,rows:2,levels:'0f79'});
  assert.deepEqual(levels,[0,15,7,9]);
});

test('grid decoder pads a short frame safely',()=>{
  assert.deepEqual(decodeGridLevels({cols:2,rows:1,levels:'f'}),[15,0]);
});

test('encoder drag becomes signed integer steps',()=>{
  assert.equal(encoderSteps(20,7),2);
  assert.equal(encoderSteps(-20,7),-2);
});

test('adapter message gives the required device action',()=>{
  assert.match(adapterMessage({installed:true,enabled:false,online:false}),/SYSTEM/);
  assert.match(adapterMessage({online:true,version:'1'}),/online/);
});
