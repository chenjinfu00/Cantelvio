import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadJointModel,decodeJointModel,JointDecoder,JOINT_META,STREAMS,VOCAB,metricalAngles,metricalLevel,N_SINCE} from '../frontend/vendor/lib/joint-model.js';
import {JOINT_META as CANDIDATE_META} from '../frontend/vendor/lib/joint-continued-weights.js';
import {JOINT_META as HISTORICAL_META,JOINT_MANIFEST as HISTORICAL_MANIFEST,JOINT_WEIGHTS_BASE64 as HISTORICAL_WEIGHTS} from '../frontend/vendor/lib/joint-weights.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/joint-parity.json',import.meta.url),'utf8'));
const candidateFixture=JSON.parse(readFileSync(new URL('./fixtures/joint-continued-parity.json',import.meta.url),'utf8'));

/** Teacher-forced inputs for position (t, s) of a fixture window, as in StructuredJoint.forward. */
function windowInputs(c){
 const I=c.inputs,n=c.steps,chord=[],since=[],change=[];let cur=0,run=0;
 for(let t=0;t<n;t++){if(I.H[t]>=3){cur=I.H[t]-3;run=0;}else run++;chord.push(cur);since.push(Math.min(run,N_SINCE-1));change.push(I.H[t]>=3);}
 return (t,s)=>({s,token:I[STREAMS[s]][t],front:STREAMS.map((u,ui)=>ui<s?I[u][t+1]:I[u][t]),global:c.globals,
  next:{meter:I.meter[t+1],lkey:I.lkey[t+1],pos:I.pos[t+1],level:I.level[t+1],phrase:I.phrase[t+1]},
  chord:s<2?{chord:chord[t],since:since[t],change:change[t]}:{chord:chord[t+1],since:since[t+1],change:change[t+1]},
  angQ:metricalAngles(t+1,I.pos[t+1],I.barlen[t+1],I.beatphase[t+1],I.beatlen[t+1]),angK:metricalAngles(t,I.pos[t],I.barlen[t],I.beatphase[t],I.beatlen[t]),nextRoot:chord[t+1]%12});
}

test('exported weights match the evaluated checkpoint shape and provenance',()=>{
 const m=loadJointModel();
 assert.equal(JOINT_META.parameters,1581309);
 assert.equal(JOINT_META.float32Count,JOINT_META.parameters);
 assert.deepEqual(JOINT_META.config,{kind:'structured',d:96,heads:6,layers:4,ff:256,T:128,dropout:.1});
 assert.deepEqual(VOCAB,{R:6,H:483,B:52,M:40});
 assert.match(JOINT_META.checkpoint.sha256,/^[0-9a-f]{64}$/);
 assert.equal(m.layers.length,4);assert.equal(m.tok[1].length,483*96);assert.equal(loadJointModel(),m);
});

test('deployed continued decoder reproduces PyTorch logits on real validation windows (R, H, B, M)',()=>{
 const model=loadJointModel();let worst=0,compared=0;
 for(const c of candidateFixture.cases){
  const input=windowInputs(c),dec=new JointDecoder(model);
  for(let t=0;t<c.steps-1;t++)for(let s=0;s<4;s++){
   const want=c.expected[String(t)],logits=dec.position(input(t,s),!!want);
   if(want)for(let i=0;i<want[STREAMS[s]].length;i++){worst=Math.max(worst,Math.abs(want[STREAMS[s]][i]-logits[i]));compared++;}
  }
 }
 assert.ok(compared>9000,`compared ${compared}`);
 assert.ok(worst<1e-3,`largest logit difference ${worst}`);
});

test('historical backbone remains available for offline parity but is not the runtime model',()=>{
 const production=loadJointModel();
 const model=decodeJointModel(HISTORICAL_META,HISTORICAL_MANIFEST,HISTORICAL_WEIGHTS);
 assert.equal(CANDIDATE_META.parameters,JOINT_META.parameters);
 assert.equal(CANDIDATE_META.checkpoint.sha256,JOINT_META.checkpoint.sha256);
 assert.notEqual(HISTORICAL_META.checkpoint.sha256,JOINT_META.checkpoint.sha256);
 assert.equal(loadJointModel(),production);
 let worst=0,compared=0;
 for(const c of fixture.cases){
  const input=windowInputs(c),dec=new JointDecoder(model);
  for(let t=0;t<c.steps-1;t++)for(let s=0;s<4;s++){
   const want=c.expected[String(t)],logits=dec.position(input(t,s),!!want);
   if(want)for(let i=0;i<want[STREAMS[s]].length;i++){
    worst=Math.max(worst,Math.abs(want[STREAMS[s]][i]-logits[i]));compared++;
   }
  }
 }
 assert.ok(compared>9000,`compared ${compared}`);
 assert.ok(worst<1e-3,`largest candidate logit difference ${worst}`);
});

test('truncating the key/value cache and refeeding gives identical logits',()=>{
 const c=fixture.cases[0],input=windowInputs(c),dec=new JointDecoder();
 for(let t=0;t<20;t++)for(let s=0;s<4;s++)dec.position(input(t,s),false);
 dec.position(input(20,0),false);
 const first=Array.from(dec.position(input(20,1),true));
 dec.truncate(4*20+1);
 assert.deepEqual(Array.from(dec.position(input(20,1),true)),first);
 dec.truncate(4*20);
 dec.position(input(20,0),false);
 assert.deepEqual(Array.from(dec.position(input(20,1),true)),first);
 assert.throws(()=>{const d=new JointDecoder(undefined,2);d.position(input(0,0),false);d.position(input(0,1),false);d.position(input(0,2),false);},/full/);
});

test('metrical helpers follow the training encoding',()=>{
 assert.deepEqual([0,4,8,12,2,6,1,15].map(p=>metricalLevel(p,4)),[0,1,1,1,2,2,3,3]);
 const a=metricalAngles(3,4,16,0,4);
 assert.ok(Math.abs(a[0]-3*Math.PI/2)<1e-12&&Math.abs(a[6]-Math.PI/2)<1e-12&&a[4]===0);
});
