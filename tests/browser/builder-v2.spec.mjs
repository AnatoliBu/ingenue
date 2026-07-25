import {test,expect} from '@playwright/test';

const FIXTURE='http://127.0.0.1:7777/__fixture__';
const PAGE='http://localhost:7780/builder.html?device=127.0.0.1&rt=7778&bridge=localhost';
const SCRIPT='browser-contract-fixture';
async function reset(request){expect((await request.get(`${FIXTURE}/reset`)).ok()).toBeTruthy();}
async function commands(request){return (await request.get(`${FIXTURE}/commands`)).json();}
async function waitFor(request,predicate){await expect.poll(async()=>Boolean((await commands(request)).find(predicate))).toBe(true);}
async function synced(page){await page.waitForFunction(()=>globalThis.ingenueDebug?.latest?.state?.status==='synced');}
async function importSchema(page,schema){await page.locator('#builder-json').fill(JSON.stringify(schema));await page.locator('#builder-import').click();await expect(page.locator('#builder-notice')).toContainText('imported');}

test.beforeEach(async({request})=>reset(request));

test('Builder v2 drives Grid, Arc and gamepad through the shared runtime',async({page,request})=>{
  await page.goto(PAGE);await synced(page);
  await importSchema(page,{version:2,script:SCRIPT,name:'Advanced',columns:3,metadata:{source:'import',revision:null},widgets:[
    {id:'grid',type:'grid',span:2,label:'Grid',port:1,shape:'8x8'},
    {id:'arc',type:'arc',span:1,label:'Arc',port:1,ring:1,sensitivity:4},
    {id:'pad',type:'gamepad',span:1,label:'A',control:'button',name:'A'},
  ]});
  await expect(page.locator('.builder-grid-pad')).toHaveCount(64);
  const first=page.locator('.builder-grid-pad').nth(0),second=page.locator('.builder-grid-pad').nth(1);await first.scrollIntoViewIfNeeded();const from=await first.boundingBox(),to=await second.boundingBox();
  expect(from).not.toBeNull();expect(to).not.toBeNull();
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:4});await page.mouse.up();
  await waitFor(request,item=>item.command?.target==='grid'&&item.command.action==='key'&&item.command.args?.x===1&&item.command.args?.y===1&&item.command.args?.z===1);
  await waitFor(request,item=>item.command?.target==='grid'&&item.command.action==='key'&&item.command.args?.x===1&&item.command.args?.y===1&&item.command.args?.z===0);
  await waitFor(request,item=>item.command?.target==='grid'&&item.command.action==='key'&&item.command.args?.x===2&&item.command.args?.y===1&&item.command.args?.z===1);
  await waitFor(request,item=>item.command?.target==='grid'&&item.command.action==='key'&&item.command.args?.x===2&&item.command.args?.y===1&&item.command.args?.z===0);
  await page.locator('.builder-arc-ring').focus();await page.keyboard.press('ArrowRight');
  await waitFor(request,item=>item.command?.target==='arc'&&item.command.action==='delta'&&item.command.args?.n===1&&item.command.args?.d===1);
  await page.locator('.preview-gamepad button').click();
  await waitFor(request,item=>item.command?.target==='gamepad'&&item.command.action==='button'&&item.command.args?.name==='A'&&item.command.args?.z===1);
  await waitFor(request,item=>item.command?.target==='gamepad'&&item.command.action==='button'&&item.command.args?.z===0);
});

test('Builder MIDI widget hotplugs and releases its held norns key',async({browser,request})=>{
  const context=await browser.newContext();
  await context.addInitScript(()=>{
    const input={id:'builder-midi',name:'Builder MIDI',manufacturer:'Ingenue',state:'connected',connection:'closed',onmidimessage:null,open:async()=>{input.connection='open';},close:async()=>{input.connection='closed';}};
    const access={inputs:new Map([[input.id,input]]),outputs:new Map(),onstatechange:null};
    Object.defineProperty(navigator,'requestMIDIAccess',{configurable:true,value:async()=>access});
    globalThis.__builderMidi={emit(data){input.onmidimessage?.({data:Uint8Array.from(data)});},disconnect(){input.state='disconnected';access.inputs.delete(input.id);access.onstatechange?.({port:input});}};
  });
  const page=await context.newPage();
  try{
    await page.goto(PAGE);await synced(page);
    await importSchema(page,{version:2,script:SCRIPT,name:'MIDI',columns:1,metadata:{source:'import',revision:null},widgets:[{id:'midi',type:'midi',span:1,label:'MIDI K2',source:{type:'note',channel:1,number:60},target:{kind:'key',n:2},mode:'gate',pickup:false}]});
    await page.locator('#builder-midi-enable').click();await expect(page.locator('#builder-midi-status')).toContainText('1 MIDI input');
    await page.evaluate(()=>__builderMidi.emit([0x90,60,100]));
    await waitFor(request,item=>item.command?.target==='control'&&item.command.action==='key'&&item.command.args?.n===2&&item.command.args?.z===1);
    await page.evaluate(()=>__builderMidi.disconnect());
    await waitFor(request,item=>item.command?.target==='control'&&item.command.action==='key'&&item.command.args?.n===2&&item.command.args?.z===0);
  }finally{await context.close();}
});

test('templates and named presets survive a builder reload',async({page})=>{
  await page.goto(PAGE);await synced(page);
  await page.locator('#builder-template').selectOption('gamepad');await page.locator('#builder-template-apply').click();
  await expect(page.locator('.preview-gamepad')).toHaveCount(7);
  await page.locator('#builder-preset-name').fill('live');await page.locator('#builder-preset-save').click();await expect(page.locator('#builder-preset')).toContainText('live');
  await page.reload();await synced(page);await expect(page.locator('.preview-gamepad')).toHaveCount(7);await expect(page.locator('#builder-preset')).toContainText('live');
});
