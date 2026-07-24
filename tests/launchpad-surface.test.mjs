import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LaunchpadError,
  mapLaunchpadPad,
  normalizeLaunchpadView,
  pageCount,
  pageRail,
  projectLaunchpadFrame,
  transformLaunchpadCoordinate,
} from '../web/launchpad-core.js';

test('page counts cover native Grid sizes', () => {
  assert.equal(pageCount(8), 1);
  assert.equal(pageCount(16), 2);
  assert.equal(pageCount(32), 4);
});

test('view clamps stale page selection after a smaller Grid appears', () => {
  const view = normalizeLaunchpadView({cols: 8, rows: 16, pageX: 3, pageY: 9, rotation: 0});
  assert.equal(view.pageX, 0);
  assert.equal(view.pageY, 1);
});

test('page offsets map an 8x8 surface into a 16x16 Grid', () => {
  const view = {cols: 16, rows: 16, pageX: 1, pageY: 1, rotation: 0};
  assert.deepEqual(mapLaunchpadPad(1, 1, view), {x: 9, y: 9});
  assert.deepEqual(mapLaunchpadPad(8, 8, view), {x: 16, y: 16});
});

test('quarter-turn transforms are deterministic', () => {
  assert.deepEqual(transformLaunchpadCoordinate(1, 2, {rotation: 1}), {x: 7, y: 1});
  assert.deepEqual(transformLaunchpadCoordinate(1, 2, {rotation: 2}), {x: 8, y: 7});
  assert.deepEqual(transformLaunchpadCoordinate(1, 2, {rotation: 3}), {x: 2, y: 8});
});

test('flips are applied before rotation', () => {
  assert.deepEqual(transformLaunchpadCoordinate(1, 2, {rotation: 1, flipX: true}), {x: 7, y: 8});
  assert.deepEqual(transformLaunchpadCoordinate(1, 2, {flipY: true}), {x: 1, y: 7});
});

test('partial pages expose invalid pads instead of wrapping', () => {
  const frame = {
    cols: 10,
    rows: 8,
    values: Array.from({length: 80}, (_, index) => index % 16),
  };
  const projected = projectLaunchpadFrame(frame, {pageX: 1, pageY: 0, rotation: 0});
  assert.equal(projected.valid.filter(Boolean).length, 16);
  assert.deepEqual(projected.values.slice(0, 4), [8, 9, 0, 0]);
  assert.equal(mapLaunchpadPad(3, 1, projected.view), null);
});

test('frame projection follows transformed Grid coordinates', () => {
  const frame = {
    cols: 8,
    rows: 8,
    values: Array.from({length: 64}, (_, index) => index),
  };
  const projected = projectLaunchpadFrame(frame, {rotation: 2});
  assert.equal(projected.values[0], 63);
  assert.equal(projected.values[63], 0);
});

test('page rail is bounded to eight browser utility buttons', () => {
  const rail = pageRail(4, 2);
  assert.equal(rail.length, 8);
  assert.deepEqual(rail.slice(0, 4).map(item => item.enabled), [true, true, true, true]);
  assert.equal(rail[2].active, true);
  assert.equal(rail[4].enabled, false);
});

test('invalid coordinates and malformed frames reject early', () => {
  assert.throws(() => transformLaunchpadCoordinate(0, 1), LaunchpadError);
  assert.throws(() => normalizeLaunchpadView({cols: 33, rows: 8}), LaunchpadError);
  assert.throws(() => projectLaunchpadFrame({cols: 8, rows: 8, values: []}), LaunchpadError);
});
