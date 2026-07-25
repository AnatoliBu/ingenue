import {GAMEPAD_ANALOG_AXES,GAMEPAD_BUTTONS,normalizeStickVector,normalizeTrigger} from './gamepad-core.js';

export class BrowserGamepadError extends Error {}

const STANDARD_BUTTON_INDEX=Object.freeze({A:0,B:1,X:2,Y:3,L1:4,R1:5,L2:6,R2:7,SELECT:8,START:9,L3:10,R3:11});
const EMPTY_AXES=Object.freeze(Object.fromEntries(GAMEPAD_ANALOG_AXES.map(axis=>[axis,0])));

function buttonValue(button){
  if(typeof button==='number')return Math.min(1,Math.max(0,button));
  const value=Number(button?.value??(button?.pressed?1:0));
  return Number.isFinite(value)?Math.min(1,Math.max(0,value)):0;
}
function buttonPressed(button){return Boolean(button?.pressed||buttonValue(button)>=.5);}
function standard(gamepad){return Boolean(gamepad&&gamepad.connected!==false&&gamepad.mapping==='standard');}
function rounded(value){return Number(Number(value||0).toFixed(4));}

export function standardGamepadSnapshot(gamepad,{deadzone=.12}={}){
  if(!standard(gamepad))throw new BrowserGamepadError('a connected standard-mapping gamepad is required');
  const buttons={};
  for(const name of GAMEPAD_BUTTONS)buttons[name]=buttonPressed(gamepad.buttons?.[STANDARD_BUTTON_INDEX[name]]);
  const left=normalizeStickVector(gamepad.axes?.[0]||0,gamepad.axes?.[1]||0,deadzone);
  const right=normalizeStickVector(gamepad.axes?.[2]||0,gamepad.axes?.[3]||0,deadzone);
  const dpad={
    X:(buttonPressed(gamepad.buttons?.[15])?1:0)-(buttonPressed(gamepad.buttons?.[14])?1:0),
    Y:(buttonPressed(gamepad.buttons?.[13])?1:0)-(buttonPressed(gamepad.buttons?.[12])?1:0),
  };
  return{
    index:Number(gamepad.index),id:String(gamepad.id||'standard gamepad'),mapping:'standard',timestamp:Number(gamepad.timestamp)||0,
    buttons,dpad,
    axes:{leftx:left.x,lefty:left.y,rightx:right.x,righty:right.y,triggerleft:normalizeTrigger(buttonValue(gamepad.buttons?.[6])),triggerright:normalizeTrigger(buttonValue(gamepad.buttons?.[7]))},
  };
}

function emptySnapshot(){return{index:null,id:null,mapping:null,timestamp:0,buttons:Object.fromEntries(GAMEPAD_BUTTONS.map(name=>[name,false])),dpad:{X:0,Y:0},axes:{...EMPTY_AXES}};}

export class BrowserGamepadRuntime{
  constructor({navigatorLike=globalThis.navigator,globalLike=globalThis,onButton=()=>{},onDpad=()=>{},onAxis=()=>{},onStatus=()=>{},requestFrame=globalThis.requestAnimationFrame?.bind(globalThis),cancelFrame=globalThis.cancelAnimationFrame?.bind(globalThis),deadzone=.12,epsilon=.01}={}){
    if(typeof navigatorLike?.getGamepads!=='function')this.supported=false;else this.supported=true;
    if(typeof onButton!=='function'||typeof onDpad!=='function'||typeof onAxis!=='function'||typeof onStatus!=='function')throw new BrowserGamepadError('gamepad callbacks must be functions');
    this.navigatorLike=navigatorLike;this.globalLike=globalLike;this.onButton=onButton;this.onDpad=onDpad;this.onAxis=onAxis;this.onStatus=onStatus;
    this.requestFrame=requestFrame||((callback)=>globalThis.setTimeout(callback,16));this.cancelFrame=cancelFrame||globalThis.clearTimeout?.bind(globalThis);
    this.deadzone=Number(deadzone);this.epsilon=Number(epsilon);this.running=false;this.frame=null;this.selectedIndex=null;this.previous=emptySnapshot();
    this.handleConnect=event=>{if(standard(event?.gamepad)&&this.selectedIndex==null)this.selectedIndex=event.gamepad.index;this.report();};
    this.handleDisconnect=event=>{if(Number(event?.gamepad?.index)===this.selectedIndex){this.releaseAll();this.selectedIndex=null;}this.report();};
  }
  pads(){try{return Array.from(this.navigatorLike?.getGamepads?.()||[]).filter(Boolean);}catch{return[];}}
  select(){
    const pads=this.pads();
    const current=pads.find(pad=>Number(pad.index)===this.selectedIndex&&standard(pad));
    if(current)return current;
    const next=pads.find(standard)||null;this.selectedIndex=next?.index??null;return next;
  }
  report(gamepad=this.select()){
    const detail=this.supported
      ? gamepad?{status:'connected',id:String(gamepad.id||'standard gamepad'),index:Number(gamepad.index),mapping:String(gamepad.mapping||'')}:{status:'waiting',id:null,index:null,mapping:null}
      :{status:'unsupported',id:null,index:null,mapping:null};
    this.onStatus(detail);return detail;
  }
  start(){
    if(this.running)return false;this.running=true;
    this.globalLike?.addEventListener?.('gamepadconnected',this.handleConnect);
    this.globalLike?.addEventListener?.('gamepaddisconnected',this.handleDisconnect);
    this.report();this.schedule();return true;
  }
  stop({neutral=true}={}){
    if(!this.running&&this.frame==null){if(neutral)this.releaseAll();return false;}
    this.running=false;
    if(this.frame!=null)this.cancelFrame?.(this.frame);this.frame=null;
    this.globalLike?.removeEventListener?.('gamepadconnected',this.handleConnect);
    this.globalLike?.removeEventListener?.('gamepaddisconnected',this.handleDisconnect);
    if(neutral)this.releaseAll();return true;
  }
  destroy(){this.stop({neutral:true});this.selectedIndex=null;this.report(null);}
  schedule(){if(!this.running)return;this.frame=this.requestFrame(()=>{this.frame=null;this.step();this.schedule();});}
  step(){
    const gamepad=this.select();
    if(!gamepad){if(this.previous.index!=null)this.releaseAll();this.report(null);return null;}
    const next=standardGamepadSnapshot(gamepad,{deadzone:this.deadzone});
    if(this.previous.index!==next.index){this.releaseAll();this.onStatus({status:'connected',id:next.id,index:next.index,mapping:next.mapping});}
    for(const name of GAMEPAD_BUTTONS)if(Boolean(this.previous.buttons[name])!==Boolean(next.buttons[name]))this.onButton(name,next.buttons[name]);
    for(const axis of ['X','Y'])if(this.previous.dpad[axis]!==next.dpad[axis])this.onDpad(axis,next.dpad[axis]);
    for(const axis of GAMEPAD_ANALOG_AXES)if(Math.abs((this.previous.axes[axis]||0)-next.axes[axis])>=this.epsilon)this.onAxis(axis,rounded(next.axes[axis]));
    this.previous=next;return next;
  }
  releaseAll(){
    for(const name of GAMEPAD_BUTTONS)if(this.previous.buttons[name])this.onButton(name,false);
    for(const axis of ['X','Y'])if(this.previous.dpad[axis])this.onDpad(axis,0);
    for(const axis of GAMEPAD_ANALOG_AXES)if(Math.abs(this.previous.axes[axis]||0)>=this.epsilon)this.onAxis(axis,0);
    this.previous=emptySnapshot();
  }
}
