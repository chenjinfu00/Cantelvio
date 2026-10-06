// Asynchronous forecast and editing: the forecast fills in background slices, rendering
// the chart never runs the model, an edit keeps every earlier step, and a new timeline
// cancels a superseded prefetch.
import assert from 'node:assert/strict';
import {Session} from '../frontend/src/session.js';
let seed=81;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296;};
const s=new Session({context:{state:'running',currentTime:0},panic(){},setMix(){},setRoleMix(){},setMaster(){},stopGroup(){},play(){}},{random});
const keepAlive=setInterval(()=>{},1000);
try {
 s.setParam('mode','auto');s.setParam('changeMode','free');
 const t0=performance.now();assert.equal(await s.prefetchChart(),true);const initialMs=performance.now()-t0;
 assert.equal(s.chartView().rows.filter(b=>b.pending).length,0);
 let inference=0;const position=s.composer.decoder.position.bind(s.composer.decoder);s.composer.decoder.position=(...args)=>(inference++,position(...args));
 for(let i=0;i<100;i++)s.chartView();assert.equal(inference,0,'render never runs the model');
 const target=s.chartView().rows[4].segments.at(-1),before=structuredClone(s.composer.steps.slice(0,target.step));
 assert.ok(s.edit(target.uid));assert.ok(s.commitEdit('D♭maj7'));assert.equal(await s.prefetchChart(),true);
 assert.deepEqual(s.composer.steps.slice(0,target.step),before);assert.deepEqual(s.composer.steps[target.step].chord,{root:1,q:11});
 assert.ok(s.chartView().rows.flatMap(b=>b.segments).some(e=>e.label.startsWith('D♭maj7')));
 // A superseded asynchronous refill cannot append stale choices to a new key.
 const stale=s.composer.prefetch(s.composer.completeBars()+6);s.commitKey({tonic:2,mode:'minor'});assert.equal(await stale,false);
 assert.deepEqual(s.composer.steps[0].chord,{root:2,q:1});assert.equal(await s.prefetchChart(),true);
 assert.ok(s.composer.steps.every(st=>st.key.tonic===2&&st.key.mode==='minor'));
 console.log(JSON.stringify({passed:true,initialForecastMs:Math.round(initialMs),generatedBars:s.composer.completeBars(),longestSliceMs:+s.composer.stats.maxChunkMs.toFixed(1),rebuilds:s.composer.stats.rebuilds},null,2));
} finally {clearInterval(keepAlive);}
