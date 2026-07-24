import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BuilderStore,
  appendBuilderWidget,
  builderStorageKey,
  createBuilderWidget,
  defaultBuilderSchema,
  moveBuilderWidget,
  normalizeBuilderSchema,
  parseBuilderSchema,
  removeBuilderWidget,
  serializeBuilderSchema,
  updateBuilderLayout,
  updateBuilderWidget,
  writableParameterOptions,
} from '../web/builder-core.js';

class MemoryStorage {
  constructor(){this.values=new Map();}
  getItem(key){return this.values.has(key)?this.values.get(key):null;}
  setItem(key,value){this.values.set(key,String(value));}
  removeItem(key){this.values.delete(key);}
}

test('builder schema composes native controls and clamps spans to layout',()=>{
  let schema=defaultBuilderSchema('awake');
  schema=appendBuilderWidget(schema,createBuilderWidget('key','w-key'));
  schema=appendBuilderWidget(schema,createBuilderWidget('encoder','w-enc'));
  schema=appendBuilderWidget(schema,createBuilderWidget('param','w-param'));
  schema=updateBuilderWidget(schema,'w-key',{n:3,label:'Freeze',span:2});
  schema=updateBuilderWidget(schema,'w-enc',{n:2,step:8,label:'Density'});
  schema=updateBuilderWidget(schema,'w-param',{paramId:'filter.cutoff',step:.005,label:'Cutoff'});
  schema=updateBuilderLayout(schema,{name:'Awake live',columns:1});
  assert.equal(schema.name,'Awake live');
  assert.equal(schema.widgets[0].n,3);
  assert.equal(schema.widgets[1].step,8);
  assert.equal(schema.widgets[2].paramId,'filter.cutoff');
  assert.ok(schema.widgets.every(widget=>widget.span===1));
});

test('reordering and removal preserve normalized widget identity',()=>{
  let schema=defaultBuilderSchema('mlr');
  schema=appendBuilderWidget(schema,createBuilderWidget('label','one'));
  schema=appendBuilderWidget(schema,createBuilderWidget('spacer','two'));
  schema=appendBuilderWidget(schema,createBuilderWidget('key','three'));
  schema=moveBuilderWidget(schema,'three','up');
  assert.deepEqual(schema.widgets.map(widget=>widget.id),['one','three','two']);
  schema=removeBuilderWidget(schema,'one');
  assert.deepEqual(schema.widgets.map(widget=>widget.id),['three','two']);
});

test('imports are exact-script and reject malformed or duplicate widgets',()=>{
  const source={...defaultBuilderSchema('awake'),widgets:[createBuilderWidget('key','same'),createBuilderWidget('key','same')]};
  assert.throws(()=>normalizeBuilderSchema(source),/duplicate/);
  const valid=serializeBuilderSchema({...defaultBuilderSchema('awake'),widgets:[createBuilderWidget('key','key-1')]});
  assert.equal(parseBuilderSchema(valid,'awake').widgets.length,1);
  assert.throws(()=>parseBuilderSchema(valid,'mlr'),/belongs to awake/);
  assert.throws(()=>parseBuilderSchema('{oops','awake'),/JSON is invalid/);
});

test('store isolates layouts by active script and can reset one layout',()=>{
  const storage=new MemoryStorage();
  const store=new BuilderStore(storage);
  const awake=appendBuilderWidget(defaultBuilderSchema('awake'),createBuilderWidget('key','awake-key'));
  const mlr=appendBuilderWidget(defaultBuilderSchema('mlr'),createBuilderWidget('encoder','mlr-encoder'));
  store.save(awake);store.save(mlr);
  assert.equal(store.load('awake').widgets[0].id,'awake-key');
  assert.equal(store.load('mlr').widgets[0].id,'mlr-encoder');
  assert.notEqual(builderStorageKey('awake'),builderStorageKey('mlr'));
  assert.equal(store.remove('awake').widgets.length,0);
  assert.equal(store.load('mlr').widgets.length,1);
});

test('parameter palette includes only valid writable parameters',()=>{
  const options=writableParameterOptions({items:[
    {id:'cutoff',name:'Cutoff',writable:true,normalized:.5},
    {id:'heading',name:'Heading',writable:false,normalized:0},
    {id:'bad id',name:'Bad',writable:true,normalized:0},
  ]});
  assert.deepEqual(options,[{id:'cutoff',name:'Cutoff',normalized:.5}]);
});
