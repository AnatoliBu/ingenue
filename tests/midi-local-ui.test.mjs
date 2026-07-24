import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=relative=>fs.readFileSync(path.join(ROOT,relative),'utf8');

test('MIDI page exposes download command and localhost launch controls',()=>{
  const html=read('web/midi.html');
  for(const id of ['midi-bridge','midi-bridge-command','midi-bridge-copy','midi-bridge-open'])assert.ok(html.includes(`id="${id}"`));
  assert.match(html,/midi-local\.py/);
});

test('MIDI surface renders recoverable context instead of a dead-end error',()=>{
  const source=read('web/midi-surface.js');
  assert.match(source,/configureBridge\(availability\)/);
  assert.match(source,/availability\.bridge\.command/);
  assert.match(source,/availability\.bridge\.url/);
});

test('localhost helper stays read-only and loopback-bound',()=>{
  const source=read('web/midi-local.py');
  assert.match(source,/\("127\.0\.0\.1", config\.local_port\)/);
  assert.match(source,/def do_POST/);
  assert.match(source,/send_error\(405/);
  assert.doesNotMatch(source,/0\.0\.0\.0/);
});
