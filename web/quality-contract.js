export const QUALITY_BUDGETS=Object.freeze({
  desktopTouchPx:36,
  mobileTouchPx:44,
  mobileBreakpointPx:640,
  normalContrast:4.5,
  frameP95Ms:50,
  frameMaxMs:150,
  commandP95Ms:250,
  commandMaxMs:750,
  reconnectCycles:8,
});

const COMPACT_SELECTOR=[
  '.grid-key','.builder-grid-pad','.launchpad-pad','.mlr-pad','.arc-leds','.builder-arc-ring circle',
  '[data-ingenue-compact]','input[type="range"]','input[type="checkbox"]','input[type="radio"]',
].join(',');
const INTERACTIVE_SELECTOR='button,a[href],input,select,textarea,[role="button"],[tabindex]';

function injectStylesheet(root){
  let link=root.querySelector('link[data-ingenue-quality]');
  if(!link){
    link=root.createElement('link');link.rel='stylesheet';link.href='./quality-contract.css';link.dataset.ingenueQuality='true';root.head?.append(link);
  }
  if(link.sheet)return Promise.resolve(link);
  return new Promise(resolve=>{
    const done=()=>resolve(link);
    link.addEventListener('load',done,{once:true});
    link.addEventListener('error',done,{once:true});
  });
}

function visible(globalLike,node){const style=globalLike.getComputedStyle?.(node);if(!style||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return false;const rect=node.getBoundingClientRect?.();return Boolean(rect&&rect.width>0&&rect.height>0);}
function parseColor(value){
  const source=String(value||'').trim();
  const hex=source.match(/^#([0-9a-f]{6})$/i);if(hex){const raw=hex[1];return[0,2,4].map(index=>Number.parseInt(raw.slice(index,index+2),16));}
  const rgb=source.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);return rgb?[Number(rgb[1]),Number(rgb[2]),Number(rgb[3])]:null;
}
function channel(value){const normalized=value/255;return normalized<=.04045?normalized/12.92:((normalized+.055)/1.055)**2.4;}
export function relativeLuminance(color){const rgb=Array.isArray(color)?color:parseColor(color);if(!rgb||rgb.length<3)throw new TypeError('color must be an RGB array or CSS RGB/hex string');return .2126*channel(rgb[0])+.7152*channel(rgb[1])+.0722*channel(rgb[2]);}
export function contrastRatio(left,right){const a=relativeLuminance(left),b=relativeLuminance(right);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
export function percentile(values,quantile){if(!Array.isArray(values)||!values.length)throw new TypeError('values are required');const sorted=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);if(!sorted.length)throw new TypeError('finite values are required');const index=Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*Number(quantile))-1));return sorted[index];}

function recordFor(node){const rect=node.getBoundingClientRect();return{tag:node.tagName.toLowerCase(),id:node.id||null,className:String(node.className||''),label:String(node.getAttribute('aria-label')||node.getAttribute('title')||node.textContent||'').trim().slice(0,80),width:Number(rect.width.toFixed(2)),height:Number(rect.height.toFixed(2))};}
export function interactiveTargetReport(root=document,globalLike=globalThis){
  const minimum=(globalLike.innerWidth||0)<=QUALITY_BUDGETS.mobileBreakpointPx?QUALITY_BUDGETS.mobileTouchPx:QUALITY_BUDGETS.desktopTouchPx;
  const targets=[];for(const node of root.querySelectorAll(INTERACTIVE_SELECTOR)){
    if(node.disabled||node.matches?.(COMPACT_SELECTOR)||node.closest?.(COMPACT_SELECTOR)||!visible(globalLike,node))continue;
    targets.push(recordFor(node));
  }
  return{minimum,targets,violations:targets.filter(item=>item.width<minimum||item.height<minimum)};
}
function accessibleLabel(root,node){
  const direct=String(node.getAttribute('aria-label')||node.getAttribute('title')||'').trim();if(direct)return direct;
  const labelledBy=String(node.getAttribute('aria-labelledby')||'').trim();if(labelledBy){const value=labelledBy.split(/\s+/).map(id=>root.getElementById(id)?.textContent||'').join(' ').trim();if(value)return value;}
  if(node.labels?.length){const value=[...node.labels].map(label=>label.textContent||'').join(' ').trim();if(value)return value;}
  if(node.tagName==='BUTTON'||node.tagName==='A'){const value=String(node.textContent||'').trim();if(value)return value;}
  return String(node.getAttribute('placeholder')||node.getAttribute('alt')||'').trim();
}
export function accessibleNameReport(root=document,globalLike=globalThis){
  const targets=[];for(const node of root.querySelectorAll(INTERACTIVE_SELECTOR)){
    if(node.disabled||!visible(globalLike,node))continue;
    const record=recordFor(node);record.accessibleName=accessibleLabel(root,node);targets.push(record);
  }
  return{targets,violations:targets.filter(item=>!item.accessibleName)};
}

