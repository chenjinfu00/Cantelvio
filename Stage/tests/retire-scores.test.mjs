import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {resolveIds,retirePlan} from '../scripts/retire-scores.mjs';

const catalog={items:[
  {id:'aaaa1111'+'0'.repeat(56),title:'甲',bytes:1000},
  {id:'aaaa2222'+'0'.repeat(56),title:'乙',bytes:2000},
  {id:'bbbb3333'+'0'.repeat(56),title:'丙',bytes:3000},
]};
const manifest={files:Object.fromEntries(catalog.items.map(item=>[item.id,'曲谱/'+item.title+'.pdf']))};

test('a short id prefix is enough, but never when it could mean two scores',()=>{
  assert.deepEqual(resolveIds(catalog.items,['bbbb3333']).found.map(i=>i.title),['丙']);
  assert.deepEqual(resolveIds(catalog.items,['aaaa']).ambiguous[0].ids.length,2);
  assert.deepEqual(resolveIds(catalog.items,['zzzz']).missing,['zzzz']);
  assert.equal(resolveIds(catalog.items,['bbbb3333','bbbb3333']).found.length,1,'a repeated id is retired once');
});

test('the plan says exactly what leaves and what stays, before anything moves',()=>{
  const plan=retirePlan(catalog,manifest,['aaaa1111','bbbb3333']);
  assert.deepEqual(plan.moves.map(m=>m.title),['甲','丙']);
  assert.deepEqual(plan.keep.map(i=>i.title),['乙'],'everything else is untouched');
  assert.equal(plan.bytes,4000);
  assert.deepEqual(plan.unmapped,[],'every retired score has a file to move');
  assert.equal(plan.moves[0].from,'曲谱/甲.pdf');
  const orphan=retirePlan(catalog,{files:{}},['乙'.length?'aaaa2222':'']);
  assert.deepEqual(orphan.unmapped.length,1,'a score with no file on disk is reported, not silently dropped');
});

test('a rebuild never resurrects a score that was retired on purpose',async()=>{
  const builder=await fs.readFile(new URL('../scripts/build-local-library.mjs',import.meta.url),'utf8');
  assert.match(builder,/retired\.json/);
  assert.match(builder,/!isRetired\(x\.id\)/);
  const script=await fs.readFile(new URL('../scripts/retire-scores.mjs',import.meta.url),'utf8');
  assert.match(script,/--apply/,'the default run is a preview');
  assert.match(script,/retired/,'files move instead of being deleted');
  assert.doesNotMatch(script,/fs\.(rm|unlink)\(/,'nothing is ever unlinked');
});
