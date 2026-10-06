import { keyPitches } from './lib/tonality.js';
import { BASE_CHORDS, getChord } from './lib/chord-vocabulary.js';
import { createMelodyDecoder, sampleMelodyLogits, MELODY_DURATIONS, MELODY_METADATA } from './lib/melody-model.js';
export { MELODY_METADATA };
const freeze = entries => Object.freeze(entries.map(e => Object.freeze(e)));
export const SOLO_STYLES = freeze([
    { id: 'pop', name: { en: 'Pop melody', zh: '流行旋律' } }, { id: 'jazz', name: { en: 'Jazz', zh: '爵士' } },
    { id: 'blues', name: { en: 'Blues / Rock', zh: '布鲁斯／摇滚' } }, { id: 'classical', name: { en: 'Classical', zh: '古典' } }, { id: 'ambient', name: { en: 'Ambient', zh: '氛围' } }
]);
export const SOLO_INSTRUMENTS = freeze([
    { id: 'piano', name: { en: 'Piano', zh: '钢琴' }, engine: 'piano' }, { id: 'epiano', name: { en: 'Electric piano', zh: '电钢琴' }, engine: 'epiano' },
    { id: 'electric-guitar', name: { en: 'Electric guitar', zh: '电吉他' }, engine: 'electric-guitar' }, { id: 'synth-lead', name: { en: 'Warm synth lead', zh: '温暖合成主音' }, engine: 'synth-lead' },
    { id: 'reed-lead', name: { en: 'Reed lead', zh: '簧管主音' }, engine: 'reed-lead' }, { id: 'bell', name: { en: 'Bell', zh: '钟琴' }, engine: 'bell' },
    { id: 'harp', name: { en: 'Harp / pluck', zh: '竖琴／拨弦' }, engine: 'pluck' }, { id: 'organ', name: { en: 'Organ', zh: '风琴' }, engine: 'organ' }
]);
export const SOLO_PATTERNS = freeze([
    { id: 'motif', name: { en: 'Short motifs', zh: '短动机' } }, { id: 'arc', name: { en: 'Melodic arcs', zh: '旋律弧线' } },
    { id: 'answer', name: { en: 'Call & response', zh: '问答乐句' } }, { id: 'arpeggio', name: { en: 'Chord lines', zh: '和弦分解' } }
]);
const pc=n=>((n%12)+12)%12;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const rhythmIds=['auto','quarter','eighth','swing','syncopated'];
function seeded(seed){let n=seed|0;return()=>{n=(Math.imul(n,1664525)+1013904223)|0;return(n>>>0)/4294967296;};}
function identifyChord(midis,id){
 if(id&&getChord(id))return getChord(id);
 const pcs=[...new Set(midis.map(pc))];return BASE_CHORDS.find(c=>c.pcs.length===pcs.length&&c.pcs.every(p=>pcs.includes(p)))||BASE_CHORDS[pc(midis[0])];
}
export function createMelodyPerformer({random=Math.random}={}){
 const decoder=createMelodyDecoder();let previousToken=25,previousDuration=3,lastMidi=null,tonalId='',feedback=null,recent=[];
 function reset(){decoder.reset();previousToken=25;previousDuration=3;lastMidi=null;tonalId='';feedback=null;recent=[];}
 function plan(chord,{enabled=false,style='pop',instrument='piano',rhythm='auto',pattern='motif',density=.55,register='middle',feel=.65,bpm=92,beatsPerBar=4,bar=0,key={tonic:0,mode:'major'},nextChord=[],chordId,nextChordId,previousMidi,temperature=.78}={}){
  if(!enabled||!chord.length)return {events:[],lastMidi,feedback:null};
  const styleIndex=Math.max(0,SOLO_STYLES.findIndex(s=>s.id===style)),patternIndex=Math.max(0,SOLO_PATTERNS.findIndex(s=>s.id===pattern));
  const engine=SOLO_INSTRUMENTS.find(s=>s.id===instrument)?.engine||'piano';
  const low=register==='high'?72:60,high=register==='high'?91:83,tonic=pc(key.tonic),tonicOffset=tonic>6?tonic-12:tonic,base=low+tonicOffset;
  const identity=`${tonic}:${key.mode}:${register}`;
  if(identity!==tonalId){const old=lastMidi??previousMidi;reset();tonalId=identity;if(Number.isFinite(old)){lastMidi=clamp(old,low,high);previousToken=clamp(Math.round(lastMidi-base),0,23);}}
  const chordInfo=identifyChord(chord,chordId),tones=[...new Set(chord.map(pc))],scale=keyPitches(key),future=nextChord.length?nextChord:chord;
  const nextMask=Array(12).fill(0);future.forEach(n=>nextMask[pc(n-tonic)]=1);
  const root=pc(chordInfo.root-tonic),quality=chordInfo.qualityIndex,inversion=chordInfo.inversion||0;
  const seconds=60/clamp(bpm,40,200),steps=beatsPerBar*4,duration=beatsPerBar*seconds;
  const resolvedRhythm=rhythm==='auto'?(style==='jazz'?'swing':style==='ambient'?'quarter':style==='classical'?'eighth':'syncopated'):rhythm;
  const timeAt=slot=>{const beat=slot/4,whole=Math.floor(beat),part=beat-whole;return(whole+(resolvedRhythm==='swing'?(part<.5?part*4/3:2/3+(part-.5)*2/3):part))*seconds;};
  const events=[];let slot=0,index=0,latest=null;
  while(slot<steps){
   const feature=[previousToken,previousDuration,root,quality,inversion,key.mode==='minor'?1:0,styleIndex,patternIndex,Math.max(0,rhythmIds.indexOf(rhythm)),slot,bar%8,density<.38?0:density>.72?2:1,beatsPerBar===3?1:0];
   const result=decoder.step(feature,nextMask);latest=result;
   const strong=slot%8===0,remaining=steps-slot;
   const pitches=result.pitchLogits.map((value,token)=>{
    if(token===24){if(!events.length&&remaining<=4)return -Infinity;return value+(.55-density)*1.1;}
    const midi=base+token,distance=lastMidi===null?0:Math.abs(midi-lastMidi);
    if(midi<low||midi>high||distance>7)return -Infinity;
    if(strong&&!tones.includes(pc(midi)))return -Infinity;
    if(pattern==='arpeggio'&&!tones.includes(pc(midi)))return -Infinity;
    const blues=[0,3,5,6,7,10].map(n=>pc(n+tonic));
    const allowed=tones.includes(pc(midi))||scale.includes(pc(midi))||style==='blues'&&blues.includes(pc(midi))||style==='jazz'&&future.some(n=>Math.min(pc(n-midi),pc(midi-n))===1);
    if(!allowed)return -Infinity;
    const repetitions=recent.slice(-3).filter(n=>n===midi).length;
    return value-.025*distance-.12*Math.max(0,distance-4)-(repetitions>=2?(style==='blues'?.35:1.1):0);
   });
   // The network chooses pitches and rests. The mask only enforces playability/harmonic anchors.
   const token=sampleMelodyLogits(pitches,{temperature,random});
   const dLogits=result.durationLogits.map((v,i)=>{
    const d=MELODY_DURATIONS[i];if(d>remaining)return -Infinity;
    if(rhythm==='quarter'&&d<4&&remaining>=4)return -Infinity;
    if((rhythm==='eighth'||rhythm==='swing')&&d%2!==0)return -Infinity;
    return v+(.55-density)*Math.log2(d)*.85;
   });
   const durId=sampleMelodyLogits(dLogits,{temperature:Math.min(.9,temperature),topP:.92,random}),length=MELODY_DURATIONS[durId];
   if(token!==24){
    const midi=base+token,time=Math.max(0,timeAt(slot)+(random()-.5)*.012*feel),end=timeAt(slot+length),gate=style==='ambient'?.98:style==='classical'?.92:style==='jazz'?.82:.88;
    events.push({midi,beat:slot/4,time,duration:Math.max(.035,Math.min((end-time)*gate,duration-time-.012)),velocity:clamp((strong?.64:.51)*(1+(random()-.5)*.14*feel),.15,.8),instrument:engine,role:'solo',barDuration:duration});
    lastMidi=midi;recent.push(midi);if(recent.length>16)recent.shift();
   }
   previousToken=token;previousDuration=durId;slot+=length;index++;
  }
  if(latest){
   const absolute=Array(12).fill(0);latest.affinityLogits.forEach((n,i)=>absolute[pc(i+tonic)]=1/(1+Math.exp(-n)));
   feedback={affinity:absolute,events:decoder.size,strength:.35,source:'melody-transformer'};
  }
  return {events,lastMidi,feedback,model:'melody-transformer',contextEvents:decoder.size};
 }
 return {plan,reset,getFeedback:()=>feedback?{...feedback,affinity:[...feedback.affinity]}:null};
}
/** Stateless helper for previews/tests; live performance uses one persistent causal decoder. */
export function buildMelodyBar(chord,options={}){
 return createMelodyPerformer({random:seeded((options.seed??72941)+Math.imul((options.bar||0)+1,829))}).plan(chord,options);
}
