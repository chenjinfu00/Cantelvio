// Conservative browser experiment, separate from the Python multi-evidence engine.
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const norm=v=>{const n=Math.hypot(...v);return v.map(x=>n?x/n:0);};
const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);
export function pitchVector(notes) {
  const v=Array(12).fill(0);
  for(const n of notes) {
    // Include the strongest pitched harmonics captured by the live FFT.
    for(const [offset,weight] of [[0,1],[12,.45],[19,.2],[24,.1]])v[(n.note+offset)%12]+=Math.sqrt(n.velocity/127)*weight;
  }
  return norm(v);
}
export function referenceFrames(notes) {
  if(!notes.length)return [];
  const frames=[],end=notes.reduce((end,n)=>Math.max(end,n.end),0);let index=0,active=[];
  if(end>30000)throw Error('跟随参考过长，请按乐章载入 / Solo reference is too long; load one movement');
  for(let beat=Math.floor(notes[0].beat*8)/8;beat<=end;beat+=.125) {
    active=active.filter(n=>n.end>beat);
    while(index<notes.length && notes[index].beat<=beat+.0625)active.push(notes[index++]);
    frames.push({beat,v:pitchVector(active),active:active.length>0});
  }
  return frames;
}
export class BrowserFollower {
  constructor({solo,phrases,orchestra,clock,speaker=true}) {
    Object.assign(this,{phrases,clock,speaker});this.frames=referenceFrames(solo);this.orchestra=referenceFrames(orchestra);this.reset(0);
  }
  reset(beat) {this.humanBeat=beat;this.locked=false;this.good=0;this.lastGood=-Infinity;this.confidence=0;this.phrase=-1;this.override=false;this.scale=1;this.previous=null;}
  bounds(beat) {return this.phrases.findIndex(p=>beat>=p.beat-.08 && beat<p.end);}
  control(beat,now) {
    const i=this.bounds(beat),phrase=this.phrases[i];
    if(i<0){this.phrase=-1;this.locked=false;this.override=false;return {gate:this.phrases.find(p=>p.beat>beat)?.beat ?? Infinity,scale:1,label:'rest'};}
    if(i!==this.phrase){this.phrase=i;this.locked=false;this.override=false;this.good=0;this.previous=null;this.humanBeat=phrase.beat;}
    if(this.override)return {gate:Infinity,scale:1,label:'manual'};
    if(!this.locked || now-this.lastGood>1.6)return {gate:beat,scale:0,label:this.locked?'lost':'waiting'};
    const correction=clamp((this.humanBeat-beat)*.12,-.2,.2);
    return {gate:Infinity,scale:clamp(this.scale+correction,.6,1.4),label:'following'};
  }
  release() {this.override=true;}
  observe(frame,beat,now) {
    this.db=frame.db;
    if(!frame.active || this.bounds(beat)<0){this.good=0;this.confidence=0;return false;}
    const live=norm(Array.from(frame.v).slice(0,12));
    const center=this.locked?Math.max(beat-1,this.humanBeat):beat;
    const base=Math.max(0,Math.floor((center-this.frames[0].beat)*8));
    let best=null;
    for(let j=Math.max(0,base-16);j<Math.min(this.frames.length,base+33);j++) {
      const f=this.frames[j];if(!f.active)continue;
      const similarity=dot(live,f.v),score=similarity-.025*Math.abs(f.beat-center);
      if(!best || score>best.score)best={...f,similarity,score};
    }
    const orchestraIndex=this.orchestra.length?Math.round((beat-this.orchestra[0].beat)*8):-1;
    const bleed=this.orchestra[orchestraIndex];
    this.confidence=best?.similarity || 0;
    if(!best || best.similarity<.66 || this.speaker && bleed?.active && dot(live,bleed.v)>best.similarity-.035) {this.good=0;return false;}
    if(this.previous && Math.abs(best.beat-this.previous.beat)>1.5){this.good=0;this.previous={beat:best.beat,now};return false;}
    this.good++;
    if(this.good>=4) {
      if(this.previous && best.beat>this.previous.beat+.04 && now>this.previous.now+.05) {
        const nominal=this.clock.seconds(best.beat)-this.clock.seconds(this.previous.beat);
        this.scale=.85*this.scale+.15*clamp(nominal/(now-this.previous.now),.6,1.4);
      }
      this.humanBeat=best.beat;this.lastGood=now;this.locked=true;
    }
    this.previous={beat:best.beat,now};return this.locked;
  }
}
