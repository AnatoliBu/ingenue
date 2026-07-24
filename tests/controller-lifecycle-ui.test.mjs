import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {normalizeArcConfiguration} from '../web/arc-hardening-ui.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('Arc configuration normalizes supported native profiles', () => {
  assert.deepEqual(normalizeArcConfiguration({port: '4', rings: '2'}), {port: 4, rings: 2});
  assert.throws(() => normalizeArcConfiguration({port: 0, rings: 4}), /vport/);
  assert.throws(() => normalizeArcConfiguration({port: 1, rings: 3}), /2 or 4/);
});

test('performance page exposes and mounts persistent Arc configuration', () => {
  const html = read('web/performance.html');
  for (const id of ['arc-config-port', 'arc-config-rings', 'arc-apply']) {
    assert.ok(html.includes(`id="${id}"`));
  }
  assert.match(html, /mountArcHardening\(session\)/);
});

test('Lua adapters publish disconnects and clear output during lifecycle changes', () => {
  const arc = read('web/lib/ingenue_arc.lua');
  const grid = read('web/lib/ingenue_grid_mod.lua');
  assert.match(arc, /virtual-arc-config/);
  assert.match(arc, /action == 'configure'/);
  assert.match(arc, /\/ingenue\/arc\/disconnect/);
  assert.match(arc, /script_post_cleanup/);
  assert.match(grid, /\/ingenue\/grid\/disconnect/);
  assert.match(grid, /for i=1,#frame\.values do frame\.values\[i\] = 0 end/);
});
