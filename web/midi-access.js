function validPort(value,fallback){const port=Number(value);return Number.isInteger(port)&&port>0&&port<65536?port:fallback;}
function bridgeHost(value){const host=String(value||'').trim();return /^[A-Za-z0-9_.:-]+$/.test(host)?host:'norns.local';}
function queryHost(host){return host.includes(':')&&!host.startsWith('[')?`[${host}]`:host;}
function platformName(platformLike){return String(platformLike?.userAgentData?.platform||platformLike?.platform||'');}
function singleQuote(value){return `'${String(value).replaceAll("'","''")}'`;}

function helperUrl(locationLike,device,httpPort){
  const explicit=String(locationLike?.origin||'');
  if(explicit&&explicit!=='null')return `${explicit.replace(/\/$/,'')}/midi-local.py`;
  const protocol=String(locationLike?.protocol||'http:');
  return `${protocol}//${queryHost(device)}:${httpPort}/midi-local.py`;
}

function bridgeCommand({device,httpPort,realtimePort,sourceUrl,windows}){
  const args=`--device ${singleQuote(device)} --device-port ${httpPort} --realtime-port ${realtimePort} --open`;
  if(windows){
    return `$p=Join-Path $env:TEMP 'ingenue-midi-local.py'; Invoke-WebRequest -UseBasicParsing ${singleQuote(sourceUrl)} -OutFile $p; py $p ${args}`;
  }
  return `p="\${TMPDIR:-/tmp}/ingenue-midi-local.py"; curl -fsSL ${singleQuote(sourceUrl)} -o "$p" && python3 "$p" ${args}`;
}

export function midiBridgeDetails(locationLike=globalThis.location,localPort=7780,platformLike=globalThis.navigator){
  const parameters=new URLSearchParams(locationLike?.search||'');
  const httpPort=validPort(locationLike?.port||7777,7777);
  const device=bridgeHost(parameters.get('device')||locationLike?.hostname||'norns.local');
  const realtimePort=validPort(parameters.get('rt'),httpPort+1);
  const query=new URLSearchParams({device,rt:String(realtimePort),bridge:'localhost'});
  const windows=/win/i.test(platformName(platformLike));
  const sourceUrl=helperUrl(locationLike,device,httpPort);
  return {
    device,httpPort,realtimePort,localPort,windows,sourceUrl,
    command:bridgeCommand({device,httpPort,realtimePort,sourceUrl,windows}),
    repositoryCommand:windows
      ? `py web\\midi-local.py --device ${device} --device-port ${httpPort} --realtime-port ${realtimePort} --open`
      : `python3 web/midi-local.py --device ${device} --device-port ${httpPort} --realtime-port ${realtimePort} --open`,
    url:`http://localhost:${localPort}/midi.html?${query}`,
  };
}

export function midiAvailability(navigatorLike=globalThis.navigator,isSecure=globalThis.isSecureContext,locationLike=globalThis.location,platformLike=navigatorLike) {
  if (!isSecure) return {
    ok:false,code:'insecure',recoverable:true,
    message:'This browser blocks Web MIDI on an ordinary LAN HTTP origin. Run Ingenue through the localhost MIDI bridge on this computer.',
    bridge:midiBridgeDetails(locationLike,7780,platformLike),
  };
  if (!navigatorLike || typeof navigatorLike.requestMIDIAccess !== 'function') return {ok:false,code:'unsupported',recoverable:false,message:'This browser does not expose the Web MIDI API. Use a desktop Chromium-based browser for the local bridge.'};
  return {ok:true,code:'ready',recoverable:false,message:'Web MIDI is available.'};
}
export function midiPorts(access) {
  const normalize=port=>({id:String(port.id||''),name:String(port.name||'Unnamed MIDI port'),manufacturer:String(port.manufacturer||''),state:String(port.state||''),connection:String(port.connection||''),port});
  const connected=port=>port&&port.state!=='disconnected'&&String(port.id||'');
  return {
    inputs:Array.from(access?.inputs?.values?.()||[]).filter(connected).map(normalize),
    outputs:Array.from(access?.outputs?.values?.()||[]).filter(connected).map(normalize),
  };
}
export async function requestMidiAccess(navigatorLike=globalThis.navigator) {
  return navigatorLike.requestMIDIAccess({sysex:false,software:false});
}
