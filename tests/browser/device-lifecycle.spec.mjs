import {test,expect} from '@playwright/test';

const FIXTURE='http://127.0.0.1:7777/__fixture__';
const QUERY='?device=127.0.0.1&rt=7778&bridge=localhost';
async function reset(request){expect((await request.get(`${FIXTURE}/reset`)).ok()).toBeTruthy();}
async function commands(request){return (await request.get(`${FIXTURE}/commands`)).json();}
async function waitFor(request,predicate){await expect.poll(async()=>Boolean((await commands(request)).find(predicate))).toBe(true);}
async function synced(page){await page.waitForFunction(()=>globalThis.ingenueDebug?.latest?.state?.status==='synced');}

test.beforeEach(async({request})=>reset(request));

test('standard physical browser gamepad hotplugs, drives norns and neutralizes on disconnect',async({browser,request})=>{
  const context=await browser.newContext();
  await context.addInitScript(()=>{
    const button=value=>({pressed:value>=.5,value});
    const pad={index:0,id:'Fixture Standard Gamepad',connected:true,mapping:'standard',timestamp:1,buttons:Array.from({length:16},()=>button(0)),axes:[0,0,0,0]};
    let connected=true;
    Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>connected?[pad]:[]});
    const dispatch=(name)=>{const event=new Event(name);Object.defineProperty(event,'gamepad',{value:pad});window.dispatchEvent(event);};
    globalThis.__gamepadFixture={
      setButton(index,value){pad.buttons[index]=button(value);pad.timestamp+=1;},
      setAxes(values){pad.axes=[...values];pad.timestamp+=1;},
      connect(){connected=true;pad.connected=true;dispatch('gamepadconnected');},
      disconnect(){connected=false;pad.connected=false;dispatch('gamepaddisconnected');},
    };
  });
  const page=await context.newPage();
  try{
    await page.goto(`http://localhost:7780/gamepad.html${QUERY}`);await synced(page);
    await expect(page.locator('#gamepad-physical-status')).toHaveText('connected');
    await expect(page.locator('#gamepad-physical-device')).toContainText('Fixture Standard Gamepad');
    await page.evaluate(()=>{__gamepadFixture.setButton(0,1);__gamepadFixture.setButton(15,1);__gamepadFixture.setButton(6,.8);__gamepadFixture.setAxes([.9,-.5,0,0]);});
    await waitFor(request,item=>item.command?.target==='gamepad'&&item.command.action==='button'&&item.command.args?.name==='A'&&item.command.args?.z===1);
    await waitFor(request,item=>item.command?.target==='gamepad'&&item.command.action==='dpad'&&item.command.args?.axis==='X'&&item.command.args?.sign===1);
    await waitFor(request,item=>item.command?.target==='gamepad'&&item.command.action==='analog'&&item.command.args?.axis==='leftx'&&item.command.args?.value>0);
    await waitFor(request,item=>item.command?.target==='gamepad'&&item.command.action==='analog'&&item.command.args?.axis==='triggerleft'&&item.command.args?.value===.8);
    await expect(page.locator('[data-gamepad-button="A"]')).toHaveAttribute('data-physical-pressed','true');
    await page.evaluate(()=>__gamepadFixture.disconnect());
    await expect(page.locator('#gamepad-physical-status')).toHaveText('waiting');
    await waitFor(request,item=>item.command?.target==='gamepad'&&item.command.action==='button'&&item.command.args?.name==='A'&&item.command.args?.z===0);
    await waitFor(request,item=>item.command?.target==='gamepad'&&item.command.action==='dpad'&&item.command.args?.axis==='X'&&item.command.args?.sign===0);
    await waitFor(request,item=>item.command?.target==='gamepad'&&item.command.action==='analog'&&item.command.args?.axis==='leftx'&&item.command.args?.value===0);
    await expect(page.locator('[data-gamepad-button="A"]')).toHaveAttribute('data-physical-pressed','false');
  }finally{await context.close();}
});

test('MIDI input disconnect releases a held mapped norns key before profile deactivation',async({browser,request})=>{
  const context=await browser.newContext();
  await context.addInitScript(()=>{
    const input={id:'fixture-midi-in',name:'Fixture MIDI input',manufacturer:'Ingenue',state:'connected',connection:'closed',onmidimessage:null,open:async()=>{input.connection='open';},close:async()=>{input.connection='closed';}};
    const access={inputs:new Map([[input.id,input]]),outputs:new Map(),onstatechange:null};
    Object.defineProperty(navigator,'requestMIDIAccess',{configurable:true,value:async()=>access});
    globalThis.__midiLifecycle={
      emit(data){input.onmidimessage?.({data:Uint8Array.from(data)});},
      disconnect(){input.state='disconnected';access.inputs.delete(input.id);access.onstatechange?.({port:input});},
    };
  });
  const page=await context.newPage();
  try{
    await page.goto(`http://localhost:7780/midi.html${QUERY}`);await synced(page);
    await page.locator('#midi-permission').click();await expect(page.locator('#midi-input')).toHaveValue('fixture-midi-in');
    await page.locator('#midi-target-kind').selectOption('key');await page.locator('#midi-target-value').fill('2');await page.locator('#midi-learn').click();
    await page.evaluate(()=>__midiLifecycle.emit([0x90,60,100]));await expect(page.locator('.mapping-row')).toHaveCount(1);
    await page.evaluate(()=>__midiLifecycle.emit([0x90,60,100]));
    await waitFor(request,item=>item.command?.target==='control'&&item.command.action==='key'&&item.command.args?.n===2&&item.command.args?.z===1);
    await page.evaluate(()=>__midiLifecycle.disconnect());
    await waitFor(request,item=>item.command?.target==='control'&&item.command.action==='key'&&item.command.args?.n===2&&item.command.args?.z===0);
    await expect(page.locator('#midi-input')).toHaveValue('');
    await expect(page.locator('#midi-notice')).toContainText('Held key mappings were released');
  }finally{await context.close();}
});
