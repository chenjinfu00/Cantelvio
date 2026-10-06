// Session oracle: for 96 bars across timings, meters and mode changes, the chart shows
// exactly the bars that are then scheduled, the page promotes every four bars, and Stop
// resets the chart history.
import assert from 'node:assert/strict';
import {Session} from '../frontend/src/session.js';
import {barSignature} from '../frontend/src/chord-chart.js';
const seeded=seed=>()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296;};
const make=()=>new Session({context:{state:'running',currentTime:0},panic(){},setMix(){},setRoleMix(){},setMaster(){},stopGroup(){},play(){}},{random:seeded(998)});
const trace=[];let promotions=0;
for(const changeMode of ['bar','free'])for(const meter of [3,4]){
 const s=make();s.setParam('mode','auto');s.setParam('changeMode',changeMode);s.setParam('meter',meter);s.transport.running=true;
 let clock=0,lastBase=0;
 for(let bar=0;bar<24;bar++){
  s.composer.ensureBar(bar+2);
  const before=s.chartView(),forecast=before.rows.find(b=>b.bar===bar);
  assert.ok(forecast&&!forecast.pending,`${changeMode}/${meter} has forecast bar ${bar}`);
  const advertised=barSignature(forecast),plan=s.boundary({bar,first:bar===0,start:clock});
  assert.deepEqual(plan.timeline.map(t=>[Number(t.uid.split(':')[1]),t.label,t.startBeat,t.lengthBeats]),advertised,`${changeMode}/${meter} bar ${bar} advertised matches played`);
  s.transport.frame={bar,start:clock,duration:plan.duration,beats:plan.beats};plan.onStart();for(const transition of plan.transitions)transition.onStart();
  const after=s.chartView();assert.equal(after.baseBar,Math.floor(bar/4)*4);assert.equal(after.rows.length,8);assert.deepEqual(barSignature(after.rows.find(b=>b.bar===bar)),advertised);
  if(after.baseBar!==lastBase){promotions++;lastBase=after.baseBar;}
  trace.push({changeMode,meter,bar,baseBar:after.baseBar,chords:plan.timeline.map(t=>`${t.label}@${t.startBeat}`)});clock+=plan.duration;
 }
 s.stop();assert.equal(s.chartView().baseBar,0);assert.equal(s.composer.lockedBars,0);assert.equal(s.composer.steps.length>=1,true);
}
for(const change of ['hold-to-auto','free-to-bar','bar-to-free','meter','scene','key']){
 const s=make();s.setParam('mode',change==='hold-to-auto'?'hold':'auto');s.setParam('changeMode',change==='bar-to-free'?'bar':'free');s.transport.running=true;s.composer.ensureBar(3);
 let p=s.boundary({bar:0,first:true,start:0});s.transport.frame={bar:0,start:0,duration:p.duration,beats:p.beats};p.onStart();for(const t of p.transitions)t.onStart();
 if(change==='hold-to-auto')s.setParam('mode','auto');if(change==='free-to-bar')s.setParam('changeMode','bar');if(change==='bar-to-free')s.setParam('changeMode','free');if(change==='meter')s.setParam('meter',3);if(change==='scene')s.selectScene('velvet');if(change==='key')s.setKey({tonic:7,mode:'major'});
 s.composer.ensureBar(2);
 const forecast=barSignature(s.chartView().rows[1]),actual=s.boundary({bar:1,first:false,start:p.duration}).timeline.map(t=>[Number(t.uid.split(':')[1]),t.label,t.startBeat,t.lengthBeats]);
 assert.deepEqual(actual,forecast,`${change} next forecast matches plan`);
 if(change==='meter')assert.equal(s.composer.bars[1].beats,3);
 if(change==='key')assert.equal(s.barSpans(1)[0].label,'G');
 s.stop();
}
console.log(JSON.stringify({passed:true,bars:trace.length,modeChanges:6,promotions,sample:trace.filter(x=>x.changeMode==='free'&&x.meter===4).slice(0,8)},null,2));
