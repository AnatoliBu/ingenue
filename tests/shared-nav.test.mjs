import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeNavigationSearch} from '../web/shared-nav.js';

test('localhost bridge navigation preserves the authoritative norns target',()=>{
  const search=bridgeNavigationSearch({search:'?device=norns.local&rt=7778&bridge=localhost&ignored=value'});
  const params=new URLSearchParams(search);
  assert.equal(params.get('device'),'norns.local');
  assert.equal(params.get('rt'),'7778');
  assert.equal(params.get('bridge'),'localhost');
  assert.equal(params.has('ignored'),false);
});

test('ordinary navigation does not gain bridge parameters',()=>{
  assert.equal(bridgeNavigationSearch({search:''}),'');
  assert.equal(bridgeNavigationSearch({search:'?device=norns.local&rt=7778'}),'');
});

test('malformed bridge targets are not propagated',()=>{
  assert.equal(bridgeNavigationSearch({search:'?device=norns.local/path&rt=7778&bridge=localhost'}),'');
  assert.equal(bridgeNavigationSearch({search:'?device=norns.local&rt=70000&bridge=localhost'}),'');
});
