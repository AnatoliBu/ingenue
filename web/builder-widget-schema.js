export const BUILDER_SCHEMA_VERSION = 2;
export const BUILDER_WIDGET_LIMIT = 64;
export const BUILDER_STORAGE_PREFIX = 'ingenue.builder.v2:';
export const BUILDER_LEGACY_STORAGE_PREFIX = 'ingenue.builder.v1:';
export const BUILDER_PRESET_PREFIX = 'ingenue.builder.presets.v1:';

const WIDGET_TYPES = new Set(['key','encoder','param','label','spacer','grid','arc','midi','gamepad']);
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
export const PARAM_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const GRID_SHAPES = new Set(['8x8','16x8','16x16']);
const MIDI_SOURCE_TYPES = new Set(['note','cc','pitchbend']);
const MIDI_TARGET_TYPES = new Set(['key','encoder','param']);
const MIDI_MODES = new Set(['gate','absolute','relative-twos','relative-offset','relative-sign']);
const GAMEPAD_CONTROLS = new Set(['button','dpad','analog']);
const GAMEPAD_BUTTONS = new Set(['A','B','X','Y','LB','RB','L3','R3','SELECT','START']);
const GAMEPAD_ANALOG = new Set(['leftx','lefty','rightx','righty','triggerleft','triggerright']);

export class BuilderError extends Error {}

export function builderObject(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new BuilderError(`${label} must be an object`);
  return value;
}
export function builderText(value,label,max,{empty=false}={}){
  const result=String(value??'').trim();
  if((!empty&&!result)||result.length>max)throw new BuilderError(`${label} is invalid`);
  return result;
}
export function builderInteger(value,label,low,high){
  const result=Number(value);
  if(!Number.isSafeInteger(result)||result<low||result>high)throw new BuilderError(`${label} must be an integer between ${low} and ${high}`);
  return result;
}
function finite(value,label,low,high){
  const result=Number(value);
  if(!Number.isFinite(result)||result<low||result>high)throw new BuilderError(`${label} must be between ${low} and ${high}`);
  return result;
}
function bool(value){return value!==false;}
function safeId(value,label='widget id'){
  const result=String(value??'');
  if(!SAFE_ID.test(result))throw new BuilderError(`${label} is invalid`);
  return result;
}
export function builderNormalizeMetadata(raw,source='local'){
  if(raw==null)return {source,revision:null};
  const value=builderObject(raw,'schema metadata');
  const normalizedSource=['local','script','template','preset','import','migration'].includes(String(value.source))?String(value.source):source;
  const revision=value.revision==null?null:builderText(value.revision,'metadata revision',128);
  return {source:normalizedSource,revision};
}

export function builderStorageKey(script){return `${BUILDER_STORAGE_PREFIX}${encodeURIComponent(builderText(script,'script name',256))}`;}
export function legacyBuilderStorageKey(script){return `${BUILDER_LEGACY_STORAGE_PREFIX}${encodeURIComponent(builderText(script,'script name',256))}`;}
export function builderPresetKey(script){return `${BUILDER_PRESET_PREFIX}${encodeURIComponent(builderText(script,'script name',256))}`;}

export function defaultBuilderSchema(script){
  const name=builderText(script,'script name',256);
  return {version:BUILDER_SCHEMA_VERSION,script:name,name:`${name} controls`,columns:2,metadata:{source:'local',revision:null},widgets:[]};
}

function midiSource(raw={}){
  const source=builderObject(raw,'MIDI source');
  const type=String(source.type??'note');
  if(!MIDI_SOURCE_TYPES.has(type))throw new BuilderError('MIDI source type is unsupported');
  const channel=builderInteger(source.channel??1,'MIDI channel',1,16);
  const number=type==='pitchbend'?null:builderInteger(source.number??0,'MIDI number',0,127);
  return {type,channel,number};
}
function midiTarget(raw={}){
  const target=builderObject(raw,'MIDI target');
  const kind=String(target.kind??'key');
  if(!MIDI_TARGET_TYPES.has(kind))throw new BuilderError('MIDI target is unsupported');
  if(kind==='key')return {kind,n:builderInteger(target.n??1,'key number',1,3)};
  if(kind==='encoder')return {kind,n:builderInteger(target.n??1,'encoder number',1,3)};
  const id=String(target.id??target.paramId??'');
  if(!PARAM_ID.test(id))throw new BuilderError('MIDI parameter id is invalid');
  return {kind,id};
}
function midiMode(source,target,value){
  const fallback=target.kind==='key'?'gate':target.kind==='param'?'absolute':'relative-twos';
  const mode=String(value??fallback);
  if(!MIDI_MODES.has(mode))throw new BuilderError('MIDI mode is unsupported');
  if(target.kind==='key'&&mode!=='gate')throw new BuilderError('key MIDI target requires gate mode');
  if(target.kind==='encoder'&&!mode.startsWith('relative-'))throw new BuilderError('encoder MIDI target requires relative mode');
  if(source.type!=='cc'&&mode.startsWith('relative-'))throw new BuilderError('relative MIDI modes require CC input');
  return mode;
}

