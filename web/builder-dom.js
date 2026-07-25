import {BuilderError} from './builder-core.js';

export function element(root,id){const value=root.getElementById(id);if(!value)throw new BuilderError(`builder element #${id} is missing`);return value;}
export function option(value,label=value){const node=document.createElement('option');node.value=String(value);node.textContent=String(label);return node;}
export function button(label,title=label){const node=document.createElement('button');node.type='button';node.textContent=label;node.title=title;node.dataset.builderAction='';return node;}
export function labelField(caption,control,full=false){const label=document.createElement('label');if(full)label.className='full';const span=document.createElement('span');span.textContent=caption;label.append(span,control);return label;}
export function textInput(value,max=80){const input=document.createElement('input');input.value=value;input.maxLength=max;input.autocomplete='off';input.dataset.builderAction='';return input;}
export function numberInput(value,{min,max,step=1}={}){const input=document.createElement('input');input.type='number';input.value=String(value);if(min!=null)input.min=String(min);if(max!=null)input.max=String(max);input.step=String(step);input.dataset.builderAction='';return input;}
export function selectInput(value,values){const select=document.createElement('select');select.dataset.builderAction='';for(const [raw,label] of values.map(item=>Array.isArray(item)?item:[item,item]))select.append(option(raw,label));select.value=String(value);return select;}
export function fileName(script){const safe=String(script||'surface').replace(/[^A-Za-z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'')||'surface';return `${safe}-ingenue-ui.json`;}
export function formattedParameter(item,fallback){return String(item?.formatted||item?.value_text||(Number.isFinite(fallback)?fallback.toFixed(3):'—'));}
export function shapeDimensions(shape){const [cols,rows]=String(shape).split('x').map(Number);return{cols,rows};}
export function safeCapture(node,pointerId){try{node.setPointerCapture?.(pointerId);}catch{}}
export function safeRelease(node,pointerId){try{if(node.hasPointerCapture?.(pointerId))node.releasePointerCapture(pointerId);}catch{}}
export function pointerAngle(node,event){const rect=node.getBoundingClientRect();return Math.atan2(event.clientY-(rect.top+rect.height/2),event.clientX-(rect.left+rect.width/2));}
export function boundedDelta(send,delta){let remaining=Math.trunc(delta);while(remaining){const part=Math.max(-127,Math.min(127,remaining));send(part);remaining-=part;}}
