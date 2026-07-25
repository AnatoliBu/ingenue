import test from 'node:test';
import assert from 'node:assert/strict';
import {descriptorNumericValue,descriptorRange} from '../web/param-hardening-ui.js';

test('parameter descriptors prefer the authoritative raw value text',()=>{
  assert.equal(descriptorNumericValue({value_text:'440',normalized:0.5,min_text:'20',max_text:'20000'}),440);
  assert.equal(descriptorNumericValue({value:12.5,value_text:'ignored'}),12.5);
  assert.equal(descriptorNumericValue({raw:-3}),-3);
});

test('normalized descriptor values fall back to a finite linear range',()=>{
  assert.equal(descriptorNumericValue({normalized:0.25,min_text:'0',max_text:'100'}),25);
  assert.equal(descriptorNumericValue({normalized:0.25,min_text:'',max_text:'100'}),null);
  assert.equal(descriptorNumericValue({normalized:2,min_text:'0',max_text:'100'}),null);
});

test('descriptor ranges reject empty, reversed and non-finite metadata',()=>{
  assert.deepEqual(descriptorRange({min_text:'-1',max_text:'1'}),{min:-1,max:1});
  assert.equal(descriptorRange({min_text:'1',max_text:'1'}),null);
  assert.equal(descriptorRange({min_text:'2',max_text:'1'}),null);
  assert.equal(descriptorRange({min_text:'',max_text:'1'}),null);
  assert.equal(descriptorRange({min_text:'x',max_text:'1'}),null);
});
