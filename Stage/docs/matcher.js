// Audio-only reference alignment. No MIDI events, score clock, or transcription.
export const SAMPLE_RATE = 22050;
export const HOP = 2205;
export const FFT_SIZE = 4096;
export const MAX_FRAMES = 27000;
export const FEATURE_VERSION = 1;

export function normalize(values) {
  const norm = Math.hypot(...values);
  return Float32Array.from(values, v => norm > 1e-9 ? v / norm : 0);
}
export function similarity(a,b) {
  let dot = 0; for(let i=0;i<a.length;i++) dot += a[i]*b[i];
  return Math.max(0,Math.min(1,dot));
}

export class Fingerprinter {
  constructor(sampleRate = SAMPLE_RATE) {
    this.sampleRate=sampleRate; this.buffer=[]; this.samples=0;
    this.n=FFT_SIZE; this.window=Float32Array.from({length:this.n},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(this.n-1)));
    this.re=new Float64Array(this.n); this.im=new Float64Array(this.n);
    this.reverse=new Uint16Array(this.n);
    for(let i=0;i<this.n;i++){let x=i,r=0; for(let j=0;j<12;j++){r=(r<<1)|(x&1);x>>=1;} this.reverse[i]=r;}
  }
  feature(samples,time) {
    const n=this.n, re=this.re, im=this.im; let energy=0;
    for(let i=0;i<n;i++){const s=samples[i]||0;energy+=s*s;re[this.reverse[i]]=s*this.window[i];im[this.reverse[i]]=0;}
    for(let size=2;size<=n;size*=2){
      const half=size/2,angle=-2*Math.PI/size,wr=Math.cos(angle),wi=Math.sin(angle);
      for(let start=0;start<n;start+=size){let cr=1,ci=0;for(let k=0;k<half;k++){
        const a=start+k,b=a+half,tr=cr*re[b]-ci*im[b],ti=cr*im[b]+ci*re[b];
        re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;
        const nr=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=nr;
      }}
    }
    const v=new Float32Array(24);let total=0,peak=0,bins=0;
    for(let k=1;k<n/2;k++){
      const freq=k*this.sampleRate/n;if(freq<65||freq>4200) continue;
      const mag=Math.hypot(re[k],im[k]); total+=mag;peak=Math.max(peak,mag);bins++;
      const midi=69+12*Math.log2(freq/440),note=Math.round(midi);
      // Downweight bins between semitones; octave-preserving bass view helps
      // disambiguate chord changes that share upper harmonics.
      const weight=Math.max(0,1-1.7*Math.abs(midi-note));
      const pitch=((note%12)+12)%12;
      v[pitch]+=Math.sqrt(mag)*weight;
      if(freq<525) v[pitch+12]+=Math.sqrt(mag)*weight;
    }
    const db=10*Math.log10(energy/n+1e-12),tonality=peak/(total/Math.max(1,bins)+1e-9);
    return {v:normalize(v),time,db,active:db>-55&&tonality>4};
  }
  push(chunk) {
    for(const value of chunk) this.buffer.push(value);
    const result=[];
    while(this.buffer.length>=this.n){
      result.push(this.feature(this.buffer,(this.samples+this.n/2)/this.sampleRate));
      this.buffer.splice(0,HOP);this.samples+=HOP;
    }
    return result;
  }
}

