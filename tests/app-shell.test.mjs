import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionPresentation} from '../web/app-shell.js';

test('application shell exposes explicit Maiden-style connection states',()=>{
  assert.deepEqual(connectionPresentation('connecting'),{state:'connecting',label:'connecting'});
  assert.deepEqual(connectionPresentation('subscribing'),{state:'subscribing',label:'subscribing'});
  assert.deepEqual(connectionPresentation('resyncing'),{state:'resyncing',label:'resyncing'});
  assert.deepEqual(connectionPresentation('reconnecting'),{state:'reconnecting',label:'reconnecting'});
  assert.deepEqual(connectionPresentation('disconnected'),{state:'disconnected',label:'disconnected'});
  assert.deepEqual(connectionPresentation('synced'),{state:'synced',label:'synced'});
  assert.deepEqual(connectionPresentation('synced',true),{state:'degraded',label:'degraded'});
});

test('unknown transient statuses fail closed as connecting',()=>{
  assert.deepEqual(connectionPresentation('made-up'),{state:'connecting',label:'connecting'});
  assert.deepEqual(connectionPresentation(null),{state:'connecting',label:'connecting'});
});
