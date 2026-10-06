import test from 'node:test';
import assert from 'node:assert/strict';
import {durationLabel,segmentStyle,barSignature} from '../frontend/src/chord-chart.js';
import {Session} from '../frontend/src/session.js';

const seeded=seed=>()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296;};
const fakeAudio=()=>({context:{state:'running',currentTime:0},panic(){},setMix(){},setRoleMix(){},setMaster(){},stopGroup(){},play(){}});

test('duration labels and widths use real beats',()=>{
 assert.equal(durationLabel(4,4),'1 bar');assert.equal(durationLabel(8,4),'2 bars');assert.equal(durationLabel(3,3,'zh'),'1 小节');
 assert.equal(durationLabel(1,4),'1 beat');assert.equal(durationLabel(2,3),'2 beats');assert.equal(durationLabel(1.5,4),'1.5 beats');
 assert.equal(segmentStyle({startBeat:1,lengthBeats:2},4),'left:25.0000%;width:50.0000%');
 assert.equal(segmentStyle({startBeat:0,lengthBeats:3},3),'left:0.0000%;width:100.0000%');
});

test('segments tile each measure, two rows of four, promotion every four bars',()=>{
 for(const [meter,changeMode] of [[4,'free'],[3,'free'],[4,'bar'],[3,'bar']]){
  const s=new Session(fakeAudio(),{random:seeded(meter*7+changeMode.length)});
  s.setParam('meter',meter);s.setParam('mode','auto');s.setParam('changeMode',changeMode);s.transport.running=true;
  let clock=0;
  for(let bar=0;bar<9;bar++){
   s.composer.ensureBar(bar+8);
   const view=s.chartView();
   assert.equal(view.rows.length,8);assert.equal(view.baseBar,Math.floor(Math.max(0,bar-1)/4)*4,"page follows the sounding bar");
   for(const row of view.rows){
    assert.equal(row.pending,false);assert.equal(row.meter,meter);
    let cursor=0;for(const seg of row.segments){assert.equal(seg.startBeat,cursor);assert.ok(seg.lengthBeats>0&&seg.label);cursor+=seg.lengthBeats;}
    assert.equal(cursor,meter,`${meter}/${changeMode} bar ${row.bar+1} fills its beats`);
    if(changeMode==='bar'&&row.bar>0)assert.deepEqual(row.segments.map(x=>[x.startBeat,x.continuation]),[[0,false]]);
   }
   const advertised=barSignature(view.rows.find(r=>r.bar===bar));
   const plan=s.boundary({bar,first:bar===0,start:clock});
   s.transport.frame={bar,start:clock,duration:plan.duration,beats:plan.beats};plan.onStart();for(const t of plan.transitions)t.onStart();
   assert.deepEqual(barSignature(s.chartView().rows.find(r=>r.bar===bar)),advertised);
   assert.ok(s.chartView().rows.find(r=>r.bar===bar).segments.some(x=>x.sounding)||plan.transitions.length>0);
   clock+=plan.duration;
  }
 }
});
