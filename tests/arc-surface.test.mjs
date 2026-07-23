import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SurfaceError,
  arcAngularSteps,
  decodeArcFrame,
  selectArcPort,
} from '../web/performance-core.js';

test('Arc frame decodes four varibright rings', () => {
  const payload = '0'.repeat(63) + 'f' + '1'.repeat(64) + '2'.repeat(64) + '3'.repeat(64);
  const frame = decodeArcFrame({
    port: 2,
    rings: 4,
    frame: payload,
    sequence: 9,
    intensity: 12,
    virtual: true,
  });
  assert.equal(frame.values.length, 256);
  assert.equal(frame.values[63], 15);
  assert.equal(frame.values[64], 1);
  assert.equal(frame.sequence, 9);
  assert.equal(frame.virtual, true);
});

test('Arc frame rejects unsupported ring count and malformed payload', () => {
  assert.throws(() => decodeArcFrame({port: 1, rings: 3, frame: '0'.repeat(192)}), SurfaceError);
  assert.throws(() => decodeArcFrame({port: 1, rings: 2, frame: '0'.repeat(127)}), SurfaceError);
  assert.throws(() => decodeArcFrame({port: 1, rings: 2, frame: 'g'.repeat(128)}), SurfaceError);
});

test('Arc port preference favors requested then physical device', () => {
  const ports = {'1': {virtual: true}, '2': {virtual: false}, '3': {virtual: true}};
  assert.equal(selectArcPort(ports, 3), 3);
  assert.equal(selectArcPort(ports, 4), 2);
  assert.equal(selectArcPort({'1': {virtual: true}}, null), 1);
});

test('Arc angular delta crosses the twelve o-clock wrap without jumping', () => {
  const degrees = value => value / 180 * Math.PI;
  const clockwise = arcAngularSteps(degrees(179), degrees(-179));
  const counterClockwise = arcAngularSteps(degrees(-179), degrees(179));
  assert.ok(clockwise > 5 && clockwise < 6);
  assert.ok(counterClockwise < -5 && counterClockwise > -6);
});

test('Arc angular delta preserves 1024-step turn resolution', () => {
  assert.equal(arcAngularSteps(0, Math.PI / 2), 256);
  assert.equal(arcAngularSteps(0, -Math.PI / 2), -256);
});
