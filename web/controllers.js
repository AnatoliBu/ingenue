import {RealtimeSession} from './realtime-session.js';
import {realtimeUrl} from './realtime-inspector.js';
import {buildControllerReadiness} from './controllers-core.js';

function createCard(item) {
  const link = document.createElement('a');
  link.className = 'hub-card';
  link.href = item.href;
  link.dataset.status = item.status;
  const badge = document.createElement('span');
  badge.className = 'hub-status';
  badge.textContent = item.status;
  const title = document.createElement('strong');
  title.textContent = item.label;
  const detail = document.createElement('p');
  detail.textContent = item.detail;
  link.append(badge, title, detail);
  return link;
}

export function mountControllerHub(root=document, options={}) {
  const url=options.url||realtimeUrl(options.locationLike||location);
  const session=options.session||new RealtimeSession({
    socketFactory:value=>new WebSocket(value), url,
    channels:['device','control','script','grid','arc','params'],
  });
  const endpoint=root.getElementById('hub-endpoint');
  const status=root.getElementById('hub-connection');
  const revision=root.getElementById('hub-revision');
  const script=root.getElementById('hub-script');
  const summary=root.getElementById('hub-summary');
  const cards=root.getElementById('hub-cards');
  const pingButton=root.getElementById('hub-ping');
  const pingOutput=root.getElementById('hub-ping-output');
  endpoint.textContent=url;

  let hello=null;
  let state=session.snapshot();
  let pingMs=null;
  const pings=new Map();
  const now=()=>globalThis.performance?.now?.()??Date.now();
  const environment={
    webMidiSupported:typeof globalThis.navigator?.requestMIDIAccess==='function',
    secureContext:globalThis.isSecureContext===true,
  };

  const render=()=>{
    const readiness=buildControllerReadiness({hello,state,pingMs,...environment});
    status.textContent=state.status;
    revision.textContent=state.revision??'—';
    script.textContent=readiness.scriptName;
    summary.textContent=readiness.protocolReady
      ? `${readiness.readyCount}/${readiness.cards.length} surfaces ready${readiness.warningCount ? ` · ${readiness.warningCount} limited` : ''}`
      : 'Waiting for realtime hello + authoritative snapshot…';
    cards.replaceChildren(...readiness.cards.map(createCard));
    pingButton.disabled=!readiness.protocolReady||pings.size>0;
    pingButton.dataset.disabled=pingButton.disabled?'true':'false';
    pingOutput.textContent=Number.isFinite(pingMs)?`${Math.round(pingMs)} ms`:'not checked';
  };

  pingButton.addEventListener('click',()=>{
    if(pingButton.disabled)return;
    const id=session.command({target:'system',action:'ping',args:{}});
    pings.set(id,now());
    render();
  });
  session.addEventListener('hello',event=>{hello=event.detail;render();});
  session.addEventListener('state',event=>{state=event.detail;render();});
  session.addEventListener('command',event=>{
    const started=pings.get(event.detail.id);
    if(started==null)return;
    pings.delete(event.detail.id);
    if(event.detail.status==='ack')pingMs=now()-started;
    else pingMs=null;
    render();
  });
  session.addEventListener('protocolerror',event=>{summary.textContent=`Protocol error: ${event.detail.message}`;});
  render();
  session.connect();
  return session;
}
