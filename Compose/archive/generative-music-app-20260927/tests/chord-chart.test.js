import test from 'node:test';
import assert from 'node:assert/strict';
import {chartRows,forecastBars} from '../src/chord-chart.js';
import {Session} from '../src/session.js';

const slot=(uid,id,unit='bars',count=1)=>({uid,id,key:{tonic:0,mode:'major'},durationSpec:{unit,count},durationBeats:unit==='bars'?4*count:count,meter:4});
const audio=()=>({context:{state:'running',currentTime:0},setMix(){},setRoleMix(){},stopGroup(){},panic(){},play(){}});

test('chart forecast uses committed beat spans and never repeats exhausted slots',()=>{
 const slots=[slot(1,'C','beats',1),slot(2,'G','beats',2),slot(3,'Am','bars',2),slot(4,'F','bars',1)];
 const bars=forecastBars({slots,startUid:1,startBar:0,barCount:8,mode:'auto',changeMode:'free',beatsPerBar:4});
 assert.deepEqual(bars.slice(0,3).map(b=>b.segments.map(s=>[s.slot.uid,s.startBeat,s.lengthBeats])),[
  [[1,0,1],[2,1,2],[3,3,1]],[[3,0,4]],[[3,0,3],[4,3,1]]
 ]);
 assert.equal(bars.flatMap(b=>b.segments).some(s=>s.slot.uid===4&&s.startBeat>3),false);
});

test('bar mode starts on the current UID and mixed meter changes the measure width',()=>{
 const slots=Array.from({length:12},(_,i)=>slot(i+1,['C','G','Am','F'][i%4]));
 const bars=forecastBars({slots,startUid:1,startBar:0,barCount:8,mode:'auto',changeMode:'bar',beatsPerBar:bar=>bar===1?3:4});
 assert.deepEqual(bars.slice(0,3).map(b=>[b.meter,b.segments[0].slot.uid]),[[4,1],[3,2],[4,3]]);
 const actual={bar:1,meter:3,segments:[{slot:slots[1],startBeat:0,lengthBeats:3}]};
 const page=chartRows({baseBar:0,plans:[actual],forecast:bars});
 assert.equal(page.length,8);assert.equal(page[1].meter,3);assert.equal(page[1].segments[0].slot.uid,2);
});

test('archived audible plan matches its score spans and four-bar rollover clears the old page',()=>{
 const s=new Session(audio(),{random:()=>.37});s.setParam('mode','auto');s.setParam('changeMode','bar');
 const plans=[];
 for(let bar=0;bar<4;bar++){const plan=s.boundary({bar,first:bar===0,start:null});plans.push(plan);s.transport.frame={bar,beats:4,start:bar*2,duration:2};}
 const first=s.chartView();
 assert.deepEqual(first.rows[0].segments.map(v=>[v.slot.uid,v.startBeat,v.lengthBeats]),plans[0].timeline.map(v=>[v.uid,v.startBeat,v.lengthBeats]));
 s.transport.frame={bar:4,beats:4,start:8,duration:2};const next=s.chartView();
 assert.equal(next.baseBar,4);assert.deepEqual(next.rows.map(v=>v.bar),[4,5,6,7,8,9,10,11]);
 assert.equal(next.rows[0].segments.some(v=>v.slot.uid===plans[0].timeline[0].uid),false);
 const nextPlan=s.boundary({bar:4,first:false,start:null});
 assert.deepEqual(next.rows[0].segments.map(v=>[v.slot.uid,v.startBeat,v.lengthBeats]),nextPlan.timeline.map(v=>[v.uid,v.startBeat,v.lengthBeats]));
 s.stop();assert.equal(s.chartArchive.size,0);assert.equal(s.chartScheduled.size,0);
});
