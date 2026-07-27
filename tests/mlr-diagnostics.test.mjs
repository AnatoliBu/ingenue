import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MlrDiagnosticLatch,
  hasMlrAudioTelemetry,
  inspectMlrAvailability,
  mlrControlPolicy,
} from '../web/mlr-diagnostics.js';

test('MLR diagnostics warn once per outage and emit one recovery', () => {
  const events = [];
  const latch = new MlrDiagnosticLatch((level, event, detail) => events.push({level, event, detail}));

  assert.equal(latch.update('audio', true, {
    event: 'mlr audio visualization unavailable',
    detail: {missing: ['waveform']},
    recoveryEvent: 'mlr audio visualization available',
  }), true);
  assert.equal(latch.update('audio', true, {
    event: 'mlr audio visualization unavailable',
    detail: {missing: ['waveform']},
    recoveryEvent: 'mlr audio visualization available',
  }), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].level, 'warn');

  assert.equal(latch.update('audio', false, {
    event: 'mlr audio visualization unavailable',
    recoveryEvent: 'mlr audio visualization available',
  }), true);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(item => item.event), [
    'mlr audio visualization unavailable',
    'mlr audio visualization available',
  ]);
  assert.equal(events[1].level, 'info');
});

test('MLR availability distinguishes script, observer, Grid and audio telemetry', () => {
  const availability = inspectMlrAvailability({
    script: {active: true, shortname: 'mlr', name: 'mlr'},
    mlr: {active: true, clips: {'1': {name: '-'}}},
    grid: {
      ports: {
        '1': {port: 1, cols: 8, rows: 8, virtual: true},
        '2': {port: 2, cols: 16, rows: 8, virtual: true},
      },
    },
  });
  assert.equal(availability.scriptIsMlr, true);
  assert.equal(availability.observerActive, true);
  assert.equal(availability.active, true);
  assert.equal(availability.gridPort, 2);
  assert.equal(availability.gridAvailable, true);
  assert.equal(availability.audioTelemetry, false);
  assert.deepEqual(mlrControlPolicy({...availability, runtimeReady: true}), {
    keys: true,
    encoders: true,
    grid: true,
    workflow: true,
  });
});

test('MLR audio telemetry treats explicit empty measurements as authoritative data', () => {
  assert.equal(hasMlrAudioTelemetry({clips: {'1': {has_audio: false}}}), true);
  assert.equal(hasMlrAudioTelemetry({clips: {'1': {peak: 0, rms: 0, waveform: []}}}), true);
  assert.equal(hasMlrAudioTelemetry({clips: {'1': {name: '-', length: 16}}}), false);
});

test('native Grid and K/E do not depend on MLR observer state', () => {
  assert.deepEqual(mlrControlPolicy({
    runtimeReady: true,
    active: false,
    gridAvailable: true,
  }), {
    keys: true,
    encoders: true,
    grid: true,
    workflow: false,
  });
  assert.deepEqual(mlrControlPolicy({
    runtimeReady: true,
    active: false,
    gridAvailable: false,
  }), {
    keys: true,
    encoders: true,
    grid: false,
    workflow: false,
  });
  assert.deepEqual(mlrControlPolicy({
    runtimeReady: false,
    active: true,
    gridAvailable: true,
  }), {
    keys: false,
    encoders: false,
    grid: false,
    workflow: false,
  });
});
