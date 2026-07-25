import {
  BuilderError,builderPresetKey,builderStorageKey,builderText,createBuilderWidget,defaultBuilderSchema,
  legacyBuilderStorageKey,normalizeBuilderWidget,
} from './builder-widget-schema.js';
import {normalizeBuilderSchema,parseBuilderSchema} from './builder-schema.js';

function templateWidget(type,id,patch={}){return normalizeBuilderWidget({...createBuilderWidget(type,id),...patch});}
export const BUILDER_TEMPLATES=Object.freeze([
  {id:'performance',name:'Performance',description:'K/E and parameter essentials'},
  {id:'grid-arc',name:'Grid + Arc',description:'Authoritative Grid and Arc instruments'},
  {id:'midi-keys',name:'MIDI keys',description:'MIDI note gates for K1–K3'},
  {id:'gamepad',name:'Gamepad',description:'Buttons, d-pad and analog axes'},
  {id:'mlr',name:'MLR companion',description:'16×8 Grid, focus controls and output level'},
]);
export function builderTemplate(script,templateId){
  const schema=defaultBuilderSchema(script);schema.metadata={source:'template',revision:String(templateId)};
  if(templateId==='performance'){
    schema.name=`${script} performance`;schema.columns=3;schema.widgets=[templateWidget('key','k1',{label:'K1'}),templateWidget('key','k2',{label:'K2',n:2}),templateWidget('key','k3',{label:'K3',n:3}),templateWidget('encoder','e2',{label:'E2',n:2}),templateWidget('encoder','e3',{label:'E3',n:3}),templateWidget('param','output',{label:'Output',paramId:'output_level',span:3})];
  }else if(templateId==='grid-arc'){
    schema.name=`${script} Grid + Arc`;schema.columns=3;schema.widgets=[templateWidget('grid','grid',{shape:'16x8',span:2}),templateWidget('arc','arc1',{ring:1}),templateWidget('arc','arc2',{ring:2})];
  }else if(templateId==='midi-keys'){
    schema.name=`${script} MIDI keys`;schema.columns=3;schema.widgets=[1,2,3].map((n,index)=>templateWidget('midi',`midi-k${n}`,{label:`MIDI K${n}`,source:{type:'note',channel:1,number:60+index},target:{kind:'key',n},mode:'gate'}));
  }else if(templateId==='gamepad'){
    schema.name=`${script} gamepad`;schema.columns=4;schema.widgets=['A','B','X','Y'].map(name=>templateWidget('gamepad',`pad-${name.toLowerCase()}`,{label:name,name}));schema.widgets.push(templateWidget('gamepad','pad-left',{label:'Left',control:'dpad',axis:'X',sign:-1}),templateWidget('gamepad','pad-right',{label:'Right',control:'dpad',axis:'X',sign:1}),templateWidget('gamepad','pad-stick',{label:'Left stick X',control:'analog',axis:'leftx',span:2}));
  }else if(templateId==='mlr'){
    schema.name='MLR companion';schema.columns=4;schema.widgets=[templateWidget('grid','mlr-grid',{label:'MLR 16×8',shape:'16x8',span:4}),templateWidget('key','mlr-k2',{label:'K2 view',n:2}),templateWidget('encoder','mlr-e2',{label:'E2',n:2}),templateWidget('encoder','mlr-e3',{label:'E3',n:3}),templateWidget('param','mlr-output',{label:'Output',paramId:'output_level'})];
  }else throw new BuilderError('builder template is unsupported');
  return normalizeBuilderSchema(schema,script);
}

export function schemaFromScriptMetadata(raw,script){
  const candidate=raw?.ingenue_ui??raw?.ingenueUI??raw?.ui_surface??raw;
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return null;
  try{
    const source={...candidate,script:candidate.script??script,metadata:{...(candidate.metadata||{}),source:'script'}};
    return normalizeBuilderSchema(source,script);
  }catch{return null;}
}

export class BuilderStore{
  constructor(storage){
    if(!storage||typeof storage.getItem!=='function'||typeof storage.setItem!=='function')throw new BuilderError('browser storage is unavailable');
    this.storage=storage;
  }
  has(script){return this.storage.getItem(builderStorageKey(script))!=null||this.storage.getItem(legacyBuilderStorageKey(script))!=null;}
  loadInfo(script){
    const fallback=defaultBuilderSchema(script);const current=this.storage.getItem(builderStorageKey(script));
    if(current!=null)return{schema:parseBuilderSchema(current,script),source:'local',exists:true,migrated:false};
    const legacy=this.storage.getItem(legacyBuilderStorageKey(script));
    if(legacy==null)return{schema:fallback,source:'default',exists:false,migrated:false};
    const schema=parseBuilderSchema(legacy,script);this.save(schema);return{schema,source:'migration',exists:true,migrated:true};
  }
  load(script){return this.loadInfo(script).schema;}
  save(schema){const normalized=normalizeBuilderSchema(schema,schema.script);this.storage.setItem(builderStorageKey(normalized.script),JSON.stringify(normalized));return normalized;}
  remove(script){this.storage.removeItem?.(builderStorageKey(script));this.storage.removeItem?.(legacyBuilderStorageKey(script));return defaultBuilderSchema(script);}
  listPresets(script){
    try{const value=JSON.parse(this.storage.getItem(builderPresetKey(script))||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort():[];}catch{return[];}
  }
  savePreset(name,schema){
    const normalizedName=builderText(name,'preset name',80);const normalized=normalizeBuilderSchema(schema,schema.script);let presets={};
    try{presets=JSON.parse(this.storage.getItem(builderPresetKey(normalized.script))||'{}');}catch{}
    if(!presets||typeof presets!=='object'||Array.isArray(presets))presets={};
    presets[normalizedName]={...normalized,metadata:{source:'preset',revision:normalizedName}};
    this.storage.setItem(builderPresetKey(normalized.script),JSON.stringify(presets));return normalizedName;
  }
  loadPreset(script,name){
    const normalizedName=builderText(name,'preset name',80);let presets={};try{presets=JSON.parse(this.storage.getItem(builderPresetKey(script))||'{}');}catch{}
    if(!presets?.[normalizedName])throw new BuilderError('preset was not found');return normalizeBuilderSchema(presets[normalizedName],script);
  }
  removePreset(script,name){
    const normalizedName=builderText(name,'preset name',80);let presets={};try{presets=JSON.parse(this.storage.getItem(builderPresetKey(script))||'{}');}catch{}
    if(!presets?.[normalizedName])throw new BuilderError('preset was not found');delete presets[normalizedName];this.storage.setItem(builderPresetKey(script),JSON.stringify(presets));return this.listPresets(script);
  }
}
