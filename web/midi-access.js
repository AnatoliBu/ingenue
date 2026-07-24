function validPort(value,fallback){const port=Number(value);return Number.isInteger(port)&&port>0&&port<65536?port:fallback;}
function bridgeHost(value){const host=String(value||'').trim();return /^[A-Za-z0-9_.:-]+$/.test(host)?host:'norns.local';}

export function midiBridgeDetails(locationLike=globalThis.location,localPort=7780){
  const parameters=new URLSearchParams(locationLike?.search||'');
  const httpPort=validPort(locationLike?.port||7777,7777);
  const device=bridgeHost(parameters.get('device')||locationLike?.hostname||'norns.local');
  const realtimePort=validPort(parameters.get('rt'),httpPort+1);
  const query=new URLSearchParams({device,rt:String(realtimePort),bridge:'localhost'});
  return {
    device,httpPort,realtimePort,localPort,
    command:`python3 midi-local.py --device ${device} --device-port ${httpPort} --realtime-port ${realtimePort} --open`,
    url:`http://localhost:${localPort}/midi.html?${query}`,
  };
}

export function midiAvailability(navigatorLike=globalThis.navigator,isSecure=globalThis.isSecureContext,locationLike=globalThis.location) {
  if (!isSecure) return {
    ok:false,code:'insecure',recoverable:true,
    message:'This browser blocks Web MIDI on an ordinary LAN HTTP origin. Run Ingenue through the localhost MIDI bridge on this computer.',
    bridge:midiBridgeDetails(locationLike),
  };
  if (!navigatorLike || typeof navigatorLike.requestMIDIAccess !== 'function') return {ok:false,code:'unsupported',recoverable:false,message:'This browser does not expose the Web MIDI API. Use a desktop Chromium-based browser for the local bridge.'};
  return {ok:true,code:'ready',recoverable:false,message:'Web MIDI is available.'};
}
export function midiPorts(access) {
  const normalize=port=>({id:String(port.id||''),name:String(port.name||'Unnamed MIDI port'),manufacturer:String(port.manufacturer||''),state:String(port.state||''),connection:String(port.connection||''),port});
  return {inputs:Array.from(access?.inputs?.values?.()||[],normalize),outputs:Array.from(access?.outputs?.values?.()||[],normalize)};
}
export async function requestMidiAccess(navigatorLike=globalThis.navigator) {
  return navigatorLike.requestMIDIAccess({sysex:false,software:false});
}
