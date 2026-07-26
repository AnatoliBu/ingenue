import test from 'node:test';
import assert from 'node:assert/strict';
import {QUALITY_BUDGETS,contrastRatio,percentile,relativeLuminance} from '../web/quality-contract.js';

test('quality budgets preserve Shield headroom',()=>{
  assert.equal(QUALITY_BUDGETS.mobileTouchPx,44);
  assert.equal(QUALITY_BUDGETS.normalContrast,4.5);
  assert.equal(QUALITY_BUDGETS.reconnectCycles,8);
  assert.ok(QUALITY_BUDGETS.commandP95Ms<QUALITY_BUDGETS.commandMaxMs);
});

test('relative luminance and contrast match WCAG reference values',()=>{
  assert.equal(relativeLuminance('#000000'),0);
  assert.equal(relativeLuminance([255,255,255]),1);
  assert.equal(Number(contrastRatio('#ffffff','#000000').toFixed(2)),21);
  assert.ok(contrastRatio('#eef4e9','#08090b')>=4.5);
});

test('percentile uses a deterministic nearest-rank contract',()=>{
  const values=[40,10,30,20,50];
  assert.equal(percentile(values,.5),30);
  assert.equal(percentile(values,.95),50);
  assert.equal(percentile(values,0),10);
  assert.throws(()=>percentile([],0.5),/required/);
});