export function resample(samples,fromRate,toRate=SAMPLE_RATE){
  if(fromRate===toRate)return samples;
  const ratio=fromRate/toRate,n=Math.floor(samples.length/ratio),out=new Float32Array(n);
  for(let i=0;i<n;i++) {const x=i*ratio,j=Math.floor(x),f=x-j;out[i]=(samples[j]||0)*(1-f)+(samples[j+1]||0)*f;}
  return out;
}
export function frameAtTime(frames,time){
  let lo=0,hi=frames.length;
  while(lo<hi){const m=(lo+hi)>>1;if(frames[m].time<time)lo=m+1;else hi=m;}
  return Math.min(lo,Math.max(0,frames.length-1));
}
export function validateReference(ref,pageCount){
  if(!ref||ref.featureVersion!==FEATURE_VERSION||!Array.isArray(ref.frames)||ref.frames.length<20||ref.frames.length>MAX_FRAMES)throw new Error('参考演奏太短或格式不兼容，请至少学习 3 秒有音高的演奏。');
  if(ref.frames.some((f,i)=>!Number.isFinite(f.time)||f.time<0||(i&&f.time<=ref.frames[i-1].time)||!f.v||f.v.length!==24||Array.from(f.v).some(x=>!Number.isFinite(x))))throw new Error('参考声音数据不完整。');
  if(!Array.isArray(ref.anchors)||ref.anchors.length<2)throw new Error('至少需要起始页和一个翻页点。');
  for(let i=0;i<ref.anchors.length;i++){
    const a=ref.anchors[i];if(!Number.isInteger(a.page)||a.page<1||a.page>pageCount||!Number.isFinite(a.time)||a.time<0||a.time>ref.frames.at(-1).time+.5||(i&&a.time<=ref.anchors[i-1].time))throw new Error('翻页点必须在参考演奏中按时间排列。');
  }
  return ref;
}

export class OnlineMatcher {
  constructor(frames,startFrame=0){this.frames=frames;this.reset(startFrame);}
  reset(startFrame=0){
    this.index=Math.max(0,Math.min(this.frames.length-1,startFrame));
    this.cost=new Map([[this.index,0]]);this.good=0;this.activeFrames=0;this.score=0;this.lastIndex=this.index;
  }
  feed(frame){
    if(!frame.active){this.good=0;return {index:this.index,confidence:0,stable:false,active:false};}
    const next=new Map();const lo=Math.max(0,this.index-14),hi=Math.min(this.frames.length-1,this.index+28);
    let best=Infinity,bestIndex=this.index;
    for(let j=lo;j<=hi;j++){
      const previous=Math.min((this.cost.get(j)??Infinity)+.032,this.cost.get(j-1)??Infinity,(this.cost.get(j-2)??Infinity)+.045,(this.cost.get(j-3)??Infinity)+.11);
      if(!Number.isFinite(previous))continue;
      const distance=1-similarity(frame.v,this.frames[j].v);
      const value=previous*.94+distance;
      next.set(j,value);
      if(value<best){best=value;bestIndex=j;}
    }
    if(!Number.isFinite(best)){this.reset(this.index);return {index:this.index,confidence:0,stable:false,active:true};}
    for(const [j,value] of next)next.set(j,value-best);
    this.cost=next;
    this.lastIndex=this.index;this.index=Math.max(this.index,bestIndex);
    // Use observed spectral similarity, not the path score (which is relative).
    const sim=similarity(frame.v,this.frames[bestIndex].v);
    this.score=.65*this.score+.35*sim;this.activeFrames++;
    this.good=sim>=.84&&this.score>=.82?this.good+1:0;
    return {index:this.index,confidence:this.score,stable:this.good>=6,active:true,similarity:sim};
  }
}

export class TurnController {
  constructor(anchors,frames,{lead=.4}={}){this.anchors=anchors;this.frames=frames;this.lead=lead;this.reset(0);}
  reset(anchorIndex=0){this.anchorIndex=anchorIndex;this.confirm=0;this.lastIndex=-1;}
  observe(match){
    if(!match.active||!match.stable){this.confirm=0;return null;}
    const next=this.anchors[this.anchorIndex+1];if(!next)return null;
    const time=this.frames[match.index]?.time??0;
    // Never use elapsed wall-clock time to cross a page boundary. Confirmation
    // needs fresh, progressing matched frames; fixed tones cannot run a timer.
    if(time>=next.time-this.lead&&match.index>this.lastIndex){this.confirm++;}else if(time<next.time-this.lead){this.confirm=0;}
    this.lastIndex=match.index;
    if(this.confirm>=3){this.anchorIndex++;this.confirm=0;return this.anchors[this.anchorIndex];}
    return null;
  }
}
