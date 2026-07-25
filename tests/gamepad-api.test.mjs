import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserGamepadRuntime,standardGamepadSnapshot} from '../web/gamepad-api.js';

function button(value=0){return{pressed:value>=.5,value};}
function pad(overrides={}){
  const buttons=Array.from({length:16},()=>button(0));
  return{index:0,id:'Fixture Standard Pad',connected:true,mapping:'standard',timestamp:1,buttons,axes:[0,0,0,0],...overrides};
}

test('standard gamepad snapshot maps buttons, dpad, sticks and triggers',()=>{
  const gamepad=pad();gamepad.buttons[0]=button(1);gamepad.buttons[6]=button(.75);gamepad.buttons[15]=button(1);gamepad.axes=[.5,-.5,-1,1];
  const state=standardGamepadSnapshot(gamepad,{deadzone:.1});
  assert.equal(state.buttons.A,true);assert.equal(state.buttons.L2,true);assert.equal(state.dpad.X,1);
  assert.ok(state.axes.leftx>0);assert.ok(state.axes.lefty<0);assert.equal(state.axes.triggerleft,.75);
});

test('runtime emits only changes and neutralizes every active control on disconnect',()=>{
  let current=pad();
  const sent=[];const statuses=[];
  const runtime=new BrowserGamepadRuntime({
    navigatorLike:{getGamepads:()=>[current]},globalLike:new EventTarget(),requestFrame:()=>1,cancelFrame:()=>{},epsilon:.001,
    onButton:(name,pressed)=>sent.push(['button',name,pressed]),onDpad:(axis,sign)=>sent.push(['dpad',axis,sign]),onAxis:(axis,value)=>sent.push(['axis',axis,value]),onStatus:value=>statuses.push(value.status),
  });
  runtime.start();runtime.step();assert.deepEqual(sent,[]);
  current=pad();current.buttons[0]=button(1);current.buttons[12]=button(1);current.axes=[.8,0,0,0];runtime.step();
  assert.ok(sent.some(item=>item[0]==='button'&&item[1]==='A'&&item[2]===true));
  assert.ok(sent.some(item=>item[0]==='dpad'&&item[1]==='Y'&&item[2]===-1));
  assert.ok(sent.some(item=>item[0]==='axis'&&item[1]==='leftx'&&item[2]>0));
  const before=sent.length;runtime.step();assert.equal(sent.length,before);
  current=null;runtime.step();
  assert.ok(sent.some(item=>item[0]==='button'&&item[1]==='A'&&item[2]===false));
  assert.ok(sent.some(item=>item[0]==='dpad'&&item[1]==='Y'&&item[2]===0));
  assert.ok(sent.some(item=>item[0]==='axis'&&item[1]==='leftx'&&item[2]===0));
  assert.ok(statuses.includes('waiting'));
});

test('non-standard pads are not guessed into the norns callback contract',()=>{
  const runtime=new BrowserGamepadRuntime({navigatorLike:{getGamepads:()=>[{...pad(),mapping:''}]},globalLike:new EventTarget(),requestFrame:()=>1,cancelFrame:()=>{}});
  assert.equal(runtime.step(),null);
  assert.throws(()=>standardGamepadSnapshot({...pad(),mapping:''}),/standard-mapping/);
});
