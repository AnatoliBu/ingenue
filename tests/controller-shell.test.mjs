import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('all hardware command OSC paths converge on the shared Lua dispatcher', () => {
  const source = read('web/lib/ingenue_midi.lua');
  for (const route of ['/ingenue/command', '/ingenue/midi-command', '/ingenue/control-command']) {
    assert.match(source, new RegExp(route.replaceAll('/', '\\/')));
  }
  assert.match(source, /target == 'control'/);
  assert.match(source, /action == 'set'/);
  assert.match(source, /send\('\/ingenue\/ack', result\)/);
});

test('Grid handler accepts both key input and persistent configuration', () => {
  const source = read('web/lib/ingenue_grid_hardening.lua');
  assert.match(source, /action == 'key'/);
  assert.match(source, /dispatch_grid_key\(args\)/);
  assert.match(source, /action ~= 'configure'/);
  assert.match(source, /dispatcher\.register_handler\('grid', execute\)/);
});

test('every controller page mounts the shared navigation source', () => {
  const pages = {
    'web/controllers.html': 'controllers',
    'web/performance.html': 'performance',
    'web/launchpad.html': 'launchpad',
    'web/gamepad.html': 'gamepad',
    'web/params.html': 'params',
    'web/midi.html': 'midi',
    'web/realtime-inspector.html': 'inspector',
  };
  for (const [relative, current] of Object.entries(pages)) {
    const source = read(relative);
    assert.match(source, /shared-nav\.css/);
    assert.match(source, /shared-nav\.js/);
    assert.ok(source.includes(`data-ingenue-nav="${current}"`), relative);
  }
  const nav = read('web/shared-nav.js');
  for (const id of Object.values(pages)) assert.ok(nav.includes(`['${id}'`));
});

test('HTML patterns are compatible with the modern v-mode parser', () => {
  for (const relative of ['web/performance.html', 'web/realtime-inspector.html']) {
    const source = read(relative);
    assert.ok(!source.includes('pattern="[A-Za-z0-9_.:-]+"'));
    assert.ok(source.includes('pattern="[A-Za-z0-9_.:\\-]+"'));
  }
});

test('performance Grid is contained by its panel and scrolls internally', () => {
  const css = read('web/performance.css');
  assert.match(css, /\.panel \{ min-width: 0; overflow: hidden;/);
  assert.match(css, /\.grid-shell \{[^}]*max-width: 100%;[^}]*overflow: auto;/s);
  assert.match(css, /\.grid \{[^}]*min-width: 560px;[^}]*grid-template-columns:/s);
});
