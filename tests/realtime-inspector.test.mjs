import test from 'node:test';
import assert from 'node:assert/strict';
import {realtimeUrl} from '../web/realtime-inspector.js';
test('realtime URL follows the HTTP port by default',()=>assert.equal(realtimeUrl({protocol:'http:',hostname:'norns.local',port:'7777',search:''}),'ws://norns.local:7778/realtime'));
test('realtime URL supports explicit port and secure transport',()=>assert.equal(realtimeUrl({protocol:'https:',hostname:'norns.local',port:'443',search:'?rt=9000'}),'wss://norns.local:9000/realtime'));
