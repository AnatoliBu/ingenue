import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {test,expect} from '@playwright/test';

const FIXTURE='http://127.0.0.1:7777/__fixture__';
const bridge=path=>`http://localhost:7780/${path}?device=127.0.0.1&rt=7778&bridge=localhost`;
const PAGES=[
  ['controllers','controllers.html'],
  ['performance','performance.html'],
  ['mlr','mlr.html'],
  ['builder','builder.html'],
  ['launchpad','launchpad.html'],
  ['gamepad','gamepad.html'],
  ['params','params.html'],
  ['midi','midi.html'],
  ['inspector','realtime-inspector.html'],
];

const VISUAL_BASELINES=Object.freeze({
  'controllers-desktop':'28e461ca36364ca07206496066c5ce069506e97cd1e3a3252bd5f7da119f0ce6',
  'performance-desktop':'9869a0e9ce961b16b366d532ca4984b31ef9dbed0837e809f106562f8d971ccc',
  'builder-desktop':'2df2776017086a95db4d2c176d3b9aaad98731938a01b1996e71b78c08ff9df4',
  'mlr-desktop':'a0d379d5fd32337dde7f60f84f251f735e532b74167103223550d639589c726a',
  'performance-tablet':'5f5231f3e167c836f440fc5e10f232a473a7bf1995a714f353108ebc6869fb06',
  'builder-tablet':'cf1e279d8313c46234384622b41ac2219488693b7ba0262cb0bd8f237b52c348',
  'mlr-tablet':'11c287195d5f7490bb94f5ce88b0c904112afd8125594644463c9790bde24abc',
  'performance-phone':'8288d8d1ec8b916f2e20759fb3c8e9097a905a0371910d17d72c99f20c7079e2',
  'builder-phone':'b88a2aa221dff384a6bedc8844d4e20b0664a4cdf4634fd4fb8bb441db69b630',
  'mlr-phone':'678e6aec7bdd6dea62631e316f3b7e95e49aefc3ca58babd22ba3002dff535bc',
});
const VISUALS=[
  ['controllers','controllers.html'],
  ['performance','performance.html'],
  ['builder','builder.html'],
  ['mlr','mlr.html'],
];

test.use({colorScheme:'dark',reducedMotion:'reduce'});

