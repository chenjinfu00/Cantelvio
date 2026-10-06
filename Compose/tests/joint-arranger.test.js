import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadArranger,durationBucket} from '../frontend/vendor/lib/joint-arranger.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/joint-arranger-parity.json',import.meta.url),'utf8'));
test('six-group browser classifier matches selected PyTorch checkpoint',()=>{
 const arranger=loadArranger();
 let worst=0;
 for(const testCase of fixture.cases){
  const {logits,presence}=arranger.infer(testCase.notes.map(([pitch,pos,dur])=>({pitch,pos,dur})),testCase.meter,testCase.barLen);
  for(let j=0;j<logits.length;j++)for(let k=0;k<6;k++)worst=Math.max(worst,Math.abs(logits[j][k]-testCase.expected[j][k]));
  for(let k=0;k<6;k++)worst=Math.max(worst,Math.abs(presence[k]-testCase.presence[k]));
 }
 assert.ok(worst<5e-4,`worst difference ${worst}`);
 assert.equal(durationBucket(1),9); // 12 grid steps
});
