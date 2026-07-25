import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDER_SCHEMA_VERSION,BuilderStore,appendBuilderWidget,builderTemplate,createBuilderWidget,
  defaultBuilderSchema,migrateBuilderSchema,normalizeBuilderSchema,schemaFromScriptMetadata,
} from '../web/builder-core.js';
class MemoryStorage{constructor(){this.values=new Map();}getItem(k){return this.values.has(k)?this.values.get(k):null;}setItem(k,v){this.values.set(k,String(v));}removeItem(k){this.values.delete(k);}}

test('v1 schemas migrate without losing native widgets',()=>{
  const migrated=migrateBuilderSchema({version:1,script:'awake',name:'Old',columns:2,widgets:[{id:'k',type:'key',span:1,label:'Freeze',n:2}]},'awake');
  assert.equal(migrated.version,BUILDER_SCHEMA_VERSION);assert.equal(migrated.widgets[0].n,2);assert.equal(migrated.metadata.source,'migration');
});

test('advanced widgets normalize exact runtime contracts',()=>{
  let schema=defaultBuilderSchema('mlr');
  for(const type of ['grid','arc','midi','gamepad'])schema=appendBuilderWidget(schema,createBuilderWidget(type,type));
  const normalized=normalizeBuilderSchema(schema,'mlr');
  assert.deepEqual(normalized.widgets.map(w=>w.type),['grid','arc','midi','gamepad']);
  assert.equal(normalized.widgets[0].shape,'8x8');assert.equal(normalized.widgets[2].target.kind,'key');assert.equal(normalized.widgets[3].name,'A');
});

test('templates and script metadata are exact-script and versioned',()=>{
  const mlr=builderTemplate('mlr','mlr');assert.equal(mlr.widgets[0].shape,'16x8');assert.equal(mlr.metadata.source,'template');
  const metadata=schemaFromScriptMetadata({...mlr,script:'mlr'},'mlr');assert.equal(metadata.metadata.source,'script');
  assert.equal(schemaFromScriptMetadata({...mlr,script:'awake'},'mlr'),null);
});

test('store migrates legacy layouts and manages named presets per script',()=>{
  const storage=new MemoryStorage();
  storage.setItem('ingenue.builder.v1:awake',JSON.stringify({version:1,script:'awake',name:'Legacy',columns:1,widgets:[]}));
  const store=new BuilderStore(storage);const info=store.loadInfo('awake');assert.equal(info.migrated,true);assert.equal(info.schema.version,2);
  store.savePreset('live',builderTemplate('awake','performance'));assert.deepEqual(store.listPresets('awake'),['live']);assert.equal(store.loadPreset('awake','live').metadata.source,'preset');
  store.removePreset('awake','live');assert.deepEqual(store.listPresets('awake'),[]);
});
