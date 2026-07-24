import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=relative=>fs.readFileSync(path.join(ROOT,relative),'utf8');

test('builder page exposes editor preview palette and JSON lifecycle',()=>{
  const html=read('web/builder.html');
  for(const id of [
    'builder-name','builder-columns','builder-editor','builder-preview','builder-json',
    'builder-export','builder-copy','builder-download','builder-import','builder-reset',
  ]) assert.ok(html.includes(`id="${id}"`),`missing ${id}`);
  for(const type of ['key','encoder','param','label','spacer'])assert.ok(html.includes(`data-add-widget="${type}"`));
  assert.match(html,/mountBuilderSurface\(\)/);
});

test('builder preview uses existing Lua-applied commands and safe hold cleanup',()=>{
  const source=read('web/builder-surface.js');
  assert.match(source,/target: 'control', action: 'key'/);
  assert.match(source,/target: 'control', action: 'enc'/);
  assert.match(source,/target: 'param', action: 'set_normalized'/);
  assert.match(source,/new PressLedger/);
  assert.match(source,/pagehide/);
  assert.match(source,/visibilitychange/);
  assert.match(source,/detail\.result\?\.param/);
});

test('builder never injects imported labels as HTML',()=>{
  const source=read('web/builder-surface.js');
  assert.doesNotMatch(source,/innerHTML/);
  assert.match(source,/textContent = widget\.label/);
});
