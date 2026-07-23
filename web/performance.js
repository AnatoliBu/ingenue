import {realtimeUrl} from './realtime-inspector.js';

export function decodeGridLevels(grid={}) {
  const cols=Math.max(1,Number(grid.cols)||16);
  const rows=Math.max(1,Number(grid.rows)||8);
  const raw=String(grid.levels||'').toLowerCase();
  return Array.from({length:cols*rows},(_,index)=>{
    const value=Number.parseInt(raw[index]||'0',16);
    return Number.isFinite(value)?Math.max(0,Math.min(15,value)):0;
  });
}

export function encoderSteps(distance, pixelsPerStep=7) {
  const size=Math.max(1,Number(pixelsPerStep)||7);
  return Math.trunc(Number(distance||0)/size);
}

export function adapterMessage(adapter={}) {
  if(adapter.online)return `Lua adapter v${adapter.version||'?'} online`;
  if(adapter.enabled===false)return 'Enable SYSTEM → MODS → ingenue, then restart norns';
  if(adapter.installed===false)return 'Realtime adapter is not installed; update Ingenue';
  return 'Waiting for the Ingenue Lua adapter';
}

function createGrid(root,grid,onKey){
  const cols=Math.max(1,Number(grid?.cols)||16);
  const rows=Math.max(1,Number(grid?.rows)||8);
  const levels=decodeGridLevels(grid);
  if(root.dataset.shape!==`${cols}x${rows}`){
    root.dataset.shape=`${cols}x${rows}`;
    root.style.setProperty('--cols',cols);
    root.replaceChildren();
    for(let y=1;y<=rows;y++)for(let x=1;x<=cols;x++){
      const cell=document.createElement('button');
      cell.type='button';cell.className='grid-key';cell.dataset.x=x;cell.dataset.y=y;
      const release=()=>onKey(x,y,0);
      cell.addEventListener('pointerdown',event=>{event.preventDefault();cell.setPointerCapture?.(event.pointerId);onKey(x,y,1);});
      cell.addEventListener('pointerup',release);cell.addEventListener('pointercancel',release);
      root.append(cell);
    }
  }
  [...root.children].forEach((cell,index)=>{
    const level=levels[index]||0;
    cell.style.setProperty('--level-pct',`${(level/15)*88}%`);
    cell.style.setProperty('--glow',`${(level/15)*16}px`);
    cell.dataset.level=String(level);
  });
}

function bindEncoder(element,n,send){
  let startY=0,lastSteps=0,active=false,queued=0,scheduled=false;
  const queue=delta=>{
    queued+=delta;
    if(scheduled)return;
    scheduled=true;
    requestAnimationFrame(()=>{
      scheduled=false;
      const value=Math.max(-127,Math.min(127,queued));
      queued-=value;
      if(value)send(n,value);
      if(queued)queue(0);
    });
  };
  element.addEventListener('pointerdown',event=>{active=true;startY=event.clientY;lastSteps=0;element.setPointerCapture?.(event.pointerId);element.classList.add('active');});
  element.addEventListener('pointermove',event=>{
    if(!active)return;
    const steps=encoderSteps(startY-event.clientY);
    const delta=steps-lastSteps;
    if(delta){lastSteps=steps;queue(delta);}
  });
  const end=()=>{active=false;element.classList.remove('active');};
  element.addEventListener('pointerup',end);element.addEventListener('pointercancel',end);
  element.addEventListener('wheel',event=>{event.preventDefault();queue(event.deltaY<0?1:-1);},{passive:false});
}

export async function mountPerformance(root=document){
  const {RealtimeSession}=await import('./realtime-session.js');
  const url=realtimeUrl();
  const session=new RealtimeSession({socketFactory:value=>new WebSocket(value),url,channels:['device','control','grid']});
  const status=root.getElementById('live-status');
  const adapter=root.getElementById('adapter-status');
  const revision=root.getElementById('revision');
  const gridRoot=root.getElementById('virtual-grid');
  const log=root.getElementById('command-log');
  let state=null;
  const writeLog=text=>{log.textContent=`${new Date().toLocaleTimeString()}  ${text}\n${log.textContent}`.slice(0,4000);};
  const sendGrid=(x,y,z)=>session.command({target:'grid',action:'key',args:{port:state?.grid?.port||1,x,y,z}});
  const render=()=>{
    status.textContent=session.state.status;
    revision.textContent=session.state.revision??'—';
    const adapterState=state?.device?.adapter||{};
    adapter.textContent=adapterMessage(adapterState);
    adapter.dataset.online=String(Boolean(adapterState.online));
    createGrid(gridRoot,state?.grid||{},sendGrid);
    root.getElementById('last-control').textContent=state?.control?.last?JSON.stringify(state.control.last):'—';
  };
  session.addEventListener('state',event=>{state=event.detail.data;render();});
  session.addEventListener('command',event=>writeLog(`${event.detail.status} ${event.detail.id}${event.detail.error?` · ${event.detail.error}`:''}`));
  session.addEventListener('protocolerror',event=>writeLog(`protocol · ${event.detail.message}`));
  session.addEventListener('reconnectscheduled',event=>writeLog(`reconnect in ${event.detail.delay}ms`));
  root.querySelectorAll('[data-key]').forEach(button=>{
    const n=Number(button.dataset.key);const up=()=>session.command({target:'control',action:'key',args:{n,z:0}});
    button.addEventListener('pointerdown',event=>{event.preventDefault();button.setPointerCapture?.(event.pointerId);session.command({target:'control',action:'key',args:{n,z:1}});});
    button.addEventListener('pointerup',up);button.addEventListener('pointercancel',up);
  });
  root.querySelectorAll('[data-encoder]').forEach(element=>bindEncoder(element,Number(element.dataset.encoder),(n,d)=>session.command({target:'control',action:'enc',args:{n,d}})));
  root.getElementById('reconnect').addEventListener('click',()=>{session.disconnect();session.connect();});
  root.getElementById('open-inspector').addEventListener('click',()=>{location.href='./realtime-inspector.html';});
  session.connect();render();return session;
}
