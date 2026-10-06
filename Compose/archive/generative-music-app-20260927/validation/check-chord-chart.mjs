import assert from 'node:assert/strict';
import {forecastBars,chartRows,segmentStyle} from '../src/chord-chart.js';
const slot=(uid,id,unit,count)=>({uid,id,key:{tonic:0,mode:'major'},durationSpec:{unit,count},durationBeats:unit==='bars'?4*count:count,meter:4});
const slots=[slot(1,'C','beats',1),slot(2,'G','beats',2),slot(3,'Am','bars',2),slot(4,'F','bars',1),...Array.from({length:12},(_,i)=>slot(5+i,i%2?'G':'C','bars',1))];
const failures=[];const check=(name,fn)=>{try{fn();console.log('PASS',name);}catch(e){failures.push({name,error:e.message});console.log('FAIL',name,e.message);}};
const compact=bars=>bars.map(b=>({bar:b.bar,spans:b.segments.map(s=>[s.slot.uid,s.startBeat,s.lengthBeats,!!s.continuation])}));
check('literal short/long spans are positioned at actual beats',()=>{
 const bars=forecastBars({slots,startUid:1,elapsedBeats:0,startBar:0,barCount:4,mode:'auto',changeMode:'free',beatsPerBar:4});
 assert.deepEqual(compact(bars),[
  {bar:0,spans:[[1,0,1,false],[2,1,2,false],[3,3,1,false]]},
  {bar:1,spans:[[3,0,4,true]]},
  {bar:2,spans:[[3,0,3,true],[4,3,1,false]]},
  {bar:3,spans:[[4,0,3,true],[5,3,1,false]]}
 ]);
});
check('Every bar initial forecast includes current tonic',()=>{
 const bars=forecastBars({slots,startUid:1,elapsedBeats:0,startBar:0,barCount:4,mode:'auto',changeMode:'bar',beatsPerBar:4});
 assert.deepEqual(bars.map(b=>b.segments.map(s=>s.slot.uid)),[[1],[2],[3],[4]]);
});
check('actual played plan wins over overlapping forecast',()=>{
 const frozen={bar:2,meter:3,segments:[{slot:slots[1],startBeat:0,lengthBeats:3}]};
 const forecast={bar:2,meter:4,segments:[{slot:slots[2],startBeat:0,lengthBeats:4}]};
 const rows=chartRows({baseBar:0,plans:[frozen],forecast:[forecast],beatsPerBar:4});
 assert.equal(rows.length,8);assert.equal(rows[2].meter,3);assert.equal(rows[2].segments[0].slot.uid,2);
});
check('exhausted forecast does not fabricate repeated chords',()=>{
 const bars=forecastBars({slots:[slot(1,'C','beats',1),slot(2,'G','beats',1)],startUid:1,elapsedBeats:0,startBar:0,barCount:8,mode:'auto',changeMode:'free',beatsPerBar:4});
 const generated=bars.flatMap(b=>b.segments);assert.deepEqual(generated.map(s=>s.slot.uid),[1,2]);
});
check('unknown explicit UID cannot silently restart from head',()=>{
 const bars=forecastBars({slots,startUid:999,elapsedBeats:0,startBar:0,barCount:8,mode:'auto',changeMode:'free',beatsPerBar:4});assert.equal(bars.flatMap(b=>b.segments).length,0);
});
check('four-measure page base preserves promoted identities',()=>{
 const all=forecastBars({slots,startUid:1,elapsedBeats:0,startBar:0,barCount:12,mode:'auto',changeMode:'free',beatsPerBar:4});
 const first=chartRows({baseBar:0,forecast:all}),next=chartRows({baseBar:4,forecast:all});assert.deepEqual(first.slice(4),next.slice(0,4));assert.deepEqual(next.map(b=>b.bar),[4,5,6,7,8,9,10,11]);
});
check('display widths correspond to meter, not chord index',()=>{
 assert.equal(segmentStyle({startBeat:1,lengthBeats:2},4),'left:25.0000%;width:50.0000%');
 assert.equal(segmentStyle({startBeat:1,lengthBeats:2},3),'left:33.3333%;width:66.6667%');
});
if(failures.length){process.exitCode=1;console.log(JSON.stringify({failures},null,2));}
