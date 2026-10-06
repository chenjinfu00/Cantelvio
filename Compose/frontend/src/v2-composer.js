/** Exact-score v2 adapter for the established performance Session API. */
import {Composer, METERS, mod12} from './composer.js';
import {R_REST} from '../vendor/lib/joint-model.js';
export class V2Composer {
  constructor({random=Math.random,planBar,onProgress=()=>{},getTempo=()=>92,fetcher=(...args)=>globalThis.fetch(...args)}={}){
    Object.assign(this,{random,planBar,onProgress,getTempo,fetcher});
    this.expression={};this.isV2=true;this.timeline=0;this.revision=0;this.waiters=[];this.session=null;this.busy=false;
    this.stats={positions:0,generatedSteps:0,rebuilds:0,rebuildPositions:0,lastChunkMs:0,maxChunkMs:0,msPerPosition:1};
  }
  reset({key,chord,melody}){
    this.stop();this.timeline++;this.revision++;this.seed=Math.floor(this.random()*999999999);
    this.steps=[];this.bars=[];this.locked=0;this.lockedBars=0;this.pruned=0;this.holds=[];this.clamps=new Map();this.target=0;this.notes=new Map();this.partial=null;this.error=null;this.settle();
    this.seedChord={...chord};this.seedKey={...key};
    const bar=this.newBar(0,null,key),step=this.newStep(0,bar);
    Object.assign(step,{R:R_REST,chord:{...chord},change:true,lastChange:0,bass:-1,mel:melody??-1});this.steps.push(step);
  }
  get frontier(){return this.steps.length;}
  getExactNotes(index){return this.notes.get(index)||[];}
  ensureBar(index){if(!this.barComplete(index))throw new Error('New model is preparing this bar');return this.bars[index];}
  releaseAfter(stream,g){return g+1;}
  lock(index){const bar=this.ensureBar(index);this.locked=bar.start+bar.barlen;this.lockedBars=index+1;
    const keep=Math.max(0,index-12),from=this.bars[keep].start;
    for(let g=this.pruned;g<from;g++)this.steps[g]=null;this.pruned=from;
    for(const k of this.notes.keys())if(k<keep)this.notes.delete(k);
    for(const k of this.clamps.keys())if(k<this.locked)this.clamps.delete(k);
    return {end:this.locked,holds:[]};
  }
  truncate(g){
    g=Math.max(this.locked,1,g);this.revision++;
    const bar=this.bars.find(b=>b.start<=g&&g<b.start+b.barlen);
    if(bar&&g>bar.start){this.partial={index:bar.index,cut:(g-bar.start)/4,
      notes:this.getExactNotes(bar.index).filter(n=>n.onsetQuarter<(g-bar.start)/4),
      spans:this.chordSpans(bar.index)?.filter(s=>s.step<g).map(s=>({offset:(s.step-bar.start)/4,...s.chord,bassPc:s.onsetBass,change:!s.continuation}))||[]};}
    else this.partial=null;
    this.steps.length=Math.min(this.steps.length,g);
    for(const k of this.notes.keys())if(k>=bar?.index)this.notes.delete(k);
    while(this.bars.length>this.lockedBars&&this.bars.at(-1).start>=g)this.bars.pop();
    for(const k of this.clamps.keys())if(k>=g)this.clamps.delete(k);
    this.onProgress();return g;
  }
  regenerateFromBar(index){index=Math.max(index,this.lockedBars);const bar=this.bars[index];if(!bar){this.revision++;return;}
    if(index===0){this.truncate(1);this.partial=null;this.replanFirstBar();}
    else {this.truncate(bar.start);this.bars.length=index;}
    this.kick();
  }
  replanFirstBar(){const first=this.bars[0];if(!first)return;const plan=this.planBar(0,null,this),meter=METERS[plan.cond.beats]||METERS[4];Object.assign(first,{cond:plan.cond,...meter,barlen:meter.barlen,signature:meter.signature});}
  edit(g,chord,bassPc=null){if(g<this.locked||g<1||g>=this.steps.length)return false;this.truncate(g);this.clamps.set(g,{chord:{...chord},bassPc});this.kick();return true;}
  prefetch(bars){if(this.error)return Promise.resolve(false);this.target=Math.max(this.target,bars);return new Promise(resolve=>{this.waiters.push({bars,timeline:this.timeline,resolve});this.settle();this.kick();});}
  positionsToRegenerate(){return 4;}
  setTarget(bars){this.target=bars;this.kick();}
  stop(){this.target=0;this.controller?.abort();this.controller=null;
    const session=this.session;this.session=null;
    if(session)this.fetcher('/api/four-pillar/perform-stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session}),keepalive:true}).catch(()=>{});
  }
  async kick(){
    if(this.busy||this.error||this.completeBars()>=this.target)return;
    this.busy=true;const timeline=this.timeline;
    try{
      while(timeline===this.timeline&&this.completeBars()<this.target){
        const index=this.completeBars(),revision=this.revision;
        let bar=this.bars[index];if(!bar)bar=this.newBar(index,this.bars[index-1]);
        const previous=this.steps[bar.start-1]?.chord||this.seedChord;
        const fixed=this.partial?.index===index?[...this.partial.spans]:[];
        if(index===0)fixed.push({offset:0,...this.seedChord});
        for(const [g,clamp] of this.clamps)if(g>=bar.start&&g<bar.start+bar.barlen)fixed.push({offset:(g-bar.start)/4,...clamp.chord,bassPc:clamp.bassPc});
        const args={session:this.session??undefined,index,seed:this.seed,chord:previous,key:bar.key,tempo:this.getTempo(),
          harmonyT:bar.cond.harmonyT,melodyT:bar.cond.melodyT,density:bar.cond.density,mode:bar.cond.mode,changeMode:bar.cond.changeMode,
          beats:bar.beats,meter:bar.signature.split('/').map(Number),fixed,cut:this.partial?.index===index?this.partial.cut:0,
          forceTonic:this.clamps.get(bar.start)?.reason==='key'};
        this.controller=new AbortController();const before=performance.now();
        const response=await this.fetcher('/api/four-pillar/perform',{method:'POST',headers:{'Content-Type':'application/json'},signal:this.controller.signal,body:JSON.stringify(args)});
        const data=await response.json();if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
        if(timeline!==this.timeline)return;
        this.session=data.session;
        if(revision!==this.revision)continue;
        const ms=performance.now()-before;this.stats.lastChunkMs=ms;this.stats.maxChunkMs=Math.max(ms,this.stats.maxChunkMs);this.stats.msPerPosition=ms/4;
        this.installBar(bar,data);this.partial=null;this.stats.generatedSteps+=bar.barlen;this.settle();this.onProgress();
      }
    }catch(error){if(timeline===this.timeline&&error.name!=='AbortError'){this.error=error;for(const w of this.waiters)w.resolve(false);this.waiters=[];this.onProgress();}}
    finally{this.busy=false;if(this.completeBars()<this.target&&timeline!==this.timeline)this.kick();}
  }
  installBar(bar,data){
    const notes=data.notes.map(n=>({...n,groupLogits:['woodwinds','brass','percussion','keys','high_strings','low_strings'].map(g=>g===n.group?1:0)}));
    this.notes.set(bar.index,notes);let last=this.steps[bar.start-1]?.lastChange??bar.start;
    for(let pos=0;pos<bar.barlen;pos++){
      const g=bar.start+pos,span=data.spans.findLast(s=>Number(s.offset)<=pos/4);
      const step=this.newStep(g,bar);if(!span)throw new Error('Missing harmony plan');
      const change=Number(span.offset)*4===pos&&span.change!==false;
      if(change)last=g;
      Object.assign(step,{R:R_REST,chord:{root:span.root,q:span.q},change,lastChange:last,onsetBass:span.bassPc??span.root,
        bass:-1,mel:-1,cands:span.candidates||[]});this.steps[g]=step;
    }
  }
}
for(const name of ['newBar','newStep','barComplete','completeBars','barSteps','stepAt','chordSpans','bassPcAt','candidates','settle'])V2Composer.prototype[name]=Composer.prototype[name];
