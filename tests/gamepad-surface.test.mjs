import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectionLedger,
  GamepadSurfaceError,
  axisSign,
  normalizeStickVector,
  normalizeTrigger,
  pointerStickVector,
} from '../web/gamepad-core.js';

test('stick vector preserves direction and clamps radius', () => {
  assert.deepEqual(normalizeStickVector(2, 0, 0), {x: 1, y: 0, magnitude: 1});
  const diagonal = normalizeStickVector(1, 1, 0);
  assert.ok(diagonal.x > 0.7 && diagonal.x < 0.71);
  assert.equal(diagonal.x, diagonal.y);
});

test('deadzone recenters and remaps remaining travel', () => {
  assert.deepEqual(normalizeStickVector(0.05, -0.05, 0.12), {x: 0, y: 0, magnitude: 0});
  const value = normalizeStickVector(0.56, 0, 0.12);
  assert.equal(value.x, 0.5);
  assert.equal(value.y, 0);
});

test('pointer coordinates normalize against the smaller radius', () => {
  const rect = {left: 10, top: 20, width: 200, height: 100};
  assert.deepEqual(pointerStickVector(rect, 110, 70, 0), {x: 0, y: 0, magnitude: 0});
  assert.deepEqual(pointerStickVector(rect, 160, 70, 0), {x: 1, y: 0, magnitude: 1});
});

test('axis signs use the native two-thirds threshold', () => {
  assert.equal(axisSign(0.8), 1);
  assert.equal(axisSign(-0.8), -1);
  assert.equal(axisSign(0.5), 0);
});

test('triggers clamp to zero through one', () => {
  assert.equal(normalizeTrigger(-2), 0);
  assert.equal(normalizeTrigger(0.33333), 0.3333);
  assert.equal(normalizeTrigger(4), 1);
});

test('direction ledger releases old sign before opposite sign', () => {
  const events = [];
  const ledger = new DirectionLedger((axis, sign) => events.push([axis, sign]));
  ledger.press(1, {axis: 'X', sign: -1});
  ledger.press(2, {axis: 'X', sign: 1});
  ledger.release(1);
  ledger.release(2);
  assert.deepEqual(events, [['X', -1], ['X', 0], ['X', 1], ['X', 0]]);
});

test('direction ledger supports simultaneous X and Y', () => {
  const events = [];
  const ledger = new DirectionLedger((axis, sign) => events.push([axis, sign]));
  ledger.press('x', {axis: 'X', sign: 1});
  ledger.press('y', {axis: 'Y', sign: -1});
  ledger.releaseAll();
  assert.deepEqual(events, [['X', 1], ['Y', -1], ['X', 0], ['Y', 0]]);
});

test('invalid vectors and d-pad targets reject', () => {
  assert.throws(() => normalizeStickVector(0, 0, 1), GamepadSurfaceError);
  assert.throws(() => pointerStickVector({width: 0, height: 1}, 0, 0), GamepadSurfaceError);
  const ledger = new DirectionLedger(() => {});
  assert.throws(() => ledger.press(1, {axis: 'Z', sign: 1}), GamepadSurfaceError);
});
