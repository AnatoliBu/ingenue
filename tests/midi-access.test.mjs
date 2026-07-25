import test from 'node:test';
import assert from 'node:assert/strict';
import {midiAvailability,midiBridgeDetails,midiPorts,requestMidiAccess} from '../web/midi-access.js';

test('availability distinguishes recoverable insecure and unsupported contexts',()=>{
  const insecure=midiAvailability(
    {requestMIDIAccess(){},platform:'Win32'},
    false,
    {hostname:'norns.local',port:'7777',search:'',origin:'http://norns.local:7777'},
  );
  assert.equal(insecure.code,'insecure');
  assert.equal(insecure.recoverable,true);
  assert.match(insecure.bridge.command,/Invoke-WebRequest/);
  assert.match(insecure.bridge.command,/py \$p/);
  assert.equal(midiAvailability({},true).code,'unsupported');
  assert.equal(midiAvailability({requestMIDIAccess(){}},true).ok,true);
});

test('bridge details generate a cwd-independent Windows launcher and repo alternative',()=>{
  const details=midiBridgeDetails(
    {hostname:'192.168.1.50',port:'8800',search:'?rt=9900',origin:'http://192.168.1.50:8800'},
    7780,
    {platform:'Win32'},
  );
  assert.equal(details.device,'192.168.1.50');
  assert.equal(details.httpPort,8800);
  assert.equal(details.realtimePort,9900);
  assert.match(details.url,/localhost:7780/);
  assert.match(details.url,/device=192\.168\.1\.50/);
  assert.match(details.command,/\$env:TEMP/);
  assert.match(details.command,/http:\/\/192\.168\.1\.50:8800\/midi-local\.py/);
  assert.match(details.repositoryCommand,/py web\\midi-local\.py/);
});

test('bridge details generate a temporary-file POSIX launcher',()=>{
  const details=midiBridgeDetails(
    {hostname:'norns.local',port:'7777',search:'',origin:'http://norns.local:7777'},
    7780,
    {platform:'Linux x86_64'},
  );
  assert.match(details.command,/curl -fsSL/);
  assert.match(details.command,/python3 "\$p"/);
  assert.match(details.repositoryCommand,/python3 web\/midi-local\.py/);
});

test('ports enumerate both inputs and outputs',()=>{const map=items=>new Map(items.map(x=>[x.id,x]));const ports=midiPorts({inputs:map([{id:'i',name:'Keys'}]),outputs:map([{id:'o',name:'Lights'}])});assert.equal(ports.inputs[0].name,'Keys');assert.equal(ports.outputs[0].id,'o');});
test('access requests no sysex or software synth privileges',async()=>{let options;await requestMidiAccess({requestMIDIAccess:async value=>{options=value;return {};}});assert.deepEqual(options,{sysex:false,software:false});});
