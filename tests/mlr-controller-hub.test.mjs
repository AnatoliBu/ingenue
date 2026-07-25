import test from 'node:test';
import assert from 'node:assert/strict';
import {buildControllerReadiness} from '../web/controllers-core.js';

test('controller hub exposes the specialized MLR surface only from authoritative capability and state', () => {
  const hello = {capabilities:{channels:['device','script','grid','mlr'],commands:['control.enc','control.key','grid.key'],mlr:{observer:true,version:'2.2.5'}}};
  const state = {status:'synced',data:{script:{active:true,name:'mlr',shortname:'mlr'},grid:{ports:{'2':{port:2,cols:16,rows:8,virtual:true}}},mlr:{active:true,version:'2.2.5'}}};
  const result = buildControllerReadiness({hello,state});
  const card = result.cards.find(item => item.id === 'mlr');
  assert.equal(card.href, './mlr.html');
  assert.equal(card.status, 'ready');
  assert.match(card.detail, /16×8 Grid attached/);
});
