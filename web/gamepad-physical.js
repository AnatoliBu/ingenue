import {AppliedValueLane} from './performance-core.js';
import {BrowserGamepadRuntime} from './gamepad-api.js';
import {normalizeStickVector} from './gamepad-core.js';

function command(session,action,args){return session.command({target:'gamepad',action,args});}
function renderStick(root,prefix,x,y){
  const vector=normalizeStickVector(x,y,0);
  const element=root.getElementById(`gamepad-${prefix}-stick`);
  const knob=element?.querySelector('.gamepad-stick-knob');
  if(knob){knob.style.setProperty('--stick-x',String(vector.x));knob.style.setProperty('--stick-y',String(vector.y));}
  const value=element?.querySelector('.gamepad-stick-value');
  if(value)value.textContent=`${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}`;
}
function renderTrigger(root,side,value){
  const input=root.getElementById(`gamepad-${side}-trigger`);
  const output=root.getElementById(`gamepad-${side}-trigger-value`);
  if(input)input.value=String(value);if(output)output.textContent=Number(value).toFixed(2);
}
function mark(root,selector,pressed){const element=root.querySelector(selector);if(element)element.dataset.physicalPressed=pressed?'true':'false';}

export function mountPhysicalGamepad(session,root=document,options={}){
  if(!session||typeof session.command!=='function')throw new TypeError('realtime session is required');
  const status=root.getElementById('gamepad-physical-status');
  const device=root.getElementById('gamepad-physical-device');
  const lanes=new Map();const settlements=new Map();const axes={leftx:0,lefty:0,rightx:0,righty:0,triggerleft:0,triggerright:0};
  const laneFor=axis=>{
    if(!lanes.has(axis)){
      const lane=new AppliedValueLane(value=>{const id=command(session,'analog',{axis,value});settlements.set(id,lane);return id;});
      lanes.set(axis,lane);
    }
    return lanes.get(axis);
  };
  const pushAxis=(axis,value)=>{
    axes[axis]=value;laneFor(axis).push(value);
    if(axis==='leftx'||axis==='lefty')renderStick(root,'left',axes.leftx,axes.lefty);
    else if(axis==='rightx'||axis==='righty')renderStick(root,'right',axes.rightx,axes.righty);
    else if(axis==='triggerleft')renderTrigger(root,'left',value);
    else if(axis==='triggerright')renderTrigger(root,'right',value);
  };
  const runtime=new BrowserGamepadRuntime({
    navigatorLike:options.navigatorLike||globalThis.navigator,globalLike:options.globalLike||globalThis,
    requestFrame:options.requestFrame,cancelFrame:options.cancelFrame,deadzone:options.deadzone??.12,epsilon:options.epsilon??.01,
    onButton:(name,pressed)=>{mark(root,`[data-gamepad-button="${name}"]`,pressed);command(session,'button',{name,z:pressed?1:0});},
    onDpad:(axis,sign)=>{
      root.querySelectorAll(`[data-gamepad-direction^="${axis}:"]`).forEach(element=>{element.dataset.physicalPressed=Number(element.dataset.gamepadDirection.split(':')[1])===sign?'true':'false';});
      command(session,'dpad',{axis,sign});
    },
    onAxis:pushAxis,
    onStatus:detail=>{
      if(status)status.textContent=detail.status;
      if(device)device.textContent=detail.id||(
        detail.status==='unsupported'?'Gamepad API unavailable':'press a button on a standard gamepad'
      );
    },
  });
  let ready=false;let focused=true;
  const synchronize=()=>{if(ready&&focused)runtime.start();else runtime.stop({neutral:true});};
  session.addEventListener('state',event=>{ready=event.detail.status==='synced'&&Boolean(event.detail.data);synchronize();});
  session.addEventListener('command',event=>{
    const lane=settlements.get(event.detail.id);if(!lane)return;
    settlements.delete(event.detail.id);const next=lane.settle(event.detail.id,event.detail.status);if(next)settlements.set(next,lane);
  });
  const globalLike=options.globalLike||globalThis;
  globalLike.addEventListener?.('blur',()=>{focused=false;synchronize();});
  globalLike.addEventListener?.('focus',()=>{focused=true;synchronize();});
  globalLike.addEventListener?.('pagehide',()=>runtime.destroy());
  runtime.report();
  session.physicalGamepad=runtime;
  return runtime;
}
