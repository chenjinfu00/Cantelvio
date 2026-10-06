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
 const decoder=createMelodyDecoder();let previousToken=25,previousDuration=3,lastMidi=null,tonalId='',feedback=null,recent=[],theme=[[],[]],lastBar=null,pendingTension=null,phraseStartBar=null;
 function reset(){decoder.reset();previousToken=25;previousDuration=3;lastMidi=null;tonalId='';feedback=null;recent=[];theme=[[],[]];lastBar=null;pendingTension=null;phraseStartBar=null;}
 function plan(chord,{enabled=false,style='pop',instrument='piano',rhythm='auto',pattern='motif',density=.55,register='middle',feel=.65,bpm=92,beatsPerBar=4,bar=0,key={tonic:0,mode:'major'},nextChord=[],chordId,nextChordId,previousMidi,temperature=.78}={}){
  if(!enabled||!chord.length){reset();return {events:[],lastMidi,feedback:null};}
  const styleIndex=Math.max(0,SOLO_STYLES.findIndex(s=>s.id===style)),patternIndex=Math.max(0,SOLO_PATTERNS.findIndex(s=>s.id===pattern));
  const engine=SOLO_INSTRUMENTS.find(s=>s.id===instrument)?.engine||'piano';
  const low=register==='high'?72:60,high=register==='high'?91:83,tonic=pc(key.tonic),tonicOffset=tonic>6?tonic-12:tonic,base=low+tonicOffset;
  const identity=`${tonic}:${key.mode}:${register}:${style}:${pattern}:${rhythm}:${beatsPerBar}`;
  if(identity!==tonalId||lastBar!==null&&bar!==lastBar+1){const old=lastMidi??previousMidi;reset();tonalId=identity;if(Number.isFinite(old)){lastMidi=clamp(old,Math.max(low,base),Math.min(high,base+23));previousToken=clamp(Math.round(lastMidi-base),0,23);}}
  const chordInfo=identifyChord(chord,chordId),tones=[...new Set(chord.map(pc))],scale=keyPitches(key),future=nextChord.length?nextChord:chord;
  const nextMask=Array(12).fill(0);future.forEach(n=>nextMask[pc(n-tonic)]=1);
  const root=pc(chordInfo.root-tonic),quality=chordInfo.qualityIndex,inversion=chordInfo.inversion||0;
  const seconds=60/clamp(bpm,40,200),steps=beatsPerBar*4,duration=beatsPerBar*seconds;
  const resolvedRhythm=rhythm==='auto'?(style==='jazz'?'swing':style==='ambient'?'quarter':style==='classical'?'eighth':'syncopated'):rhythm;
  const timeAt=slot=>{const beat=slot/4,whole=Math.floor(beat),part=beat-whole;return(whole+(resolvedRhythm==='swing'?(part<.5?part*4/3:2/3+(part-.5)*2/3):part))*seconds;};
  if(phraseStartBar===null)phraseStartBar=bar;
  const phraseBar=(((bar-phraseStartBar)%8)+8)%8;if(phraseBar===0)theme=[[],[]];lastBar=bar;
  const relativeScale=scale.map(n=>pc(n-tonic)),nearest=(values,target)=>values.reduce((a,b)=>Math.abs(b-target)<Math.abs(a-target)?b:a);
  const references=theme[phraseBar%2];
  const events=[];let slot=0,index=0,latest=null;
  while(slot<steps){
   let motifPitch=25,motifDuration=8;
   if(phraseBar>=2&&references.length){
    const reference=references.reduce((a,b)=>Math.abs(b.slot-slot)<Math.abs(a.slot-slot)?b:a);
    motifDuration=reference.duration;
    if(reference.token===24)motifPitch=24;
    else {const shift=pc(root-reference.root+6)-6,target=clamp(reference.token+shift,0,23);motifPitch=nearest(Array.from({length:24},(_,i)=>i).filter(n=>relativeScale.includes(pc(n))),target);}
   }
   const feature=[previousToken,previousDuration,root,quality,inversion,key.mode==='minor'?1:0,styleIndex,patternIndex,Math.max(0,rhythmIds.indexOf(rhythm)),slot,phraseBar,density<.38?0:density>.72?2:1,beatsPerBar===3?1:0,motifPitch,motifDuration];
   const result=decoder.step(feature,nextMask);latest=result;
   const strong=slot%8===0,remaining=steps-slot;
   const availableTones=Array.from({length:high-low+1},(_,i)=>low+i).filter(midi=>midi>=base&&midi<=base+23&&tones.includes(pc(midi))&& (lastMidi===null||Math.abs(midi-lastMidi)<=12));
   const closeResolutions=pendingTension===null?[]:availableTones.filter(midi=>Math.abs(midi-pendingTension)<=2);
   const resolutionTargets=pendingTension===null?[]:closeResolutions.length?closeResolutions:availableTones.filter(midi=>Math.abs(midi-pendingTension)===Math.min(...availableTones.map(n=>Math.abs(n-pendingTension))));
   let sameRun=0;for(let i=recent.length-1;i>=0&&recent[i]===lastMidi;i--)sameRun++;
   const pitches=result.pitchLogits.map((value,token)=>{
    if(token===24){if(!events.length&&remaining<=4)return -Infinity;return value+(.55-density)*1.1+([3,7].includes(phraseBar)&&remaining<=4?2.4:0);}
    const midi=base+token,distance=lastMidi===null?0:Math.abs(midi-lastMidi);
    if(midi<low||midi>high||distance>12)return -Infinity;
    const chordTone=tones.includes(pc(midi));
    const resolution=pendingTension!==null&&chordTone&&Math.abs(midi-pendingTension)<=2;
    // Tensions are brief, approached by step or prepared by a repeated pitch.
    if(!chordTone&&strong&&(lastMidi===null||distance>2))return -Infinity;
    if(pendingTension!==null&&!resolutionTargets.includes(midi))return -Infinity;
    if(pattern==='arpeggio'&&!tones.includes(pc(midi)))return -Infinity;
    const blues=[0,3,5,6,7,10].map(n=>pc(n+tonic));
    const allowed=tones.includes(pc(midi))||scale.includes(pc(midi))||style==='blues'&&blues.includes(pc(midi))||style==='jazz'&&future.some(n=>Math.min(pc(n-midi),pc(midi-n))===1);
    if(!allowed)return -Infinity;
        const cadence=[3,7].includes(phraseBar)&&remaining<=8;
    return value-.035*distance-.16*Math.max(0,distance-5)+(resolution?1.2:0)+(cadence&&chordTone?.5:0)-(midi===lastMidi?Math.max(0,sameRun-1)*(style==='blues'?.95:1.5):0)+(motifPitch<24&&phraseBar>=6?Math.max(0,.55-.18*Math.abs(token-motifPitch)):0);
   });
   // The trained network chooses every pitch/rest; phrase memory and tension resolution
   // supply bounded musical priors rather than a fixed note sequence.
   // A short repeated-note motif remains valid; four identical attacks in a
   // row may continue only when no alternative playable pitch exists.
   if(sameRun>=4&&lastMidi!==null&&pitches.some((v,t)=>t<24&&base+t!==lastMidi&&Number.isFinite(v)))pitches[lastMidi-base]=-Infinity;
   const token=sampleMelodyLogits(pitches,{temperature,topP:.94,topK:9,random});
   const dLogits=result.durationLogits.map((v,i)=>{
    const d=MELODY_DURATIONS[i];if(d>remaining||token===24&&!events.length&&d>remaining-2)return -Infinity;
    if(rhythm==='quarter'&&d<4&&remaining>=4)return -Infinity;
    if((rhythm==='eighth'||rhythm==='swing')&&d%2!==0)return -Infinity;
    const tension=token!==24&&!tones.includes(pc(base+token));
    return v+(.55-density)*Math.log2(d)*.85-(tension?Math.max(0,d-2)*.45:0)+(i===motifDuration&&phraseBar>=2?.25:0);
   });
   // Reserve the cadence breath only when a legal duration can reach it;
   // quarter-note overrides in a short/odd remainder must never empty the mask.
   if([3,7].includes(phraseBar)&&remaining>4&&dLogits.some((v,i)=>Number.isFinite(v)&&MELODY_DURATIONS[i]<=remaining-4))
    dLogits.forEach((_,i)=>{if(MELODY_DURATIONS[i]>remaining-4)dLogits[i]=-Infinity;});
   const durId=sampleMelodyLogits(dLogits,{temperature:Math.min(.9,temperature),topP:.92,random}),length=MELODY_DURATIONS[durId];
   if(token!==24){
    const midi=base+token,time=Math.max(0,timeAt(slot)+(random()-.5)*.012*feel),end=timeAt(slot+length),gate=style==='ambient'?.98:style==='classical'?.92:style==='jazz'?.82:.88;
    const phraseShape=.9+.12*Math.sin(Math.PI*(phraseBar%4+slot/steps)/4),ending=[3,7].includes(phraseBar)&&slot>=steps-8;
    events.push({midi,beat:slot/4,time,duration:Math.max(.035,Math.min((end-time)*gate*(ending?.78:1),duration-time-.012)),velocity:clamp((strong?.63:.53)*phraseShape*(ending?.9:1)*(1+(random()-.5)*.14*feel),.15,.8),instrument:engine,role:'solo',barDuration:duration});
    pendingTension=tones.includes(pc(midi))?null:midi;
    lastMidi=midi;recent.push(midi);if(recent.length>16)recent.shift();
   }
   if(phraseBar<2)theme[phraseBar].push({slot,token,duration:durId,root});
   previousToken=token;previousDuration=durId;slot+=length;index++;
  }
  if(latest){
   const absolute=Array(12).fill(0);latest.affinityLogits.forEach((n,i)=>absolute[pc(i+tonic)]=1/(1+Math.exp(-n)));
   feedback={affinity:absolute,events:decoder.size,strength:.35,source:'melody-transformer'};
  }
  return {events,lastMidi,feedback,model:'melody-transformer',contextEvents:decoder.size,phrase:{bar:phraseBar,role:['statement','statement','answer','cadence','development','development','return','cadence'][phraseBar],motifEvents:theme.flat().length}};
 }
 return {plan,reset,getFeedback:()=>feedback?{...feedback,affinity:[...feedback.affinity]}:null};
}
/** Stateless helper for previews/tests; live performance uses one persistent causal decoder. */
export function buildMelodyBar(chord,options={}){
 return createMelodyPerformer({random:seeded((options.seed??72941)+Math.imul((options.bar||0)+1,829))}).plan(chord,options);
}
