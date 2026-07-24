import test from 'node:test';
import assert from 'node:assert/strict';
import {realtimeHost,realtimeUrl} from '../web/realtime-inspector.js';
test('realtime URL follows the HTTP port by default',()=>assert.equal(realtimeUrl({protocol:'http:',hostname:'norns.local',port:'7777',search:''}),'ws://norns.local:7778/realtime'));
test('realtime URL supports explicit port and secure transport',()=>assert.equal(realtimeUrl({protocol:'https:',hostname:'norns.local',port:'443',search:'?rt=9000'}),'wss://norns.local:9000/realtime'));
test('localhost-served UI can connect realtime directly to norns',()=>assert.equal(realtimeUrl({protocol:'http:',hostname:'localhost',port:'7780',search:'?device=norns.local&rt=7778'}),'ws://norns.local:7778/realtime'));
test('invalid device override falls back to the page host',()=>{assert.equal(realtimeHost('user@example.com','localhost'),'localhost');assert.equal(realtimeUrl({protocol:'http:',hostname:'localhost',port:'7780',search:'?device=http%3A%2F%2Fevil.test&rt=7778'}),'ws://localhost:7778/realtime');});
