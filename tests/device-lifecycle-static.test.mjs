import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8');

test('gamepad page mounts physical lifecycle bridge beside the touch surface',()=>{
  const html=read('web/gamepad.html');
  assert.match(html,/gamepad-physical-status/);
  assert.match(html,/mountPhysicalGamepad\(session\)/);
  assert.match(read('web/gamepad-physical.js'),/BrowserGamepadRuntime/);
});

test('MIDI and gamepad lifecycle contract is documented and avoids guessed layouts',()=>{
  const docs=read('docs/DEVICE-LIFECYCLE.md');
  assert.match(docs,/held mapped keys/);
  assert.match(docs,/W3C standard gamepad mapping/);
  const api=read('web/gamepad-api.js');
  assert.match(api,/mapping==='standard'/);
  assert.match(api,/releaseAll\(\)/);
});
