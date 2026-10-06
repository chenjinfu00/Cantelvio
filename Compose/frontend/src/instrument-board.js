/** Live assignment for already-written notes. The learned six-group classifier
 * supplies note scores ahead of scheduling; user roles and Fixed/Walk constrain
 * which enabled lane may play. Legacy coarse routing remains for older tests. */
import {ORCHESTRA_GROUPS, ORCHESTRA_GROUP_IDS} from './orchestration.js';
import {INSTRUMENTS, BASS_INSTRUMENTS, MELODY_INSTRUMENTS, engineOf} from './instruments.js';

export const INSTRUMENT_LANES = Object.freeze([
  {id:'harmony',en:'Chords',zh:'和弦乐器',defaultRole:'harmony',range:[48,84]},
  {id:'bass',en:'Bass',zh:'贝斯',defaultRole:'bass',range:[28,64]},
  {id:'melody',en:'Melody',zh:'旋律乐器',defaultRole:'melody',range:[57,88]},
  ...ORCHESTRA_GROUPS.map(group=>({
    ...group,defaultRole:({woodwinds:'melody',brass:'harmony',percussion:'rhythm',keys:'harmony',high_strings:'melody',low_strings:'bass'})[group.id],
    range:({woodwinds:[55,88],brass:[43,79],percussion:[35,81],keys:[48,88],high_strings:[57,88],low_strings:[36,72]})[group.id]
  }))
]);
export const INSTRUMENT_ROLES = Object.freeze([
  {id:'harmony',en:'Harmony',zh:'和声'}, {id:'bass',en:'Bass',zh:'低音'},
  {id:'melody',en:'Melody',zh:'旋律'}, {id:'rhythm',en:'Rhythm',zh:'节奏'}
]);
export const INSTRUMENT_IDS = Object.freeze(INSTRUMENT_LANES.map(lane=>lane.id));
export function defaultInstrumentBoard(){
  return {walk:false,every:4,learnedArrangement:true,orchestraMix:.55,lanes:Object.fromEntries(INSTRUMENT_LANES.map(lane=>[lane.id,{
    enabled:lane.id!=='melody'&&!ORCHESTRA_GROUP_IDS.includes(lane.id),
    walk:ORCHESTRA_GROUP_IDS.includes(lane.id),role:lane.defaultRole,
    level:ORCHESTRA_GROUP_IDS.includes(lane.id)?1:null
  }]))};
}
export function normalizeInstrumentBoard(raw){
  const board=defaultInstrumentBoard();
  if(!raw||typeof raw!=='object')return board;
  board.nativeGroups=raw.nativeGroups===true;
  board.walk=raw.walk===true;
  if(typeof raw.learnedArrangement==='boolean')board.learnedArrangement=raw.learnedArrangement;
  board.every=[1,2,4,8,16,32].includes(Number(raw.every))?Number(raw.every):4;
  if(Number.isFinite(Number(raw.orchestraMix)))board.orchestraMix=Math.max(0,Math.min(1,Number(raw.orchestraMix)));
  for(const lane of INSTRUMENT_LANES){
    const saved=raw.lanes?.[lane.id];if(!saved||typeof saved!=='object')continue;
    if(typeof saved.enabled==='boolean')board.lanes[lane.id].enabled=saved.enabled;
    else if(['on','auto','off'].includes(saved.mode))board.lanes[lane.id].enabled=saved.mode!=='off';
    if(typeof saved.walk==='boolean')board.lanes[lane.id].walk=saved.walk;
    else if(saved.mode==='auto')board.lanes[lane.id].walk=true;
    else if(saved.mode==='on')board.lanes[lane.id].walk=false;
    if(INSTRUMENT_ROLES.some(role=>role.id===saved.role))board.lanes[lane.id].role=saved.role;
    if(ORCHESTRA_GROUP_IDS.includes(lane.id)&&Number.isFinite(Number(saved.level)))
      board.lanes[lane.id].level=Math.max(0,Math.min(1,Number(saved.level)));
  }
  return board;
}

/** Migrate old scenes without removing their stored lane metadata. */
export function nativeInstrumentBoard(raw){
  const board=normalizeInstrumentBoard(raw);
  if(!raw?.nativeGroups&&!ORCHESTRA_GROUP_IDS.some(id=>board.lanes[id].enabled)){
    for(const id of ['keys','low_strings','woodwinds'])board.lanes[id].enabled=true;
  }
  board.nativeGroups=true;board.learnedArrangement=true;
  for(const id of ['harmony','bass','melody'])board.lanes[id].enabled=false;
  for(const lane of INSTRUMENT_LANES)if(ORCHESTRA_GROUP_IDS.includes(lane.id))board.lanes[lane.id].role=lane.defaultRole;
  return board;
}

/** Fixed plays all enabled lanes. Walk rotates enabled, participating lanes
 * by their selected role, one per role and phrase; nonparticipants stay on. */
