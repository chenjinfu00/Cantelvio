import test from 'node:test';
import assert from 'node:assert/strict';
import {V2Composer} from '../frontend/src/v2-composer.js';
import {Session} from '../frontend/src/session.js';
import {normalizePerformanceOptions} from '../backend/four-pillar/performance-api.mjs';
const audio={context:{currentTime:0,state:'running'},panic(){},setMix(){},setOrchestra(){},stopGroup(){},setRoleMix(){}};
function fixture(){
  let calls=[];
  const fetcher=async(url,request)=>{
    if(url.endsWith('stop'))return {ok:true,json:async()=>({stopped:true})};
    const o=JSON.parse(request.body);calls.push(o);const fixed=new Map(o.fixed.map(s=>[s.offset,s]));
    const spans=[{offset:0,...(fixed.get(0)||o.chord),change:true,candidates:[{root:5,q:0,p:.7}]}];
    for(const [offset,s] of fixed)if(offset>0)spans.push({...s,change:true});
    const notes=[{pitch:60,onsetQuarter:0,durationQuarter:5,role:0,group:'keys',velocity:.6,ratioText:'none',dynamicText:'p',accent:0,wedge:0,key:`${o.index}:0`},
      {pitch:67,onsetQuarter:2,durationQuarter:1,role:2,group:'woodwinds',velocity:.7,ratioText:'none',dynamicText:'mf',accent:0,wedge:0,key:`${o.index}:1`}];
    return {ok:true,json:async()=>({session:'a'.repeat(8)+'-aaaa-aaaa-aaaa-'+'a'.repeat(12),index:o.index,notes,spans})};
  };
  const session=new Session(audio,{composerClass:V2Composer,composerOptions:{fetcher,random:()=>.5}});
  return {session,calls};
}
test('v2 full console preserves forecast, exact notes, locked bars and edits',async()=>{
  const {session,calls}=fixture();await session.prefetchChart();
  assert.equal(session.composer.completeBars(),8);assert.equal(session.chartView().rows.length,8);
  const before=structuredClone(session.composer.barSteps(0));const plan=session.boundary({bar:0,first:true});
  assert.equal(plan.events[0].midi,60);assert.ok(plan.events[0].duration>plan.duration);
  assert.equal(session.commitEdit('invalid'),false);
  const uid=session.barSpans(2)[0].uid;assert.ok(session.edit(uid));
  const chord=session.editContext(uid).candidates[0].id;assert.ok(session.commitEdit(chord));await session.prefetchChart();
  assert.deepEqual(session.composer.barSteps(0),before);
  assert.equal(session.barSpans(2)[0].chord.root,5);assert.ok(calls.some(c=>c.index===2&&c.fixed.some(s=>s.root===5)));
  session.stop();assert.equal(session.lastHeard.chord.root,0);
});
test('v2 suffix edit keeps preceding exact notes and chord slots',async()=>{
  const {session}=fixture();await session.prefetchChart();const c=session.composer;
  const notes=structuredClone(c.getExactNotes(2));assert.ok(c.edit(c.bars[2].start+8,{root:7,q:0},11));
  assert.deepEqual(c.partial.notes,notes.filter(n=>n.onsetQuarter<2));await c.prefetch(8);
  assert.equal(session.barSpans(2).at(-1).chord.root,7);session.stop();
});
test('performance API rejects unsafe controls, accepts all 40 qualities and meters',()=>{
  const value={index:0,seed:1,chord:{root:0,q:39},key:{tonic:0,mode:'major'},tempo:92,harmonyT:.8,melodyT:.8,density:.5,mode:'hold',changeMode:'bar',beats:4,meter:[4,4],fixed:[],cut:0};
  assert.equal(normalizePerformanceOptions(value).chord.q,39);
  for(const patch of [{index:-1},{seed:-1},{session:'../bad'},{fixed:[{offset:1,root:99,q:0}]},{tempo:NaN},{meter:[5,8]},{cut:5},{harmonyT:10}])assert.throws(()=>normalizePerformanceOptions({...value,...patch}));
});
test('native groups preserve model pitch and identity, without duplicate lanes or octave folding',async()=>{
  const {session}=fixture();await session.prefetchChart();
  session.state.melodyRegister='high';
  const board=session.state.instrumentBoard;
  assert.equal(board.nativeGroups,true);
  assert.equal(board.lanes.harmony.enabled,false);
  for(const lane of Object.values(board.lanes))lane.role='bass';
  const plan=session.boundary({bar:0,first:true});
  assert.deepEqual(plan.events.map(e=>[e.role,e.midi,e.modelPitch]),[['keys',60,60],['woodwinds',67,67]]);
  assert.ok(plan.events.every(e=>e.exactPitch&&!e.drum));
  session.setInstrumentEnabled('woodwinds',false);
  const next=session.boundary({bar:1,first:false});
  assert.ok(next.events.every(e=>e.role==='keys'));
  session.stop();
});
test('native board migration retains all-off choices and all six groups keep extreme pitches',async()=>{
  const {nativeInstrumentBoard,routeInstrumentBar}=await import('../frontend/src/instrument-board.js');
  const {ORCHESTRA_GROUP_IDS}=await import('../frontend/src/orchestration.js');
  const board=nativeInstrumentBoard();
  for(const id of ORCHESTRA_GROUP_IDS)board.lanes[id].enabled=false;
  assert.ok(ORCHESTRA_GROUP_IDS.every(id=>!nativeInstrumentBoard(board).lanes[id].enabled));
  for(const id of ORCHESTRA_GROUP_IDS)board.lanes[id].enabled=true;
  const events=ORCHESTRA_GROUP_IDS.map((id,i)=>({role:'melody',nativeGroup:id,midi:i%2?28:100,time:0,modelPitch:i%2?28:100,exactPitch:true}));
  const played=routeInstrumentBar({events},board,{},0);
  assert.equal(played.length,6);
  for(const event of played){assert.equal(event.midi,event.modelPitch);assert.equal(event.role,event.nativeGroup);assert.equal(event.drum,false);}
});
