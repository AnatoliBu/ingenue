import test from 'node:test';
import assert from 'node:assert/strict';
import {encoderKeyDelta} from '../web/ke-hardening-ui.js';

test('encoder keyboard directions match norns delta semantics',()=>{
  assert.equal(encoderKeyDelta({key:'ArrowUp'}),1);
  assert.equal(encoderKeyDelta({key:'ArrowRight'}),1);
  assert.equal(encoderKeyDelta({key:'ArrowDown'}),-1);
  assert.equal(encoderKeyDelta({key:'ArrowLeft'}),-1);
  assert.equal(encoderKeyDelta({key:'ArrowUp',shiftKey:true}),8);
  assert.equal(encoderKeyDelta({key:'ArrowLeft',shiftKey:true}),-8);
});

test('unrelated keys do not produce encoder commands',()=>{
  assert.equal(encoderKeyDelta({key:'Enter'}),0);
  assert.equal(encoderKeyDelta({key:' '}),0);
  assert.equal(encoderKeyDelta({key:'PageUp'}),0);
  assert.equal(encoderKeyDelta(null),0);
});
