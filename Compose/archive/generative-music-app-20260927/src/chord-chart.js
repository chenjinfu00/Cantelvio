import {durationBeats} from './duration-policy.js';

/** Lay committed per-bar chord spans into the two-row score viewport. */
export function chartRows({baseBar=0,plans=[],forecast=[],beatsPerBar=4,visibleBars=8}){
 const byBar=new Map();
 for(const plan of [...forecast,...plans])byBar.set(plan.bar,structuredClone(plan));
 return Array.from({length:visibleBars},(_,i)=>byBar.get(baseBar+i)||{bar:baseBar+i,meter:beatsPerBar,segments:[],pending:true});
}

/** Pure queue walk matching Session.boundary's Auto cursor and duration rules. */
export function forecastBars({slots,startUid,elapsedBeats=0,previousMeter=4,advanceAtStart=false,resumeAfterHold=false,startBar,barCount=8,mode='auto',changeMode='free',beatsPerBar=4}){
 if(!slots?.length)return [];
 let index=startUid===undefined?0:slots.findIndex(s=>s.uid===startUid);
 if(index<0)return [];
 let elapsed=elapsedBeats;
 let lastMeter=previousMeter;
 const out=[];
 for(let n=0;n<barCount;n++){
  const bar=startBar+n,meter=typeof beatsPerBar==='function'?beatsPerBar(bar):beatsPerBar;
  const segments=[];let cursor=0;
  if(mode==='hold'){
   segments.push({slot:slots[index],startBeat:0,lengthBeats:meter,continuation:elapsed>0});
   elapsed+=meter;
   lastMeter=meter;
  }else{
   if(changeMode==='bar'){
    const slotIndex=index+n+(advanceAtStart?1:0),current=slots[slotIndex];
    if(!current){out.push({bar,meter,segments,pending:true,forecast:true});break;}
    segments.push({slot:current,startBeat:0,lengthBeats:meter,continuation:false});
    out.push({bar,meter,segments,pending:false,forecast:true});
    continue;
   }
   if(resumeAfterHold&&n===0){index++;elapsed=0;if(!slots[index]){out.push({bar,meter,segments,pending:true,forecast:true});break;}}
   let current=slots[index];
   if(current.durationSpec?.unit==='bars'&&lastMeter!==meter)elapsed=Math.round(elapsed*meter/lastMeter*4)/4;
   const committedDuration=s=>durationBeats(s.durationSpec||{unit:'bars',count:1},changeMode,meter);
   let remaining=Math.max(0,committedDuration(current)-elapsed);
   while(cursor<meter){
    if(remaining<=0){index++;current=slots[index];elapsed=0;if(!current){out.push({bar,meter,segments,pending:true,forecast:true});return out;}remaining=committedDuration(current);if(!(remaining>0)){out.push({bar,meter,segments,pending:true,forecast:true});return out;}}
    const length=Math.min(remaining,meter-cursor);
    segments.push({slot:current,startBeat:cursor,lengthBeats:length,continuation:elapsed>0});
    cursor+=length;elapsed+=length;remaining-=length;
   }
  }
  lastMeter=meter;
  out.push({bar,meter,segments,pending:false,forecast:true});
 }
 return out;
}

export function segmentStyle(segment,meter){
 return `left:${(100*segment.startBeat/meter).toFixed(4)}%;width:${(100*segment.lengthBeats/meter).toFixed(4)}%`;
}
