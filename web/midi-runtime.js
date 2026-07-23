import {MidiError,SoftTakeover,mappingMatches,relativeDelta,validateMapping} from './midi-core.js';

class LatestValueLane {
  constructor(send, register) { this.send=send;this.register=register;this.inflight=null;this.queued=null; }
  push(value){if(this.inflight){this.queued=value;return null;}return this.#dispatch(value);}
  settle(id,status){
    if(!this.inflight||this.inflight.id!==id)return null;
    const completed=this.inflight;this.inflight=null;
    const desired=this.queued;this.queued=null;
    if(status==='uncertain')return this.#dispatch(desired??completed.value);
    if(status!=='ack')return null;
    if(desired==null)return null;
    return this.#dispatch(desired);
  }
  #dispatch(value){const id=this.send(value);if(typeof id!=='string'||!id)throw new MidiError('MIDI command sender must return an id');this.inflight={id,value};this.register(id,this);return id;}
}

export class MidiRuntime {
  constructor({send,describe}) {
    if(typeof send!=='function'||typeof describe!=='function')throw new MidiError('send and describe callbacks are required');
    this.send=send;this.describe=describe;this.mappings=[];this.states=new Map();this.commandOwners=new Map();this.generation=0;
  }
  async activate(mappings) {
    const generation=++this.generation;this.mappings=mappings.map(validateMapping);this.states.clear();this.commandOwners.clear();
    try {
      await Promise.all(this.mappings.map(async mapping=>{
        const state={mapping,lastGate:null,pickup:null,descriptor:null,lane:null};
        if(mapping.target.kind==='param'&&mapping.mode==='absolute'){
          const descriptor=await this.describe(mapping.target.id);
          if(generation!==this.generation)return;
          if(!descriptor||descriptor.writable===false)throw new MidiError(`parameter ${mapping.target.id} is not writable from normalized MIDI`);
          state.descriptor=descriptor;
          state.pickup=new SoftTakeover();state.pickup.arm(Number(descriptor.normalized));
          state.lane=new LatestValueLane(value=>this.send({target:'param',action:'set_normalized',args:{id:mapping.target.id,value}}),(id,lane)=>this.commandOwners.set(id,{state,lane}));
        }
        if(generation===this.generation)this.states.set(mapping.id,state);
      }));
    } catch(error){if(generation===this.generation)this.deactivate();throw error;}
    return this.states.size;
  }
  deactivate(){this.generation++;this.mappings=[];this.states.clear();this.commandOwners.clear();}
  handle(event){
    const ids=[];
    for(const mapping of this.mappings){
      if(!mappingMatches(mapping,event))continue;
      const state=this.states.get(mapping.id);if(!state)continue;
      if(mapping.target.kind==='param'){
        if(mapping.mode==='absolute'){
          if(mapping.pickup&&!state.pickup.accept(event.normalized))continue;
          const id=state.lane.push(event.normalized);if(id)ids.push(id);
        }else{
          const d=relativeDelta(event,mapping.mode);if(!d)continue;
          ids.push(this.send({target:'param',action:'delta',args:{id:mapping.target.id,d}}));
        }
      }else if(mapping.target.kind==='encoder'){
        const d=relativeDelta(event,mapping.mode);if(!d)continue;
        ids.push(this.send({target:'control',action:'enc',args:{n:mapping.target.n,d:Math.max(-127,Math.min(127,d))}}));
      }else if(mapping.target.kind==='key'){
        const gate=Boolean(event.gate??event.normalized>=.5);
        if(state.lastGate===gate)continue;state.lastGate=gate;
        ids.push(this.send({target:'control',action:'key',args:{n:mapping.target.n,z:gate?1:0}}));
      }
    }
    return ids.filter(Boolean);
  }
  settle(detail){
    const owner=this.commandOwners.get(detail?.id);if(!owner)return null;
    this.commandOwners.delete(detail.id);
    const descriptor=detail.result?.param;
    if(detail.status==='ack'&&descriptor){owner.state.descriptor=descriptor;owner.state.pickup?.updateApplied(Number(descriptor.normalized));}
    return owner.lane.settle(detail.id,detail.status);
  }
}
