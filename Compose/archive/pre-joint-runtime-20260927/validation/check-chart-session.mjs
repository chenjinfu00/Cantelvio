import assert from 'node:assert/strict';
import {Session} from '../src/session.js';
import {beatsFor} from '../src/planner.js';
const seeded=seed=>()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296;};
const make=()=>new Session({context:{state:'running',currentTime:0},panic(){},setMix(){},setRoleMix(){},stopGroup(){}},{random:seeded(998)});
const compact=b=>b.segments.map(s=>[s.slot.uid,s.slot.id,s.startBeat,s.lengthBeats]);
const trace=[];
for(const changeMode of ['bar','free'])for(const meter of [3,4]){
 const s=make();s.setParam('mode','auto');s.setParam('changeMode',changeMode);s.setParam('rhythm',meter===3?'waltz':'quarter');s.transport.running=true;
 let clock=0;
 for(let bar=0;bar<24;bar++){
  s.queue.fill(48);
  const before=s.chartView(),forecast=before.rows.find(b=>b.bar===bar);
  assert.ok(forecast,`${changeMode}/${meter} has forecast bar ${bar}`);
  const advertised=compact(forecast),plan=s.boundary({bar,first:bar===0,start:clock});
  assert.deepEqual(plan.timeline.map(t=>[t.uid,t.id,t.startBeat,t.lengthBeats]),advertised,`${changeMode}/${meter} bar ${bar} advertised matches played`);
  s.transport.frame={bar,start:clock,duration:plan.duration,beats:plan.beats};plan.onStart();for(const transition of plan.transitions)transition.onStart();
  const after=s.chartView();assert.equal(after.baseBar,Math.floor(bar/4)*4);assert.equal(after.rows.length,8);assert.deepEqual(compact(after.rows.find(b=>b.bar===bar)),advertised);
  trace.push({changeMode,meter,bar,baseBar:after.baseBar,segments:advertised});clock+=plan.duration;
 }
 s.stop();assert.equal(s.chartView().baseBar,0);assert.equal(s.chartArchive.size,0);assert.equal(s.chartScheduled.size,0);
}
for(const change of ['hold-to-auto','free-to-bar','bar-to-free','meter']){
 const s=make();s.setParam('mode',change==='hold-to-auto'?'hold':'auto');s.setParam('changeMode',change==='bar-to-free'?'bar':'free');s.transport.running=true;s.queue.fill(48);
 let p=s.boundary({bar:0,first:true,start:0});s.transport.frame={bar:0,start:0,duration:p.duration,beats:p.beats};p.onStart();for(const t of p.transitions)t.onStart();
 if(change==='hold-to-auto')s.setParam('mode','auto');if(change==='free-to-bar')s.setParam('changeMode','bar');if(change==='bar-to-free')s.setParam('changeMode','free');if(change==='meter')s.setParam('rhythm','waltz');
 const forecast=compact(s.chartView().rows[1]),actual=s.boundary({bar:1,first:false,start:p.duration}).timeline.map(t=>[t.uid,t.id,t.startBeat,t.lengthBeats]);
 assert.deepEqual(actual,forecast,`${change} next forecast matches plan`);
 s.stop();
}
console.log(JSON.stringify({passed:true,bars:trace.length,modeChanges:4,promotions:20,sample:trace.filter(x=>x.changeMode==='free'&&x.meter===4).slice(0,8)},null,2));
