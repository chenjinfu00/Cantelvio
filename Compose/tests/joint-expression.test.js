import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadJointModel,JointDecoder,STREAMS,metricalAngles} from '../frontend/vendor/lib/joint-model.js';
import {loadExpression,EXPRESSION_META} from '../frontend/vendor/lib/joint-expression.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/joint-expression-parity.json',import.meta.url),'utf8'));
const candidate=JSON.parse(readFileSync(new URL('./fixtures/joint-continued-parity.json',import.meta.url),'utf8'));
const worst=(a,b)=>Math.max(...Array.from(a,(v,i)=>Math.abs(v-b[i])));

test('selected expression weights match the continued backbone and PyTorch heads',()=>{
 const expression=loadExpression(loadJointModel());
 assert.equal(EXPRESSION_META.baseSha256,'e2bde38d02d0ca957e7841b23a4d7e3502d8aaeb2ba3a8396e1bba08307c6ebd');
 for(let step=0;step<fixture.events.length;step++)
  assert.ok(worst(expression.extra(fixture.events[step]),fixture.extra[step])<2e-5);
 const actual=expression.logits(fixture.hidden,fixture.coarseTokens);
 for(let role=0;role<3;role++){
  assert.ok(worst(actual[role].counts,fixture.outputs[role].counts)<3e-4);
  for(const [key,expected] of Object.entries(fixture.outputs[role].fields))
   assert.ok(worst(actual[role].fields[key],expected)<3e-4,`${role}.${key}`);
 }
});

test('expression vocab preserves fractional onset and tuplet labels',()=>{
 const expression=loadExpression(loadJointModel());
 const note=expression.decode({role:0,pitch:60,sub:11,dur:17,ratio:12,dynamic:6,accent:1,wedge:2});
 assert.equal(note.subQuarter,1/12);
 assert.equal(note.ratioText,'3:2');
 assert.equal(note.dynamicText,'mf');
});

test('nonempty exact-note context reproduces PyTorch backbone features and next-token logits',()=>{
 const c=candidate.cases[0],I=c.inputs,probe=fixture.backboneProbe;
 assert.equal(c.source,probe.source);
 const decoder=new JointDecoder(loadJointModel());
 const chord0=I.H[0]-3, chord1=I.H[1]>=3?I.H[1]-3:chord0;
 for(let s=0;s<4;s++){
  const input={s,token:I[STREAMS[s]][0],front:STREAMS.map((name,i)=>i<s?I[name][1]:I[name][0]),
   global:c.globals,next:{meter:I.meter[1],lkey:I.lkey[1],pos:I.pos[1],level:I.level[1],phrase:I.phrase[1]},
   chord:s<2?{chord:chord0,since:0,change:true}:{chord:chord1,since:I.H[1]>=3?0:1,change:I.H[1]>=3},
   angQ:metricalAngles(1,I.pos[1],I.barlen[1],I.beatphase[1],I.beatlen[1]),
   angK:metricalAngles(0,I.pos[0],I.barlen[0],I.beatphase[0],I.beatlen[0]),
   nextRoot:chord1%12,extraStep:probe.extra};
  const logits=decoder.position(input,true);
  assert.ok(worst(logits,probe.logits[STREAMS[s]])<5e-4,`logits ${STREAMS[s]}`);
  assert.ok(worst(decoder.lastFeature,probe.hidden[s])<5e-4,`feature ${STREAMS[s]}`);
 }
});
