import {
  BUILDER_SCHEMA_VERSION,BUILDER_WIDGET_LIMIT,BuilderError,PARAM_ID,builderInteger,builderNormalizeMetadata,
  builderObject,builderText,normalizeBuilderWidget,
} from './builder-widget-schema.js';

function normalizeV2(raw,expectedScript=null,metadataSource='local'){
  const source=builderObject(raw,'builder schema');
  const script=builderText(source.script,'script name',256);
  if(expectedScript!=null&&script!==String(expectedScript))throw new BuilderError(`schema belongs to ${script}, not ${expectedScript}`);
  const name=builderText(source.name,'surface name',120);
  const columns=builderInteger(source.columns,'column count',1,4);
  if(!Array.isArray(source.widgets)||source.widgets.length>BUILDER_WIDGET_LIMIT)throw new BuilderError(`widgets must be an array with at most ${BUILDER_WIDGET_LIMIT} items`);
  const widgets=source.widgets.map(normalizeBuilderWidget);
  const ids=new Set();
  for(const widget of widgets){
    if(ids.has(widget.id))throw new BuilderError(`duplicate widget id: ${widget.id}`);
    ids.add(widget.id);widget.span=Math.min(widget.span,columns);
  }
  return{version:BUILDER_SCHEMA_VERSION,script,name,columns,metadata:builderNormalizeMetadata(source.metadata,metadataSource),widgets};
}

export function migrateBuilderSchema(raw,expectedScript=null){
  const source=builderObject(raw,'builder schema');
  const version=Number(source.version);
  if(version===BUILDER_SCHEMA_VERSION)return normalizeV2(source,expectedScript);
  if(version===1){
    return normalizeV2({...source,version:BUILDER_SCHEMA_VERSION,metadata:{source:'migration',revision:'v1'}},expectedScript,'migration');
  }
  throw new BuilderError(`schema version ${source.version} is unsupported`);
}
export function normalizeBuilderSchema(raw,expectedScript=null){return migrateBuilderSchema(raw,expectedScript);}
function normalizedCopy(schema){return normalizeBuilderSchema(structuredClone(schema),schema.script);}

export function appendBuilderWidget(schema,widget){
  const next=normalizedCopy(schema);
  if(next.widgets.length>=BUILDER_WIDGET_LIMIT)throw new BuilderError('widget limit reached');
  const normalized=normalizeBuilderWidget(widget);
  if(next.widgets.some(item=>item.id===normalized.id))throw new BuilderError('widget id already exists');
  normalized.span=Math.min(normalized.span,next.columns);next.widgets.push(normalized);return next;
}
export function updateBuilderWidget(schema,widgetId,patch){
  const next=normalizedCopy(schema);const index=next.widgets.findIndex(item=>item.id===widgetId);
  if(index<0)throw new BuilderError('widget was not found');
  next.widgets[index]=normalizeBuilderWidget({...next.widgets[index],...builderObject(patch,'widget patch'),id:widgetId});
  next.widgets[index].span=Math.min(next.widgets[index].span,next.columns);return next;
}
export function removeBuilderWidget(schema,widgetId){
  const next=normalizedCopy(schema);const before=next.widgets.length;next.widgets=next.widgets.filter(item=>item.id!==widgetId);
  if(next.widgets.length===before)throw new BuilderError('widget was not found');return next;
}
export function moveBuilderWidget(schema,widgetId,direction){
  const next=normalizedCopy(schema);const index=next.widgets.findIndex(item=>item.id===widgetId);
  if(index<0)throw new BuilderError('widget was not found');const offset=direction==='up'?-1:direction==='down'?1:0;
  if(!offset)throw new BuilderError('move direction must be up or down');const target=index+offset;
  if(target<0||target>=next.widgets.length)return next;[next.widgets[index],next.widgets[target]]=[next.widgets[target],next.widgets[index]];return next;
}
export function updateBuilderLayout(schema,patch){
  const next=normalizedCopy(schema);const source=builderObject(patch,'layout patch');
  if(Object.hasOwn(source,'name'))next.name=builderText(source.name,'surface name',120);
  if(Object.hasOwn(source,'columns'))next.columns=builderInteger(source.columns,'column count',1,4);
  next.widgets=next.widgets.map(widget=>({...widget,span:Math.min(widget.span,next.columns)}));return normalizeBuilderSchema(next,next.script);
}
export function serializeBuilderSchema(schema){return JSON.stringify(normalizeBuilderSchema(schema,schema.script),null,2);}
export function parseBuilderSchema(serialized,expectedScript){
  let parsed;try{parsed=JSON.parse(String(serialized));}catch(error){throw new BuilderError(`schema JSON is invalid: ${error.message}`);}
  return normalizeBuilderSchema(parsed,expectedScript);
}
export function writableParameterOptions(rawCatalog){
  const items=Array.isArray(rawCatalog?.items)?rawCatalog.items:[];
  return items.filter(item=>item&&item.writable&&typeof item.id==='string'&&PARAM_ID.test(item.id)).map(item=>({id:item.id,name:String(item.name||item.id),normalized:Number(item.normalized)}));
}
