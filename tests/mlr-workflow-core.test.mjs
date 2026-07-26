import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipActionPlan,
  loopPlan,
  recordNowPlan,
  resizeClipPlan,
  selectClipPlan,
} from '../web/mlr-workflow-core.js';

const compact = plan => plan.map(item => [item.target, item.action, item.args]);

test('clip assignment uses the exact upstream CLIP view and row/slot taps', () => {
  assert.deepEqual(compact(selectClipPlan({port: 2, track: 3, clip: 6})), [
    ['grid', 'key', {port: 2, x: 3, y: 1, z: 1}],
    ['grid', 'key', {port: 2, x: 3, y: 1, z: 0}],
    ['grid', 'key', {port: 2, x: 6, y: 4, z: 1}],
    ['grid', 'key', {port: 2, x: 6, y: 4, z: 0}],
  ]);
});

test('record workflow assigns the clip, enters REC, arms and starts only when needed', () => {
  const plan = recordNowPlan({port: 1, track: 2, clip: 4, armed: false, playing: false});
  assert.equal(plan.length, 10);
  assert.deepEqual(plan.at(-4).args, {port: 1, x: 1, y: 3, z: 1});
  assert.deepEqual(plan.at(-2).args, {port: 1, x: 16, y: 3, z: 1});
  assert.equal(recordNowPlan({port: 1, track: 2, clip: 4, armed: true, playing: true}).length, 6);
});

test('loop workflow preserves upstream down/down/up/up ordering on one track row', () => {
  const plan = loopPlan({port: 4, track: 5, start: 12, end: 3});
  assert.deepEqual(plan.slice(-4).map(item => [item.args.x, item.args.y, item.args.z]), [
    [12, 6, 1], [3, 6, 1], [3, 6, 0], [12, 6, 0],
  ]);
});

test('clip actions deterministically clamp E2 before selecting load clear or save', () => {
  const clear = clipActionPlan({port: 1, track: 1, clip: 7, action: 'clear'});
  assert.deepEqual(compact(clear).slice(-4), [
    ['control', 'enc', {n: 2, d: -127}],
    ['control', 'enc', {n: 2, d: 1}],
    ['control', 'key', {n: 2, z: 1}],
    ['control', 'key', {n: 2, z: 0}],
  ]);
});

test('resize supports every upstream half-through-sixteen beat multiplier', () => {
  const plan = resizeClipPlan({port: 1, track: 1, clip: 1, factor: 16});
  assert.deepEqual(compact(plan).slice(-4), [
    ['control', 'enc', {n: 3, d: -127}],
    ['control', 'enc', {n: 3, d: 5}],
    ['control', 'key', {n: 3, z: 1}],
    ['control', 'key', {n: 3, z: 0}],
  ]);
});
