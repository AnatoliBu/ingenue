import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppliedValueLane,
  PressLedger,
  SurfaceError,
  decodeGridFrame,
  effectiveBrightness,
  encoderSteps,
  selectGridPort,
} from '../web/performance-core.js';

test('grid frame decodes authoritative hex levels', () => {
  const frame = decodeGridFrame({port: 2, cols: 2, rows: 2, frame: '0f81', sequence: 7, intensity: 12, virtual: false});
  assert.deepEqual(frame.values, [0, 15, 8, 1]);
  assert.equal(frame.port, 2);
  assert.equal(frame.sequence, 7);
});

test('grid frame rejects dimension and payload mismatch', () => {
  assert.throws(() => decodeGridFrame({port: 1, cols: 2, rows: 2, frame: 'fff'}), SurfaceError);
  assert.throws(() => decodeGridFrame({port: 1, cols: 33, rows: 1, frame: '0'.repeat(33)}), SurfaceError);
});

test('grid port preference falls back to physical then first', () => {
  const ports = {'1': {virtual: true}, '2': {virtual: false}, '3': {virtual: false}};
  assert.equal(selectGridPort(ports, 3), 3);
  assert.equal(selectGridPort(ports, 4), 2);
  assert.equal(selectGridPort({'1': {virtual: true}}, null), 1);
});

test('effective brightness combines LED and global intensity', () => {
  assert.equal(effectiveBrightness(15, 15), 1);
  assert.equal(effectiveBrightness(15, 0), 0);
  assert.equal(effectiveBrightness(8, 8), 0.2844);
});

test('press ledger sends balanced down and up for every pointer', () => {
  const sent = [];
  const ledger = new PressLedger((target, z) => sent.push({...target, z}));
  ledger.press(1, {x: 2, y: 3});
  ledger.press(2, {x: 4, y: 5});
  ledger.release(1);
  ledger.releaseAll();
  assert.deepEqual(sent, [
    {x: 2, y: 3, z: 1},
    {x: 4, y: 5, z: 1},
    {x: 2, y: 3, z: 0},
    {x: 4, y: 5, z: 0},
  ]);
});

test('reusing a pointer releases the old target first', () => {
  const sent = [];
  const ledger = new PressLedger((target, z) => sent.push([target.x, z]));
  ledger.press(9, {x: 1});
  ledger.press(9, {x: 2});
  assert.deepEqual(sent, [[1, 1], [1, 0], [2, 1]]);
});

test('encoder gesture quantizes vertical movement', () => {
  assert.equal(encoderSteps(100, 72, 14), 2);
  assert.equal(encoderSteps(100, 127, 14), -1);
});

test('applied value lane keeps one command in flight and latest desired value', () => {
  let next = 1;
  const sent = [];
  const lane = new AppliedValueLane(value => {
    const id = `cmd-${next++}`;
    sent.push({id, value});
    return id;
  });
  assert.equal(lane.push(0.1), 'cmd-1');
  assert.equal(lane.push(0.2), null);
  assert.equal(lane.push(0.9), null);
  assert.equal(lane.settle('cmd-1', 'ack'), 'cmd-2');
  assert.deepEqual(sent, [{id: 'cmd-1', value: 0.1}, {id: 'cmd-2', value: 0.9}]);
});

test('applied value lane ignores unrelated settlements', () => {
  const lane = new AppliedValueLane(value => `value-${value}`);
  lane.push(4);
  lane.push(5);
  assert.equal(lane.settle('other', 'ack'), null);
  assert.equal(lane.inflight.id, 'value-4');
});

test('uncertain absolute value is replayed to guarantee final state', () => {
  let next = 1;
  const sent = [];
  const lane = new AppliedValueLane(value => {
    const id = `retry-${next++}`;
    sent.push({id, value});
    return id;
  });
  lane.push(0.4);
  assert.equal(lane.settle('retry-1', 'uncertain'), 'retry-2');
  assert.deepEqual(sent, [{id: 'retry-1', value: 0.4}, {id: 'retry-2', value: 0.4}]);
});

test('queued desired value wins over uncertain inflight value', () => {
  let next = 1;
  const sent = [];
  const lane = new AppliedValueLane(value => {
    const id = `queued-${next++}`;
    sent.push(value);
    return id;
  });
  lane.push(0.8);
  lane.push(0.2);
  assert.equal(lane.settle('queued-1', 'uncertain'), 'queued-2');
  assert.deepEqual(sent, [0.8, 0.2]);
});
