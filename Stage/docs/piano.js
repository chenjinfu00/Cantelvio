// A sampled piano: thirty Salamander samples, every note between them pitched from the nearest one.
export const SAMPLES=['A0','C1','Ds1','Fs1','A1','C2','Ds2','Fs2','A2','C3','Ds3','Fs3','A3','C4','Ds4','Fs4','A4','C5','Ds5','Fs5','A5','C6','Ds6','Fs6','A6','C7','Ds7','Fs7','A7','C8'];
const STEPS={C:0,D:2,E:4,F:5,G:7,A:9,B:11};

export function noteNumber(name){
  const match=/^([A-G])(s|#)?(-?\d)$/.exec(String(name).trim());
  if(!match)return null;
  return STEPS[match[1]]+(match[2]?1:0)+(Number(match[3])+1)*12;
}
export const noteName=number=>['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][number%12]+(Math.floor(number/12)-1);
// The nearest sample, and how far the note has to be pitched to get there.
export function nearestSample(note,samples=SAMPLES){
  let best=null;
  for(const name of samples){
    const number=noteNumber(name);
    if(number===null)continue;
    const distance=Math.abs(number-note);
    if(!best||distance<best.distance)best={name,number,distance};
  }
  return best&&{...best,rate:2**((note-best.number)/12)};
}

export class Piano {
  constructor({context,base=new URL('./vendor/piano/',import.meta.url),gain=.8}={}){
    this.context=context;this.base=base;this.buffers=new Map();this.voices=new Set();this.loading=null;
    this.output=context.createGain();this.output.gain.value=gain;this.output.connect(context.destination);
  }
  load(onProgress=()=>{}){
    if(this.loading)return this.loading;
    let done=0;
    this.loading=Promise.all(SAMPLES.map(async name=>{
      const response=await fetch(new URL(name+'.mp3',this.base));
      if(!response.ok)throw new Error('钢琴音色未能载入');
      this.buffers.set(name,await this.context.decodeAudioData(await response.arrayBuffer()));
      onProgress(++done,SAMPLES.length);
    })).then(()=>this);
    return this.loading;
  }
  get ready(){return this.buffers.size===SAMPLES.length;}
  // A note is one sample, pitched, with a short fade in and a release that leaves no click.
  play(note,{at=this.context.currentTime,duration=.5,velocity=.7,release=.35}={}){
    const sample=nearestSample(note),buffer=sample&&this.buffers.get(sample.name);
    if(!buffer)return null;
    const source=this.context.createBufferSource(),gain=this.context.createGain();
    source.buffer=buffer;source.playbackRate.value=sample.rate;
    const peak=Math.max(.02,Math.min(1,velocity))**1.4;
    gain.gain.setValueAtTime(0,at);
    gain.gain.linearRampToValueAtTime(peak,at+.006);
    const end=at+Math.max(.05,duration);
    gain.gain.setValueAtTime(peak,Math.max(at+.007,end-.01));
    gain.gain.exponentialRampToValueAtTime(.0001,end+release);
    source.connect(gain).connect(this.output);
    source.start(at);source.stop(end+release+.05);
    this.voices.add(source);source.onended=()=>{this.voices.delete(source);gain.disconnect();};
    return source;
  }
  silence(){for(const source of this.voices){try{source.stop();}catch{}}this.voices.clear();}
}