async function reset(request){expect((await request.get(`${FIXTURE}/reset`)).ok()).toBeTruthy();}
async function openSurface(page,path){
  await page.goto(bridge(path));
  await page.waitForFunction(()=>document.body?.dataset?.ingenueQualityReady==='true');
  await page.waitForFunction(()=>globalThis.ingenueDebug?.latest?.state?.status==='synced');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function snapshot(page){return page.evaluate(()=>globalThis.ingenueQuality.snapshot());}

function paeth(left,up,upperLeft){
  const estimate=left+up-upperLeft,dl=Math.abs(estimate-left),du=Math.abs(estimate-up),dul=Math.abs(estimate-upperLeft);
  return dl<=du&&dl<=dul?left:du<=dul?up:upperLeft;
}
function decodeRgbPng(buffer){
  const signature='89504e470d0a1a0a';
  if(buffer.subarray(0,8).toString('hex')!==signature)throw new Error('visual baseline is not PNG');
  let offset=8,width=0,height=0,bitDepth=0,colorType=0,interlace=0;const chunks=[];
  while(offset+12<=buffer.length){
    const length=buffer.readUInt32BE(offset),type=buffer.subarray(offset+4,offset+8).toString('ascii'),data=buffer.subarray(offset+8,offset+8+length);offset+=12+length;
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);bitDepth=data[8];colorType=data[9];interlace=data[12];}
    else if(type==='IDAT')chunks.push(data);
    else if(type==='IEND')break;
  }
  if(bitDepth!==8||![2,6].includes(colorType)||interlace!==0)throw new Error(`unsupported visual PNG format: depth ${bitDepth}, color ${colorType}, interlace ${interlace}`);
  const channels=colorType===2?3:4,stride=width*channels,encoded=inflateSync(Buffer.concat(chunks)),pixels=Buffer.alloc(height*stride);let source=0;
  for(let y=0;y<height;y+=1){
    const filter=encoded[source++],row=y*stride,previous=row-stride;
    for(let x=0;x<stride;x+=1){
      const raw=encoded[source++],left=x>=channels?pixels[row+x-channels]:0,up=y?pixels[previous+x]:0,upperLeft=y&&x>=channels?pixels[previous+x-channels]:0;
      const predictor=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?paeth(left,up,upperLeft):NaN;
      if(!Number.isFinite(predictor))throw new Error(`unsupported PNG row filter: ${filter}`);
      pixels[row+x]=(raw+predictor)&255;
    }
  }
  return{width,height,channels,pixels};
}
function visualSignature(buffer,{gridX=48,gridY=48,quantum=8}={}){
  const{width,height,channels,pixels}=decodeRgbPng(buffer),summary=Buffer.alloc(8+gridX*gridY*3);summary.writeUInt32BE(width,0);summary.writeUInt32BE(height,4);let cursor=8;
  for(let gy=0;gy<gridY;gy+=1){
    const y0=Math.floor(gy*height/gridY),y1=Math.max(y0+1,Math.floor((gy+1)*height/gridY));
    for(let gx=0;gx<gridX;gx+=1){
      const x0=Math.floor(gx*width/gridX),x1=Math.max(x0+1,Math.floor((gx+1)*width/gridX)),sum=[0,0,0],count=(x1-x0)*(y1-y0);
      for(let y=y0;y<y1;y+=1)for(let x=x0;x<x1;x+=1){const pixel=(y*width+x)*channels;sum[0]+=pixels[pixel];sum[1]+=pixels[pixel+1];sum[2]+=pixels[pixel+2];}
      for(const value of sum)summary[cursor++]=Math.max(0,Math.min(255,Math.round((value/count)/quantum)*quantum));
    }
  }
  return createHash('sha256').update(summary).digest('hex');
}

test.beforeEach(async({request})=>reset(request));

for(const [name,path] of PAGES){
  test(`${name} exposes the shared quality contract and accessible desktop controls`,async({page})=>{
    await page.setViewportSize({width:1440,height:1000});await openSurface(page,path);
    const report=await snapshot(page);
    expect(report.viewport.scrollWidth,JSON.stringify(report.viewport)).toBeLessThanOrEqual(report.viewport.width+1);
    expect(report.interactive.violations,JSON.stringify(report.interactive.violations,null,2)).toEqual([]);
    expect(report.accessible.violations,JSON.stringify(report.accessible.violations,null,2)).toEqual([]);
    expect(report.contrast.violations,JSON.stringify(report.contrast.violations,null,2)).toEqual([]);
    expect(report.runtime.sessions).toBe(1);
  });

  test(`${name} has no phone overflow and keeps ordinary targets touch-safe`,async({page})=>{
    await page.setViewportSize({width:390,height:844});await openSurface(page,path);
    const report=await snapshot(page);
    expect(report.viewport.scrollWidth,JSON.stringify(report.viewport)).toBeLessThanOrEqual(report.viewport.width+1);
    expect(report.interactive.minimum).toBe(44);
    expect(report.interactive.violations,JSON.stringify(report.interactive.violations,null,2)).toEqual([]);
  });
}

test('focus and reduced-motion invariants are visible in Chromium',async({page})=>{
  await page.setViewportSize({width:390,height:844});await openSurface(page,'controllers.html');
  const toggle=page.locator('.ingenue-shell-diagnostics-toggle');await toggle.focus();
  const style=await toggle.evaluate(node=>{const value=getComputedStyle(node);return{width:parseFloat(value.outlineWidth),style:value.outlineStyle,duration:value.transitionDuration};});
  expect(style.width).toBeGreaterThanOrEqual(2);expect(style.style).not.toBe('none');
  expect(['0s','0.001s']).toContain(style.duration);
});

