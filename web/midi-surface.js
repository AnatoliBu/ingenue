import {RealtimeSession} from './realtime-session.js';
import {realtimeUrl} from './realtime-inspector.js';
import {deviceFingerprint,parseMidiMessage,ProfileStore,sourceKey,validateMapping} from './midi-core.js';
import {midiAvailability,midiPorts,requestMidiAccess} from './midi-access.js';
import {MidiRuntime} from './midi-runtime.js';

class AppliedBroker {
  constructor(session){this.session=session;this.pending=new Map();}
  request(command){return new Promise((resolve,reject)=>{const id=this.session.command(command);this.pending.set(id,{resolve,reject});});}
  settle(detail){const pending=this.pending.get(detail.id);if(!pending)return false;this.pending.delete(detail.id);if(detail.status==='ack')pending.resolve(detail);else pending.reject(new Error(detail.error||detail.status));return true;}
  clear(reason='session changed'){for(const {reject} of this.pending.values())reject(new Error(reason));this.pending.clear();}
}

function option(value,label){const node=document.createElement('option');node.value=value;node.textContent=label;return node;}
function portLabel(port){return [port.manufacturer,port.name].filter(Boolean).join(' · ')||port.id;}
function mappingLabel(mapping){const source=sourceKey(mapping.source);if(mapping.target.kind==='param')return `${source} → param ${mapping.target.id} (${mapping.mode}${mapping.pickup?' + pickup':''})`;return `${source} → ${mapping.target.kind==='key'?'K':'E'}${mapping.target.n}${mapping.target.kind==='encoder'?` (${mapping.mode})`:''}`;}
function uid(){return globalThis.crypto?.randomUUID?.()||`map-${Date.now()}-${Math.random().toString(36).slice(2)}`;}