const CONTEXT_LABELS=Object.freeze({
  'param-id':'Parameter id',
  'param-value':'Parameter value',
});
function contextualAccessibleLabel(node){
  if(node.id&&CONTEXT_LABELS[node.id])return CONTEXT_LABELS[node.id];
  const card=node.closest?.('.param-card');
  const name=String(card?.querySelector?.('header strong')?.textContent||'').trim();
  if(name)return `${name} parameter`;
  return '';
}
export function repairAccessibleNames(root=document){
  let repaired=0;
  for(const node of root.querySelectorAll(INTERACTIVE_SELECTOR)){
    if(accessibleLabel(root,node))continue;
    const label=contextualAccessibleLabel(node);
    if(!label)continue;
    node.setAttribute('aria-label',label);repaired+=1;
  }
  return repaired;
}
function token(root,globalLike,name,fallback){const value=globalLike.getComputedStyle(root.documentElement).getPropertyValue(name).trim();return value||fallback;}
export function contrastReport(root=document,globalLike=globalThis){
  const colors={bg:token(root,globalLike,'--ingenue-bg','#08090b'),panel:token(root,globalLike,'--ingenue-panel','#101310'),text:token(root,globalLike,'--ingenue-text','#eef4e9'),muted:token(root,globalLike,'--ingenue-muted','#98a394'),accent:token(root,globalLike,'--ingenue-accent','#d9ff5b'),danger:token(root,globalLike,'--ingenue-danger','#ff8b78')};
  const pairs=[['text/bg',colors.text,colors.bg],['muted/bg',colors.muted,colors.bg],['text/panel',colors.text,colors.panel],['accent/bg',colors.accent,colors.bg],['danger/bg',colors.danger,colors.bg]].map(([name,foreground,background])=>({name,foreground,background,ratio:Number(contrastRatio(foreground,background).toFixed(3))}));
  return{colors,pairs,violations:pairs.filter(pair=>pair.ratio<QUALITY_BUDGETS.normalContrast)};
}
export function qualitySnapshot(root=document,globalLike=globalThis){
  const session=globalLike.ingenueDebug?.latest||null,interactive=interactiveTargetReport(root,globalLike),accessible=accessibleNameReport(root,globalLike),contrast=contrastReport(root,globalLike);
  return{
    viewport:{width:globalLike.innerWidth||0,height:globalLike.innerHeight||0,scrollWidth:root.documentElement?.scrollWidth||0},
    state:root.body?.dataset?.ingenueState||session?.state?.status||null,
    interactive,accessible,contrast,
    runtime:{sessions:Array.isArray(globalLike.ingenueDebug?.sessions)?globalLike.ingenueDebug.sessions.length:0,events:session?.events?.size??0,eventLimit:session?.events?.limit??0,queued:session?.queue?.size??0,pending:session?.commands?.pending?.size??0,inflight:session?.inflight?.size??0},
  };
}
export async function measureFrameCadence(globalLike=globalThis,samples=24){
  const count=Math.max(6,Math.min(120,Number(samples)||24)),times=[];
  await new Promise(resolve=>{const tick=time=>{times.push(time);if(times.length>=count+1)resolve();else globalLike.requestAnimationFrame(tick);};globalLike.requestAnimationFrame(tick);});
  const deltas=times.slice(1).map((time,index)=>time-times[index]);return{samples:deltas.length,p50:Number(percentile(deltas,.5).toFixed(3)),p95:Number(percentile(deltas,.95).toFixed(3)),max:Number(Math.max(...deltas).toFixed(3))};
}
function timedPing(session,globalLike,timeoutMs){
  return new Promise((resolve,reject)=>{
    let id=null;const started=globalLike.performance.now();
    const cleanup=()=>{globalLike.clearTimeout(timer);session.removeEventListener('command',onCommand);};
    const onCommand=event=>{if(!id||event.detail?.id!==id)return;cleanup();if(event.detail.status!=='ack')reject(new Error(event.detail.failure?.message||event.detail.error||`command ${id} ${event.detail.status}`));else resolve(globalLike.performance.now()-started);};
    const timer=globalLike.setTimeout(()=>{cleanup();reject(new Error(`command ${id||'ping'} timed out`));},timeoutMs);
    session.addEventListener('command',onCommand);
    try{id=session.command({target:'system',action:'ping',args:{}});}catch(error){cleanup();reject(error);}
  });
}
export async function measureCommandLatency(session,{count=12,timeoutMs=1500,globalLike=globalThis}={}){
  if(!session||typeof session.command!=='function')throw new TypeError('realtime session is required');const values=[];
  for(let index=0;index<count;index+=1)values.push(await timedPing(session,globalLike,timeoutMs));
  return{samples:values.length,p50:Number(percentile(values,.5).toFixed(3)),p95:Number(percentile(values,.95).toFixed(3)),max:Number(Math.max(...values).toFixed(3))};
}
export function installQualityContract(root=document,globalLike=globalThis){
  if(globalLike.ingenueQuality)return globalLike.ingenueQuality;
  const stylesheet=injectStylesheet(root);
  repairAccessibleNames(root);
  const observer=typeof globalLike.MutationObserver==='function'?new globalLike.MutationObserver(()=>repairAccessibleNames(root)):null;
  observer?.observe(root.body||root.documentElement,{childList:true,subtree:true});
  const ready=stylesheet.then(()=>new Promise(resolve=>{
    if(typeof globalLike.requestAnimationFrame==='function')globalLike.requestAnimationFrame(()=>resolve());
    else resolve();
  })).then(()=>{repairAccessibleNames(root);if(root.body)root.body.dataset.ingenueQualityReady='true';return true;});
  const api={budgets:QUALITY_BUDGETS,ready,snapshot:()=>{repairAccessibleNames(root);return qualitySnapshot(root,globalLike);},measureFrames:samples=>measureFrameCadence(globalLike,samples),measureCommands:(session=globalLike.ingenueDebug?.latest,options={})=>measureCommandLatency(session,{...options,globalLike}),destroy:()=>observer?.disconnect()};
  globalLike.ingenueQuality=api;return api;
}