test('frame cadence and browser to runtime ACK latency stay inside Shield budgets',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});await openSurface(page,'performance.html');
  const result=await page.evaluate(async()=>({frames:await ingenueQuality.measureFrames(36),commands:await ingenueQuality.measureCommands(undefined,{count:12,timeoutMs:1500}),budgets:ingenueQuality.budgets}));
  expect(result.frames.p95,result.frames).toBeLessThanOrEqual(result.budgets.frameP95Ms);
  expect(result.frames.max,result.frames).toBeLessThanOrEqual(result.budgets.frameMaxMs);
  expect(result.commands.p95,result.commands).toBeLessThanOrEqual(result.budgets.commandP95Ms);
  expect(result.commands.max,result.commands).toBeLessThanOrEqual(result.budgets.commandMaxMs);
});

test('eight reconnect cycles keep one bounded session and stable shell DOM',async({page,request})=>{
  await openSurface(page,'controllers.html');
  const initial=await page.evaluate(()=>({shells:document.querySelectorAll('[data-ingenue-app-shell-root]').length,drawers:document.querySelectorAll('.ingenue-shell-drawer').length,sessions:ingenueDebug.sessions.length}));
  const before=await (await request.get(`${FIXTURE}/stats`)).json();
  for(let cycle=1;cycle<=8;cycle+=1){
    await request.get(`${FIXTURE}/disconnect`);
    await expect.poll(async()=>{const stats=await (await request.get(`${FIXTURE}/stats`)).json();return stats.connections;}).toBeGreaterThanOrEqual(before.connections+cycle);
    await page.waitForFunction(()=>globalThis.ingenueDebug?.latest?.state?.status==='synced');
  }
  await page.evaluate(()=>ingenueQuality.measureCommands(undefined,{count:1,timeoutMs:1500}));
  const final=await page.evaluate(()=>({quality:ingenueQuality.snapshot(),shells:document.querySelectorAll('[data-ingenue-app-shell-root]').length,drawers:document.querySelectorAll('.ingenue-shell-drawer').length,sessions:ingenueDebug.sessions.length}));
  const stats=await (await request.get(`${FIXTURE}/stats`)).json();
  expect(final.sessions).toBe(initial.sessions);expect(final.sessions).toBe(1);
  expect(final.shells).toBe(initial.shells);expect(final.drawers).toBe(initial.drawers);
  expect(final.quality.runtime.events).toBeLessThanOrEqual(final.quality.runtime.eventLimit);
  expect(final.quality.runtime.queued).toBe(0);expect(final.quality.runtime.pending).toBe(0);expect(final.quality.runtime.inflight).toBe(0);
  expect(stats.active_clients).toBe(1);
});

for(const viewport of [
  {id:'desktop',width:1440,height:1000,pages:VISUALS},
  {id:'tablet',width:900,height:1100,pages:VISUALS.filter(([name])=>name!=='controllers')},
  {id:'phone',width:390,height:844,pages:VISUALS.filter(([name])=>name!=='controllers')},
]){
  for(const [name,path] of viewport.pages){
    test(`visual baseline ${name} ${viewport.id}`,async({page},testInfo)=>{
      await page.setViewportSize({width:viewport.width,height:viewport.height});await openSurface(page,path);
      const image=await page.screenshot({animations:'disabled',caret:'hide',fullPage:true,scale:'css'});
      const key=`${name}-${viewport.id}`;const signature=visualSignature(image);
      if(signature!==VISUAL_BASELINES[key])await writeFile(testInfo.outputPath(`${key}-actual.png`),image);
      expect(signature,`${key} visual signature changed; inspect the attached actual PNG before updating the baseline`).toBe(VISUAL_BASELINES[key]);
    });
  }
}