export function activeInstrumentIds(board,bar){
  const active=new Set(),phrase=Math.floor(Math.max(0,bar)/board.every);
  for(const lane of INSTRUMENT_LANES)if((!board.nativeGroups||ORCHESTRA_GROUP_IDS.includes(lane.id))&&board.lanes[lane.id]?.enabled&&(!board.walk||!board.lanes[lane.id].walk))active.add(lane.id);
  if(!board.walk)return active;
  for(const role of INSTRUMENT_ROLES){
    const walkers=INSTRUMENT_LANES.filter(lane=>(!board.nativeGroups||ORCHESTRA_GROUP_IDS.includes(lane.id))&&board.lanes[lane.id]?.enabled&&board.lanes[lane.id]?.walk&&board.lanes[lane.id]?.role===role.id);
    if(walkers.length)active.add(walkers[phrase%walkers.length].id);
  }
  return active;
}

function fitPitch(pitch,[low,high]){
  let n=Math.round(pitch);
  while(n<low)n+=12;
  while(n>high)n-=12;
  return Math.max(low,Math.min(high,n));
}
function engine(lane,state){
  if(lane.id==='harmony')return engineOf(INSTRUMENTS,state.chordInstrument);
  if(lane.id==='bass')return engineOf(BASS_INSTRUMENTS,state.bassInstrument);
  if(lane.id==='melody')return engineOf(MELODY_INSTRUMENTS,state.melodyInstrument);
  return lane.instrument;
}
function thinChord(events,role){
  if(role==='harmony')return events;
  const byOnset=new Map();
  for(const event of events){const key=Math.round(event.time*1000);const old=byOnset.get(key);
    if(!old||(role==='bass'?event.midi<old.midi:event.midi>old.midi))byOnset.set(key,event);}
  return [...byOnset.values()];
}
export function routeInstrumentBar(score,board,state,bar){
  const active=activeInstrumentIds(board,bar);
  if(board.nativeGroups){
    return score.events.flatMap(event=>{
      const group=ORCHESTRA_GROUPS.find(g=>g.id===event.nativeGroup);
      if(!group||!active.has(group.id))return [];
      return [{...event,role:group.id,instrument:group.instrument,drum:false}];
    }).sort((a,b)=>a.time-b.time||a.midi-b.midi);
  }
  const sources={
    harmony:score.events.filter(event=>event.role==='harmony'),
    bass:score.events.filter(event=>event.role==='bass'),
    melody:score.events.filter(event=>event.role==='melody')
  };
  const learned=new Map();
  if(score.learnedArrangement)for(const event of score.events){
    if(!event.groupLogits)continue;
    let best=null,value=-Infinity;
    for(let i=0;i<ORCHESTRA_GROUP_IDS.length;i++){
      const id=ORCHESTRA_GROUP_IDS[i],role=board.lanes[id].role;
      if(!active.has(id)||!(role===event.role||(role==='rhythm'&&event.role==='harmony')))continue;
      if(event.groupLogits[i]>value){value=event.groupLogits[i];best=id;}
    }
    if(best)learned.set(event.sourceKey,best);
  }
  const result=[];
  for(const lane of INSTRUMENT_LANES){
    if(!active.has(lane.id))continue;
    const role=board.lanes[lane.id].role,instrument=engine(lane,state);
    if(score.learnedArrangement&&ORCHESTRA_GROUP_IDS.includes(lane.id)){
      for(const event of score.events){
        if(learned.get(event.sourceKey)!==lane.id)continue;
        if(lane.id==='percussion'){
          result.push({...event,role:lane.id,instrument,drum:true,
            midi:event.role==='bass'?36:event.role==='harmony'?38:42,
            duration:Math.min(.18,event.duration),velocity:event.velocity*.52});
        }else result.push({...event,role:lane.id,instrument,
          midi:fitPitch(event.midi,lane.range),velocity:event.velocity*.7});
      }
      continue;
    }
    if(lane.id==='percussion'){
      const onsets=role==='rhythm'?Array.from({length:score.beats},(_,beat)=>({time:score.stepTime(beat*4),beat})):
        [...new Map((sources[role]||[]).map(event=>[Math.round(event.time*1000),event])).values()];
      for(const event of onsets)result.push({role:lane.id,instrument,drum:true,
        midi:role==='rhythm'?(Math.round(event.beat)%2===0?36:38):role==='bass'?36:role==='harmony'?38:42,
        time:event.time,duration:.13,velocity:role==='rhythm'?.36:.25});
      continue;
    }
    const source=role==='rhythm'?thinChord(sources.harmony,lane.id==='bass'||lane.id==='low_strings'?'bass':'melody'):
      role==='harmony'?thinChord(sources.harmony,lane.id==='bass'||lane.id==='low_strings'?'bass':lane.id==='harmony'||lane.id==='keys'?'harmony':'melody'):
      sources[role]||[];
    for(const event of source){
      if(!(event.time>=0&&event.time<score.duration))continue;
      const original=lane.id===role&&role!=='rhythm';
      result.push({...event,role:lane.id,instrument,
        midi:original?event.midi:fitPitch(event.midi,lane.range),
        duration:role==='rhythm'?Math.min(.22,event.duration):event.duration,
        velocity:original?event.velocity:event.velocity*(lane.id==='harmony'||lane.id==='bass'||lane.id==='melody'?.9:.66)});
    }
  }
  result.sort((a,b)=>a.time-b.time||a.midi-b.midi);
  return result;
}
