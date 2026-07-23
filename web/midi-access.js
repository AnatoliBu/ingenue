export function midiAvailability(navigatorLike=globalThis.navigator,isSecure=globalThis.isSecureContext) {
  if (!isSecure) return {ok:false,code:'insecure',message:'Web MIDI requires HTTPS or a trustworthy localhost context.'};
  if (!navigatorLike || typeof navigatorLike.requestMIDIAccess !== 'function') return {ok:false,code:'unsupported',message:'This browser does not expose the Web MIDI API.'};
  return {ok:true,code:'ready',message:'Web MIDI is available.'};
}
export function midiPorts(access) {
  const normalize=port=>({id:String(port.id||''),name:String(port.name||'Unnamed MIDI port'),manufacturer:String(port.manufacturer||''),state:String(port.state||''),connection:String(port.connection||''),port});
  return {inputs:Array.from(access?.inputs?.values?.()||[],normalize),outputs:Array.from(access?.outputs?.values?.()||[],normalize)};
}
export async function requestMidiAccess(navigatorLike=globalThis.navigator) {
  return navigatorLike.requestMIDIAccess({sysex:false,software:false});
}
