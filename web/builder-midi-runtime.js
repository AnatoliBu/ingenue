import {BuilderError} from './builder-core.js';
import {parseMidiMessage,relativeDelta} from './midi-core.js';
import {boundedDelta} from './builder-dom.js';

export class BuilderMidiRuntime{
  constructor({navigatorLike,onStatus,command}){this.navigatorLike=navigatorLike;this.onStatus=onStatus;this.command=command;this.access=null;this.inputs=new Map();this.widgets=[];this.held=new Map();this.enabled=false;this.onStateChange=()=>this.refreshInputs();}
  setWidgets(widgets){this.releaseAll();this.widgets=widgets.filter(widget=>widget.type==='midi');this.report();}
  report(){this.onStatus(this.enabled?`${this.inputs.size} MIDI input${this.inputs.size===1?'':'s'}`:'permission required');}
  async enable(){if(typeof this.navigatorLike.requestMIDIAccess!=='function')throw new BuilderError('Web MIDI is unavailable in this browser context');if(!this.access){this.access=await this.navigatorLike.requestMIDIAccess({sysex:false});this.access.onstatechange=this.onStateChange;}this.enabled=true;await this.refreshInputs();this.report();return this.inputs.size;}
  async refreshInputs(){const connected=new Map();for(const input of this.access?.inputs?.values?.()||[]){if(input.state&&input.state!=='connected')continue;connected.set(input.id,input);}let removed=false;for(const [id,input] of this.inputs){if(connected.has(id))continue;removed=true;input.onmidimessage=null;try{await input.close?.();}catch{}this.inputs.delete(id);}for(const [id,input] of connected){if(this.inputs.has(id))continue;try{await input.open?.();}catch{}input.onmidimessage=event=>this.receive(event.data);this.inputs.set(id,input);}if(removed||!this.inputs.size)this.releaseAll();this.report();}
  receive(data){const event=parseMidiMessage(data);if(!event)return;for(const widget of this.widgets)this.apply(widget,event);}
  matches(widget,event){return widget.source.type===event.type&&widget.source.channel===event.channel&&(widget.source.type==='pitchbend'||widget.source.number===event.number);}
  apply(widget,event){if(!this.matches(widget,event))return;const target=widget.target;if(target.kind==='key'){const key=`${widget.id}:${target.n}`;if(event.gate&&!this.held.has(key)){this.held.set(key,target.n);this.command({target:'control',action:'key',args:{n:target.n,z:1}});}else if(!event.gate&&this.held.has(key)){this.held.delete(key);this.command({target:'control',action:'key',args:{n:target.n,z:0}});}return;}if(target.kind==='encoder'){const delta=relativeDelta(event,widget.mode);if(delta)boundedDelta(part=>this.command({target:'control',action:'enc',args:{n:target.n,d:part}}),delta);return;}if(widget.mode==='absolute')this.command({target:'param',action:'set_normalized',args:{id:target.id,value:event.normalized}});else{const delta=relativeDelta(event,widget.mode);if(delta)this.command({target:'param',action:'delta',args:{id:target.id,d:delta}});}}
  releaseAll(){for(const n of this.held.values())this.command({target:'control',action:'key',args:{n,z:0}});this.held.clear();}
  destroy(){this.releaseAll();if(this.access)this.access.onstatechange=null;for(const input of this.inputs.values()){input.onmidimessage=null;try{input.close?.();}catch{}}this.inputs.clear();}
}
