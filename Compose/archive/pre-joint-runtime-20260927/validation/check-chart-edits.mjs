import assert from 'node:assert/strict';
import {Session} from '../src/session.js';
let seed=81;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296;};
const s=new Session({context:{state:'running',currentTime:0},panic(){},setMix(){},setRoleMix(){},stopGroup(){}},{random});
const keepAlive=setInterval(()=>{},1000);
try {
 s.setParam('mode','auto');s.setParam('changeMode','free');
 const t0=performance.now();assert.equal(await s.prefetchChart(),true);const initialMs=performance.now()-t0;
 assert.equal(s.chartView().rows.filter(b=>b.pending).length,0);
 const count=s.queue.slots.length;assert.ok(count<=33,`bounded queue ${count}`);
 let inference=0;const predict=s.queue.predict;s.queue.predict=(...args)=>(inference++,predict(...args));
 for(let i=0;i<100;i++)s.chartView();assert.equal(inference,0,'render never predicts');
 const before=structuredClone(s.queue.slots),target=before[Math.min(before.length-1,4)];
 assert.ok(s.edit(target.uid));assert.ok(s.commitEdit('D♭maj7'));assert.equal(await s.prefetchChart(),true);
 const targetIndex=s.queue.slots.findIndex(e=>e.uid===target.uid);assert.equal(s.queue.slots[targetIndex].id,'D♭maj7');assert.deepEqual(s.queue.slots.slice(0,targetIndex),before.slice(0,targetIndex));
 assert.ok(s.chartView().rows.flatMap(b=>b.segments).some(e=>e.slot.id==='D♭maj7'));
 // A superseded asynchronous refill cannot append stale choices to a new key.
 const stale=s.prefetchChart();s.commitKey({tonic:2,mode:'minor'});await stale;assert.equal(await s.prefetchChart(),true);assert.equal(s.queue.slots[0].id,'Dm');assert.ok(s.queue.slots.every(x=>x.key.tonic===2));
 s.transport.running=true;const p=s.boundary({bar:0,first:true,start:1});
 const beforeOnset=inference;s.transport.frame={bar:0,start:1,duration:p.duration,beats:p.beats};p.onStart();for(const x of p.transitions)x.onStart();assert.equal(inference,beforeOnset,'onset never predicts synchronously');
 const archive=structuredClone([...s.chartArchive]);s.setParam('harmonyT',1.3);await s.prefetchChart();assert.deepEqual([...s.chartArchive],archive,'regeneration preserves actual bar history');
 s.transport.stop('test interruption');s.transport.onChange('interrupted');assert.equal(s.chartArchive.size,0);assert.equal(s.chartScheduled.size,0);await s.prefetchChart();assert.equal(s.chartView().baseBar,0);
 console.log(JSON.stringify({passed:true,initialMs:Math.round(initialMs),initialQueueCount:count,checks:['bounded async fill','no render inference','future edit preserves prefix','new key cancels stale task','no onset inference','immutable history','interruption resets chart']},null,2));
} finally {s.chartPrefetchGeneration++;clearInterval(keepAlive);}
