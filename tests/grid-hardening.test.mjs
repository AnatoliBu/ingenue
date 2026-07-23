import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PressLedger,
  SurfaceError,
  decodeGridFrame,
  gridConfigurationFromFrame,
  normalizeGridConfiguration,
} from '../web/performance-core.js';

test('Grid frame carries authoritative rotation', () => {
  const frame = decodeGridFrame({
    port: 2,
    cols: 8,
    rows: 16,
    frame: '0'.repeat(128),
    sequence: 4,
    intensity: 12,
    virtual: true,
    rotation: 1,
  });
  assert.equal(frame.rotation, 1);
  assert.equal(frame.cols, 8);
  assert.equal(frame.rows, 16);
});

test('Grid configuration accepts only native profiles', () => {
  assert.deepEqual(normalizeGridConfiguration({port: 3, shape: '16x16', rotation: 2}), {
    port: 3, cols: 16, rows: 16, rotation: 2,
  });
  assert.throws(() => normalizeGridConfiguration({port: 1, shape: '12x8', rotation: 0}), SurfaceError);
  assert.throws(() => normalizeGridConfiguration({port: 5, shape: '8x8', rotation: 0}), SurfaceError);
});

test('Grid config reconstructs base shape from rotated frame', () => {
  assert.deepEqual(gridConfigurationFromFrame({port: 1, cols: 8, rows: 16, rotation: 1}), {
    port: 1, cols: 16, rows: 8, rotation: 1,
  });
});

test('Press ledger slide releases the old cell before pressing the new one', () => {
  const events = [];
  const ledger = new PressLedger((target, z) => events.push({...target, z}));
  ledger.press(7, {port: 1, x: 1, y: 1});
  assert.equal(ledger.move(7, {port: 1, x: 2, y: 1}), true);
  assert.equal(ledger.move(7, {port: 1, x: 2, y: 1}), false);
  ledger.release(7);
  assert.deepEqual(events, [
    {port: 1, x: 1, y: 1, z: 1},
    {port: 1, x: 1, y: 1, z: 0},
    {port: 1, x: 2, y: 1, z: 1},
    {port: 1, x: 2, y: 1, z: 0},
  ]);
});
