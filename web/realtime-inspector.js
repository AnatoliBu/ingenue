function validPort(value, fallback) {
  const port=Number(value);
  return Number.isInteger(port)&&port>0&&port<65536?port:fallback;
}

export function realtimeHost(value, fallback) {
  const raw=String(value||'').trim();
  if(!raw)return fallback;
  try{
    const parsed=new URL(`http://${raw}`);
    if(parsed.username||parsed.password||parsed.port||parsed.pathname!=='/'||parsed.search||parsed.hash)return fallback;
    return parsed.hostname||fallback;
  }catch{return fallback;}
}

export function realtimeUrl(locationLike=location) {
  const httpPort=validPort(locationLike.port||7777,7777);
  const parameters=new URLSearchParams(locationLike.search||'');
  const port=validPort(parameters.get('rt'),httpPort+1);
  const host=realtimeHost(parameters.get('device'),locationLike.hostname);
  const protocol=locationLike.protocol==='https:'?'wss:':'ws:';
  return `${protocol}//${host}:${port}/realtime`;
}

export async function mountInspector(root=document) {
  const {RealtimeSession}=await import('./realtime-session.js');
  const stateEl=root.getElementById('state');
  const logEl=root.getElementById('log');
  const statusEl=root.getElementById('status');
  const revisionEl=root.getElementById('revision');
  const url=realtimeUrl();
  root.getElementById('endpoint').textContent=url;
  const session=new RealtimeSession({socketFactory:value=>new WebSocket(value),url,channels:['device','control','script','grid']});
  const log=(value)=>{const line=`${new Date().toLocaleTimeString()} ${value}\n`;logEl.textContent=(line+logEl.textContent).slice(0,12000);};
  session.addEventListener('state',event=>{const state=event.detail;statusEl.textContent=state.status;revisionEl.textContent=state.revision??'—';stateEl.textContent=JSON.stringify(state.data,null,2);});
  session.addEventListener('command',event=>log(`${event.detail.status} ${event.detail.id}${event.detail.error?`: ${event.detail.error}`:''}`));
  session.addEventListener('protocolerror',event=>log(`protocol error: ${event.detail.message}`));
  session.addEventListener('reconnectscheduled',event=>log(`reconnect in ${event.detail.delay} ms`));
  root.querySelectorAll('[data-enc]').forEach(button=>button.addEventListener('click',()=>session.command({target:'control',action:'enc',args:{n:Number(button.dataset.enc),d:Number(button.dataset.delta)}})));
  root.querySelectorAll('[data-key]').forEach(button=>{
    const n=Number(button.dataset.key);
    const down=()=>session.command({target:'control',action:'key',args:{n,z:1}});
    const up=()=>session.command({target:'control',action:'key',args:{n,z:0}});
    button.addEventListener('pointerdown',down);button.addEventListener('pointerup',up);button.addEventListener('pointercancel',up);button.addEventListener('pointerleave',event=>{if(event.buttons)up();});
  });
  root.getElementById('param-form').addEventListener('submit',event=>{event.preventDefault();const id=root.getElementById('param-id').value.trim();const value=Number(root.getElementById('param-value').value);session.command({target:'param',action:'set',args:{id,value}},{delivery:'coalescible',key:`param:${id}`,final:true});});
  root.getElementById('ping').addEventListener('click',()=>session.command({target:'system',action:'ping'}));
  root.getElementById('reconnect').addEventListener('click',()=>{session.disconnect();session.connect();});
  session.connect();
  return session;
}
