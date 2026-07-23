export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

export function summarize(values) {
  const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  return {count:sorted.length,min_ms:sorted.length?Number(sorted[0].toFixed(2)):null,mean_ms:mean==null?null:Number(mean.toFixed(2)),p50_ms:percentile(sorted,.5),p95_ms:percentile(sorted,.95),p99_ms:percentile(sorted,.99),max_ms:sorted.length?Number(sorted.at(-1).toFixed(2)):null};
}

export async function runPool(total, width, operation) {
  const values=[], errors=[]; let next=0;
  async function worker(){ while(true){ const index=next++; if(index>=total)return; try{values.push(await operation(index));}catch(error){errors.push(String(error?.message||error));}} }
  await Promise.all(Array.from({length:Math.min(Math.max(1,width),total)},worker));
  return {values,errors};
}

export function createHttpProbe({fetchImpl=fetch,now=()=>performance.now(),url}){
  return async()=>{const started=now();const response=await fetchImpl(url,{cache:'no-store'});await response.text();if(!response.ok)throw new Error(`HTTP ${response.status}`);return now()-started;};
}

export function createWebSocketConnectProbe({WebSocketImpl=WebSocket,now=()=>performance.now(),url,timeoutMs=5000}){
  return()=>new Promise((resolve,reject)=>{const started=now();const socket=new WebSocketImpl(url);const timeout=setTimeout(()=>{try{socket.close();}catch{}reject(new Error(`WebSocket timeout after ${timeoutMs} ms`));},timeoutMs);socket.addEventListener('open',()=>{clearTimeout(timeout);const elapsed=now()-started;socket.close();resolve(elapsed);},{once:true});socket.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('WebSocket connection failed'));},{once:true});});
}

export function createMatronRoundTripProbe({WebSocketImpl=WebSocket,now=()=>performance.now(),url,timeoutMs=3000,tokenFactory=()=>`ING_ACK_${Math.random().toString(36).slice(2)}`}){
  return()=>new Promise((resolve,reject)=>{const token=tokenFactory();const started=now();const socket=new WebSocketImpl(url);let timeout;const fail=message=>{clearTimeout(timeout);try{socket.close();}catch{}reject(new Error(message));};socket.addEventListener('open',()=>{timeout=setTimeout(()=>fail(`Matron acknowledgement timeout after ${timeoutMs} ms`),timeoutMs);socket.send(`print(${JSON.stringify(token)})`);},{once:true});socket.addEventListener('message',event=>{if(String(event.data).includes(token)){clearTimeout(timeout);const elapsed=now()-started;socket.close();resolve(elapsed);} });socket.addEventListener('error',()=>fail('Matron WebSocket failed'),{once:true});});
}

export function createOscControlRoundTripProbe({WebSocketImpl=WebSocket,fetchImpl=fetch,now=()=>performance.now(),wsUrl,ctlUrl,timeoutMs=3000,tokenFactory=()=>`INGOSC_${Math.random().toString(36).slice(2)}`}){
  const ready='ING_OSC_PROBE_READY';
  const install=`do local prefix="/param/__ingenue_probe_" if _ing_probe_fn==nil then _ing_probe_prev=_norns.osc.event _ing_probe_fn=function(path,args,from) if type(path)=="string" and path:sub(1,#prefix)==prefix then print(path:sub(#prefix+1)) return end if _ing_probe_prev then return _ing_probe_prev(path,args,from) end end end if _norns.osc.event~=_ing_probe_fn then _ing_probe_prev=_norns.osc.event _norns.osc.event=_ing_probe_fn end print("${ready}") end`;
  return()=>new Promise((resolve,reject)=>{
    const token=tokenFactory().replace(/[^A-Za-z0-9_-]/g,'').slice(0,64);
    if(!token){reject(new Error('OSC probe token is empty'));return;}
    const socket=new WebSocketImpl(wsUrl);let timeout,started=null,sent=false;
    const fail=message=>{clearTimeout(timeout);try{socket.close();}catch{}reject(new Error(message));};
    socket.addEventListener('open',()=>{timeout=setTimeout(()=>fail(`OSC control acknowledgement timeout after ${timeoutMs} ms`),timeoutMs);socket.send(install);},{once:true});
    socket.addEventListener('message',async event=>{
      const data=String(event.data);
      if(!sent && data.includes(ready)){
        sent=true;started=now();
        try{const response=await fetchImpl(ctlUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k:'param',id:`__ingenue_probe_${token}`,v:1})});if(!response.ok)return fail(`OSC control HTTP ${response.status}`);}catch(error){return fail(`OSC control request failed: ${error?.message||error}`);}return;
      }
      if(sent && data.includes(token)){clearTimeout(timeout);const elapsed=now()-started;socket.close();resolve(elapsed);}
    });
    socket.addEventListener('error',()=>fail('OSC probe WebSocket failed'),{once:true});
  });
}

