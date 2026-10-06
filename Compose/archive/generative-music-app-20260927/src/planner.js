import {voiceChord,getChord} from '../vendor/lib/harmony-models.js';
import {buildBarEvents} from '../vendor/accompaniment.js';
export const beatsFor=state=>state.rhythm==='waltz'?3:4;
/** Frozen v91 expressive planner, mapped into three independent audio buses. */
export function planAccompaniment(current,next,state,bar=0,previous=[]){
 const chord=voiceChord(current.id,previous),future=voiceChord(next.id,chord),beats=beatsFor(state);
 const events=buildBarEvents(chord,{nextChord:future,root:getChord(current.id).root,key:current.key,bpm:state.bpm,bar,style:state.accompanimentStyle,rhythm:state.rhythm,pattern:state.texture,instrument:state.chordInstrument,bassInstrument:state.bassOn?state.bassInstrument:'off',bassLine:state.bassPattern,volume:1,bassVolume:1,feel:state.feel,variation:.65}).map(e=>({...e,role:e.role==='bass'?'bass':'harmony'}));
 return {events,chord,future,beats,duration:beats*60/state.bpm};
}

/** Reuse the actual bar's groove for each harmony segment: its bar/beat phase
 * never restarts. Crop old pitches at changes, and articulate a new harmony at
 * an internal onset even when the original comping/pedal pattern has a gap. */
export function planHarmonyTimeline(segments,state,bar,previous=[]){
 const beats=beatsFor(state),seconds=60/state.bpm,events=[],conditioned=[];let voicing=previous;
 for(const segment of segments){
  const base=planAccompaniment(segment.slot,segment.nextSlot,state,bar,voicing),begin=segment.startBeat*seconds,end=(segment.startBeat+segment.lengthBeats)*seconds;
  voicing=base.chord;
  let selected=base.events.filter(e=>e.beat>=segment.startBeat&&e.beat<segment.startBeat+segment.lengthBeats).map(e=>({...e,time:Math.max(begin,e.time)}));
  if(segment.startBeat>0){
   const harmony=base.events.filter(e=>e.role==='harmony'),firstBeat=harmony[0]?.beat;
   if(!selected.some(e=>e.role==='harmony'&&e.time<begin+seconds*.125)){
    const attack=harmony.filter(e=>e.beat===firstBeat),origin=Math.min(...attack.map(e=>e.time));
    selected.push(...attack.map(e=>({...e,beat:segment.startBeat,time:begin+Math.min(.03,e.time-origin),duration:Math.min(e.duration,seconds*.5),velocity:e.velocity*.9})));
   }
   const bass=base.events.find(e=>e.role==='bass');
   if(bass){selected=selected.filter(e=>!(e.role==='bass'&&e.beat===segment.startBeat));const nextBass=selected.filter(e=>e.role==='bass'&&e.time>begin).reduce((n,e)=>Math.min(n,e.time),end);const gate=state.bassPattern==='pedal'?(segment.lengthBeats-.08)*seconds:Math.min(bass.duration,seconds*.85);selected.push({...bass,beat:segment.startBeat,time:begin,duration:Math.min(gate,nextBass-begin-.008)});}
  }
  selected=selected.map(e=>({...e,duration:Math.min(e.duration,end-e.time-.008)})).filter(e=>e.duration>0);
  events.push(...selected);
  conditioned.push({id:segment.slot.id,uid:segment.slot.uid,key:segment.slot.key,chord:base.chord,nextChord:base.future,startBeat:segment.startBeat,lengthBeats:segment.lengthBeats});
 }
 return {events:events.sort((a,b)=>a.time-b.time||a.midi-b.midi),chord:voicing,conditioned,beats,duration:beats*seconds};
}