export function createBuilderWidget(type,id){
  const normalizedType=String(type??'');
  if(!WIDGET_TYPES.has(normalizedType))throw new BuilderError('widget type is unsupported');
  const base={id:safeId(id),type:normalizedType,span:1};
  if(normalizedType==='key')return {...base,label:'K1',n:1};
  if(normalizedType==='encoder')return {...base,label:'E1',n:1,step:1};
  if(normalizedType==='param')return {...base,label:'Parameter',paramId:'cutoff',step:.01};
  if(normalizedType==='label')return {...base,label:'Section',span:2};
  if(normalizedType==='grid')return {...base,label:'Grid',port:1,shape:'8x8',span:2};
  if(normalizedType==='arc')return {...base,label:'Arc 1',port:1,ring:1,sensitivity:4};
  if(normalizedType==='midi')return {...base,label:'MIDI K1',source:{type:'note',channel:1,number:60},target:{kind:'key',n:1},mode:'gate',pickup:false};
  if(normalizedType==='gamepad')return {...base,label:'A',control:'button',name:'A'};
  return base;
}

export function normalizeBuilderWidget(raw){
  const source=builderObject(raw,'widget');
  const id=safeId(source.id);
  const type=String(source.type??'');
  if(!WIDGET_TYPES.has(type))throw new BuilderError('widget type is unsupported');
  const span=builderInteger(source.span??1,'widget span',1,4);
  if(type==='key')return{id,type,span,label:builderText(source.label??`K${source.n??1}`,'key label',80),n:builderInteger(source.n,'key number',1,3)};
  if(type==='encoder')return{id,type,span,label:builderText(source.label??`E${source.n??1}`,'encoder label',80),n:builderInteger(source.n,'encoder number',1,3),step:builderInteger(source.step??1,'encoder step',1,64)};
  if(type==='param'){
    const paramId=String(source.paramId??source.param_id??'');
    if(!PARAM_ID.test(paramId))throw new BuilderError('parameter id is invalid');
    return{id,type,span,label:builderText(source.label??paramId,'parameter label',80),paramId,step:finite(source.step??.01,'parameter step',.0001,1)};
  }
  if(type==='label')return{id,type,span,label:builderText(source.label,'label text',500)};
  if(type==='spacer')return{id,type,span};
  if(type==='grid'){
    const shape=String(source.shape??'8x8').toLowerCase();
    if(!GRID_SHAPES.has(shape))throw new BuilderError('Grid shape must be 8×8, 16×8 or 16×16');
    return{id,type,span,label:builderText(source.label??'Grid','Grid label',80),port:builderInteger(source.port??1,'Grid port',1,4),shape};
  }
  if(type==='arc')return{id,type,span,label:builderText(source.label??`Arc ${source.ring??1}`,'Arc label',80),port:builderInteger(source.port??1,'Arc port',1,4),ring:builderInteger(source.ring??1,'Arc ring',1,4),sensitivity:builderInteger(source.sensitivity??4,'Arc sensitivity',1,32)};
  if(type==='midi'){
    const parsedSource=midiSource(source.source??{});
    const target=midiTarget(source.target??{});
    return{id,type,span,label:builderText(source.label??'MIDI','MIDI label',80),source:parsedSource,target,mode:midiMode(parsedSource,target,source.mode),pickup:target.kind==='param'?bool(source.pickup):false};
  }
  const control=String(source.control??'button');
  if(!GAMEPAD_CONTROLS.has(control))throw new BuilderError('gamepad control is unsupported');
  const base={id,type,span,label:builderText(source.label??'Gamepad','gamepad label',80),control};
  if(control==='button'){
    const name=String(source.name??'A').toUpperCase();
    if(!GAMEPAD_BUTTONS.has(name))throw new BuilderError('gamepad button is unsupported');
    return{...base,name};
  }
  if(control==='dpad')return{...base,axis:['X','Y'].includes(String(source.axis).toUpperCase())?String(source.axis).toUpperCase():'X',sign:builderInteger(source.sign??1,'d-pad sign',-1,1)||1};
  const axis=String(source.axis??'leftx').toLowerCase();
  if(!GAMEPAD_ANALOG.has(axis))throw new BuilderError('gamepad analog axis is unsupported');
  return{...base,axis,step:finite(source.step??.1,'gamepad analog step',.01,1)};
}
