// Pure chart checks for the joint-model timeline: every generated bar is laid out at
// real beats, spans tile the measure, continuations are marked, and the two-row page
// promotes by four measures.
import assert from 'node:assert/strict';
import {Composer} from '../frontend/src/composer.js';
import {Session} from '../frontend/src/session.js';
import {segmentStyle,durationLabel} from '../frontend/src/chord-chart.js';
const seeded=seed=>()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296;};
const fakeAudio=()=>({context:{state:'running',currentTime:0},panic(){},setMix(){},setRoleMix(){},setMaster(){},stopGroup(){},play(){}});
const failures=[];const check=(name,fn)=>{try{fn();console.log('PASS',name);}catch(e){failures.push({name,error:e.message});console.log('FAIL',name,e.message);}};
const STYLES={lieder:[1,3],pop:[0,0],jazz:[0,1]};
check('spans tile every generated measure at actual beats (3 styles x 2 meters x 2 timings, 16 bars each)',()=>{
 for(const [style,[domain,styleId]] of Object.entries(STYLES))for(const beats of [4,3])for(const changeMode of ['free','bar']){
  const c=new Composer({random:seeded(beats*13+domain+styleId),planBar:(i,prev)=>({cond:{domain,styleId,style,harmonyT:.8,melodyT:.8,density:.5,mode:'auto',changeMode,beats},key:{tonic:0,mode:'major'},keyAge:0})});
  c.reset({key:{tonic:0,mode:'major'},chord:{root:0,q:0}});c.ensureBar(15);
  for(let b=0;b<16;b++){const spans=c.chordSpans(b),bar=c.bars[b];let cursor=bar.start;
   for(const s of spans){assert.equal(s.step,cursor);assert.equal(s.continuation,!c.steps[s.step].change);cursor+=s.length;}
   assert.equal(cursor,bar.start+bar.barlen,`${style} ${beats}/4 ${changeMode} bar ${b+1}`);
   if(changeMode==='bar'&&b>0)assert.equal(spans.length,1);
   if(changeMode==='free')for(const s of spans)assert.equal((s.step-bar.start)%4,0,'free changes fall on beats');
  }
 }
});
check('continued chords keep their identity across measures and rows',()=>{
 const s=new Session(fakeAudio(),{random:seeded(3)});s.setParam('mode','hold');s.composer.ensureBar(9);
 const rows=s.chartView().rows;assert.equal(rows.length,8);
 assert.ok(rows.slice(1).every(r=>r.segments.length===1&&r.segments[0].continuation&&r.segments[0].onset===0));
});
check('four-measure page promotion keeps the lower row',()=>{
 const s=new Session(fakeAudio(),{random:seeded(8)});s.setParam('mode','auto');s.composer.ensureBar(13);s.transport.running=true;
 const first=s.chartView();s.transport.frame={bar:4,start:0,duration:2,beats:4};const next=s.chartView();
 assert.deepEqual(next.rows.map(r=>r.bar),[4,5,6,7,8,9,10,11]);
 assert.deepEqual(first.rows.slice(4).map(r=>r.segments.map(x=>x.label)),next.rows.slice(0,4).map(r=>r.segments.map(x=>x.label)));
});
check('display widths correspond to meter, not chord index',()=>{
 assert.equal(segmentStyle({startBeat:1,lengthBeats:2},4),'left:25.0000%;width:50.0000%');
 assert.equal(segmentStyle({startBeat:1,lengthBeats:2},3),'left:33.3333%;width:66.6667%');
 assert.equal(durationLabel(8,4),'2 bars');assert.equal(durationLabel(2,3,'zh'),'2 拍');
});
if(failures.length){process.exitCode=1;console.log(JSON.stringify({failures},null,2));}
