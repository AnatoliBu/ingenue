import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeMlrGridFrame, gridIndex, loopChordCommands, normalizeMlrState, selectMlrGridPort, viewHelp} from '../web/mlr-core.js';

function fixtureState() {
  const tracks = {};
  for (let index = 1; index <= 6; index += 1) tracks[index] = {index, clip: index};
  return {active: true, version: '2.2.5', view: 2, focus: 1, tracks};
}

test('MLR state normalizes six tracks, seven clips and four memory slots', () => {
  const state = normalizeMlrState(fixtureState());
  assert.equal(state.view_name, 'cut');
  assert.equal(Object.keys(state.tracks).length, 6);
  assert.equal(Object.keys(state.clips).length, 7);
  assert.equal(Object.keys(state.patterns).length, 4);
  assert.equal(Object.keys(state.recalls).length, 4);
  assert.equal(state.tracks['6'].clip, 6);
});

test('MLR Grid decoder requires the upstream 16 by 8 contract', () => {
  const frame = decodeMlrGridFrame({port: 2, cols: 16, rows: 8, frame: 'f' + '0'.repeat(127), intensity: 15, sequence: 9, virtual: true});
  assert.equal(frame.values.length, 128);
  assert.equal(frame.values[0], 15);
  assert.equal(frame.port, 2);
  assert.throws(() => decodeMlrGridFrame({port: 1, cols: 8, rows: 8, frame: '0'.repeat(64)}), /16×8/);
});

test('MLR selects an available 16 by 8 vport and ignores ordinary Grid frames', () => {
  const ports = {'1': {port: 1, cols: 8, rows: 8, virtual: true}, '2': {port: 2, cols: 16, rows: 8, virtual: true}, '3': {port: 3, cols: 16, rows: 8, virtual: false}};
  assert.equal(selectMlrGridPort(ports), 2);
  assert.equal(selectMlrGridPort(ports, 3), 3);
  assert.equal(selectMlrGridPort({'1': ports['1']}), null);
});

test('desktop loop chord preserves MLR down down up up ordering', () => {
  assert.deepEqual(loopChordCommands(2, 4, 3, 11).map(item => item.args), [
    {port: 2, x: 3, y: 4, z: 1}, {port: 2, x: 11, y: 4, z: 1},
    {port: 2, x: 11, y: 4, z: 0}, {port: 2, x: 3, y: 4, z: 0},
  ]);
  assert.equal(gridIndex(16, 8), 127);
});

test('view help describes the exact upstream control layer', () => {
  assert.match(viewHelp(1), /record/);
  assert.match(viewHelp(2), /loop/);
  assert.match(viewHelp(3), /clip/);
  assert.match(viewHelp(15), /tempo/);
});
