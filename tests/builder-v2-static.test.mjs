import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8');

test('Builder v2 exposes advanced palette, templates, presets and MIDI activation',()=>{
  const html=read('web/builder.html');
  for(const type of ['grid','arc','midi','gamepad'])assert.match(html,new RegExp(`data-add-widget="${type}"`));
  for(const id of ['builder-template','builder-template-apply','builder-preset','builder-preset-save','builder-midi-enable'])assert.ok(html.includes(`id="${id}"`));
  assert.match(html,/builder-v2\.css/);
});

test('advanced previews use fixed typed runtime commands and lifecycle cleanup',()=>{
  const source=['web/builder-surface.js','web/builder-preview-devices.js','web/builder-midi-runtime.js'].map(read).join('\n');
  for(const contract of ["makeLedger('grid','key'","target:'arc',action:'delta'","makeLedger('gamepad','button'","target:'gamepad',action:'dpad'","target:'gamepad',action:'analog'"])assert.ok(source.includes(contract),contract);
  assert.match(source,/BuilderMidiRuntime/);assert.match(source,/releaseEverything/);assert.match(source,/pagehide/);assert.match(source,/visibilitychange/);assert.doesNotMatch(source,/innerHTML/);
});
