import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('MLR observer is read-only and pinned to the documented upstream release', () => {
  const source = read('web/lib/ingenue_mlr.lua');
  assert.match(source, /version = '2\.2\.5'/);
  assert.match(source, /\/ingenue\/mlr\/track/);
  assert.match(source, /script_post_init/);
  assert.match(source, /script_post_cleanup/);
  assert.doesNotMatch(source, /softcut\./);
  assert.doesNotMatch(source, /grid\.connect/);
});

test('MLR reference pack documents controls, state, LEDs and acceptance', () => {
  const index = read('docs/references/mlr/README.md');
  const controls = read('docs/references/mlr/CONTROL-MAP.md');
  const state = read('docs/references/mlr/STATE-AND-LED-CONTRACT.md');
  const coverage = read('docs/references/mlr/BROWSER-COVERAGE.md');
  const tests = read('docs/references/mlr/TEST-SEQUENCES.md');
  assert.match(index, /1c21309bdfa1a6bdccd5f4fef5aea9768870732f/);
  assert.match(controls, /two positions on the same row/);
  assert.match(state, /tracks\[1\.\.6\]/);
  assert.match(coverage, /Shift-click chord/);
  assert.match(tests, /Real norns Shield/);
});

test('production mod and realtime server load the MLR extension', () => {
  assert.match(read('web/lib/mod.lua'), /require 'ingenue_mlr'/);
  const secure = read('web/realtime_secure.py');
  assert.match(secure, /MlrAppliedAdapter/);
  assert.match(secure, /MlrAppliedHub/);
});