export function matronWebSocketUrl(locationLike=location){
  const protocol=locationLike.protocol==='https:'?'wss':'ws';
  return `${protocol}://${locationLike.hostname}:5555/`;
}

export async function runTransportDiagnostics(options={}){
  const samples=Math.max(10,Number(options.samples||100));
  const concurrency=Math.max(1,Math.min(32,Number(options.concurrency||8)));
  const httpUrl=options.httpUrl||new URL('api/version',location.href).href;
  const ctlUrl=options.ctlUrl||new URL('api/ctl',location.href).href;
  const wsUrl=options.wsUrl||matronWebSocketUrl();
  const httpProbe=options.httpProbe||createHttpProbe({url:httpUrl});
  const wsConnectProbe=options.wsConnectProbe||createWebSocketConnectProbe({url:wsUrl});
  const matronProbe=options.matronProbe||createMatronRoundTripProbe({url:wsUrl});
  const oscControlProbe=options.oscControlProbe||createOscControlRoundTripProbe({wsUrl,ctlUrl});
  const onProgress=options.onProgress||(()=>{});
  onProgress('http_serial');const serialHttp=await runPool(samples,1,httpProbe);
  onProgress('http_concurrent');const concurrentHttp=await runPool(samples,concurrency,httpProbe);
  onProgress('websocket_connect');const wsConnect=await runPool(Math.min(samples,30),1,wsConnectProbe);
  onProgress('matron_roundtrip');const matronRoundTrip=await runPool(Math.min(samples,50),1,matronProbe);
  onProgress('osc_control_roundtrip');const oscControlRoundTrip=await runPool(Math.min(samples,50),1,oscControlProbe);
  onProgress('done');
  return {benchmark_version:4,started_at:new Date().toISOString(),page:typeof location==='undefined'?null:location.href,user_agent:typeof navigator==='undefined'?null:navigator.userAgent,online:typeof navigator==='undefined'?null:navigator.onLine,config:{samples,concurrency,httpUrl,ctlUrl,wsUrl},http_serial:{latency:summarize(serialHttp.values),errors:serialHttp.errors},http_concurrent:{latency:summarize(concurrentHttp.values),errors:concurrentHttp.errors},websocket_connect:{latency:summarize(wsConnect.values),errors:wsConnect.errors},matron_roundtrip:{latency:summarize(matronRoundTrip.values),errors:matronRoundTrip.errors},osc_control_roundtrip:{latency:summarize(oscControlRoundTrip.values),errors:oscControlRoundTrip.errors},limits:['OSC control round-trip measures browser → Ingenue HTTP → UDP OSC → matron Lua → browser.','The probe does not touch audio state and does not measure audio latency.','Real script commands still need protocol-level command ids and authoritative state revisions.']};
}

function metricRow(label,result){const l=result?.latency||{};return `<tr><td>${label}</td><td>${l.count??0}</td><td>${l.p50_ms??'—'}</td><td>${l.p95_ms??'—'}</td><td>${l.p99_ms??'—'}</td><td>${result?.errors?.length??0}</td></tr>`;}
export function renderReport(report){return `<table><thead><tr><th>probe</th><th>n</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>errors</th></tr></thead><tbody>${metricRow('HTTP serial',report.http_serial)}${metricRow('HTTP concurrent',report.http_concurrent)}${metricRow('WS connect',report.websocket_connect)}${metricRow('Matron Lua round-trip',report.matron_roundtrip)}${metricRow('OSC control round-trip',report.osc_control_roundtrip)}</tbody></table>`;}
export function mountDiagnostics(root=document){const run=root.getElementById('run'),copy=root.getElementById('copy'),status=root.getElementById('status'),results=root.getElementById('results'),raw=root.getElementById('raw');let lastReport=null;run.addEventListener('click',async()=>{run.disabled=true;copy.disabled=true;results.innerHTML='';raw.textContent='';try{lastReport=await runTransportDiagnostics({samples:Number(root.getElementById('samples').value),concurrency:Number(root.getElementById('concurrency').value),onProgress:stage=>{status.textContent=stage.replaceAll('_',' ')+'…';}});status.textContent='complete';results.innerHTML=renderReport(lastReport);raw.textContent=JSON.stringify(lastReport,null,2);copy.disabled=false;}catch(error){status.textContent=`failed: ${error?.message||error}`;}finally{run.disabled=false;}});copy.addEventListener('click',async()=>{if(!lastReport)return;await navigator.clipboard.writeText(JSON.stringify(lastReport,null,2));status.textContent='report copied';});}
