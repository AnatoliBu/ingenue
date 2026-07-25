import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=relative=>fs.readFileSync(path.join(ROOT,relative),'utf8');

test('every shared-navigation surface installs the quality contract and exposes MLR',()=>{
  const source=read('web/shared-nav.js');
  assert.match(source,/installQualityContract/);
  assert.match(source,/\['mlr', '\.\/mlr\.html', 'MLR'\]/);
  assert.match(source,/installQualityContract\(root, globalThis\)/);
});

test('quality styles preserve focus, touch and reduced-motion contracts',()=>{
  const css=read('web/quality-contract.css');
  assert.match(css,/--ingenue-control-height:36px/);
  assert.match(css,/--ingenue-control-height:44px/);
  assert.match(css,/:focus-visible/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/transition-duration:\.001ms/);
});

test('quality code uses bounded diagnostics and no dynamic execution',()=>{
  const source=read('web/quality-contract.js');
  assert.match(source,/eventLimit/);
  assert.match(source,/queue\?\.size/);
  assert.match(source,/measureCommandLatency/);
  assert.doesNotMatch(source,/\beval\s*\(/);
  assert.doesNotMatch(source,/new Function/);
  assert.doesNotMatch(source,/innerHTML/);
});

test('documentation keeps physical Shield acceptance outside fixture claims',()=>{
  const quality=read('docs/QUALITY-CONTRACT.md');
  const shield=read('docs/SHIELD-ACCEPTANCE.md');
  assert.match(quality,/cannot certify audible softcut timing/i);
  assert.match(shield,/must not be described as fully validated on Shield/i);
  assert.match(shield,/Sixty-minute soak/);
  assert.match(shield,/MLR 2\.2\.5/);
});