export function mountMidiSurface(root=document,env={}){
  const navigatorLike=env.navigatorLike||navigator;
  const secure=env.isSecureContext??globalThis.isSecureContext;
  const storage=env.storage||localStorage;
  const session=env.session||new RealtimeSession({socketFactory:value=>new WebSocket(value),url:env.url||realtimeUrl(env.locationLike||location),channels:['device','control','script']});
  const broker=new AppliedBroker(session);
  const store=new ProfileStore(storage);
  const status=root.getElementById('midi-status');
  const notice=root.getElementById('midi-notice');
  const scriptEl=root.getElementById('midi-script');
  const permission=root.getElementById('midi-permission');
  const inputSelect=root.getElementById('midi-input');
  const outputsEl=root.getElementById('midi-outputs');
  const monitor=root.getElementById('midi-monitor');
  const learnButton=root.getElementById('midi-learn');
  const targetKind=root.getElementById('midi-target-kind');
  const targetValue=root.getElementById('midi-target-value');
  const modeSelect=root.getElementById('midi-mode');
  const pickup=root.getElementById('midi-pickup');
  const mappingsEl=root.getElementById('midi-mappings');

  let access=null,currentInput=null,currentFingerprint=null,currentScript=null,mappings=[],learning=false;
  const runtime=new MidiRuntime({
    send:command=>session.command(command),
    describe:id=>broker.request({target:'param',action:'describe',args:{id}}).then(detail=>detail.result?.param),
  });

  const setNotice=(message,error=false)=>{notice.textContent=message||'';notice.dataset.error=error?'true':'false';};
  const contextReady=()=>Boolean(currentScript&&currentInput&&session.state.status==='synced');
  const updateLearnEnabled=()=>{learnButton.disabled=!contextReady();};

  async function activateProfile(){
    runtime.deactivate();broker.clear('profile changed');
    if(!currentScript||!currentInput){mappings=[];renderMappings();updateLearnEnabled();return;}
    currentFingerprint=deviceFingerprint(currentInput);
    mappings=store.load(currentScript,currentFingerprint);renderMappings();updateLearnEnabled();
    try{await runtime.activate(mappings);setNotice(mappings.length?`${mappings.length} mapping(s) active for this exact script and device.`:'No mappings yet. Choose a target and press Learn.');}
    catch(error){setNotice(`Profile inactive: ${error.message}`,true);}
  }

  function saveProfile(){if(!currentScript||!currentFingerprint)return;store.save(currentScript,currentFingerprint,mappings);}
  function renderMappings(){
    const fragment=document.createDocumentFragment();
    mappings.forEach(mapping=>{const row=document.createElement('div');row.className='mapping-row';const text=document.createElement('span');text.textContent=mappingLabel(mapping);const remove=document.createElement('button');remove.type='button';remove.textContent='remove';remove.addEventListener('click',async()=>{mappings=mappings.filter(item=>item.id!==mapping.id);saveProfile();renderMappings();await activateProfile();});row.append(text,remove);fragment.append(row);});
    if(!mappings.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='No mappings for this script/device profile.';fragment.append(empty);}
    mappingsEl.replaceChildren(fragment);
  }

  function mappingFromEvent(event){
    const kind=targetKind.value;let target;
    if(kind==='param')target={kind,id:targetValue.value.trim()};
    else target={kind,n:Number(targetValue.value)};
    return validateMapping({id:uid(),source:{type:event.type,channel:event.channel,number:event.number},target,mode:modeSelect.value,pickup:pickup.checked});
  }

  async function receiveMidi(messageEvent){
    const event=parseMidiMessage(messageEvent.data);if(!event)return;
    monitor.textContent=`${event.type} ch${event.channel}${event.number==null?'':` #${event.number}`} raw ${event.raw}`;
    if(learning){
      if(event.type==='note'&&!event.gate)return;
      try{const mapping=mappingFromEvent(event);mappings.push(mapping);saveProfile();learning=false;learnButton.textContent='Learn next MIDI message';renderMappings();await activateProfile();setNotice(`Learned ${mappingLabel(mapping)}`);}
      catch(error){learning=false;learnButton.textContent='Learn next MIDI message';setNotice(`Learn failed: ${error.message}`,true);}return;
    }
    try{runtime.handle(event);}catch(error){setNotice(`MIDI event rejected: ${error.message}`,true);}
  }

  async function selectInput(){
    if(currentInput){currentInput.onmidimessage=null;try{await currentInput.close?.();}catch{}}
    currentInput=access?.inputs?.get(inputSelect.value)||null;
    if(currentInput){try{await currentInput.open?.();}catch{}currentInput.onmidimessage=receiveMidi;}
    await activateProfile();
  }

  function renderPorts(){
    const ports=midiPorts(access);const old=inputSelect.value;const fragment=document.createDocumentFragment();fragment.append(option('','select MIDI input'));
    ports.inputs.forEach(item=>fragment.append(option(item.id,portLabel(item))));inputSelect.replaceChildren(fragment);
    inputSelect.value=ports.inputs.some(item=>item.id===old)?old:(ports.inputs[0]?.id||'');
    outputsEl.textContent=ports.outputs.length?ports.outputs.map(portLabel).join(', '):'no MIDI outputs';
    selectInput();
  }

  permission.addEventListener('click',async()=>{
    const availability=midiAvailability(navigatorLike,secure);if(!availability.ok){setNotice(availability.message,true);return;}
    permission.disabled=true;setNotice('Requesting MIDI permission…');
    try{access=await requestMidiAccess(navigatorLike);access.onstatechange=renderPorts;renderPorts();setNotice('MIDI permission granted.');}
    catch(error){setNotice(`MIDI permission failed: ${error.name||error.message}`,true);}
    finally{permission.disabled=false;}
  });
  inputSelect.addEventListener('change',selectInput);
  learnButton.addEventListener('click',()=>{if(!contextReady())return;learning=!learning;learnButton.textContent=learning?'Cancel learn':'Learn next MIDI message';setNotice(learning?'Move one MIDI control now.':'Learn cancelled.');});
  targetKind.addEventListener('change',()=>{
    if(targetKind.value==='encoder'){modeSelect.value='relative-twos';pickup.checked=false;targetValue.value='1';}
    else if(targetKind.value==='key'){targetValue.value='1';pickup.checked=false;}
    else {targetValue.value='cutoff';modeSelect.value='absolute';pickup.checked=true;}
  });

  session.addEventListener('state',event=>{
    status.textContent=event.detail.status;const script=event.detail.data?.script;const next=script?.active?script.name:null;scriptEl.textContent=next||'no active script';
    if(next!==currentScript){currentScript=next;activateProfile();}updateLearnEnabled();
  });
  session.addEventListener('command',event=>{runtime.settle(event.detail);broker.settle(event.detail);if(event.detail.status==='reject')setNotice(event.detail.error||'Command rejected',true);});
  session.addEventListener('protocolerror',event=>setNotice(`Protocol error: ${event.detail.message}`,true));

  const availability=midiAvailability(navigatorLike,secure);if(!availability.ok){permission.disabled=true;setNotice(availability.message,true);}else setNotice('Grant MIDI permission, then select an input.');
  updateLearnEnabled();session.connect();return {session,runtime};
}
