import test from 'node:test';
import assert from 'node:assert/strict';
import {purgeKeys,pruneCheckpoint} from '../scripts/purge-retired.mjs';

test('a score owns its metadata, its fit record and every one of its chunks',()=>{
  const id='a'.repeat(64);
  const keys=purgeKeys(id,{bytes:5*1048576,chunkSize:2097152,chunks:3});
  assert.deepEqual(keys.files,[id,'fit-'+id]);
  assert.deepEqual(keys.chunks,[id+'-0',id+'-1',id+'-2']);
  assert.deepEqual(purgeKeys(id,{}).chunks,[],'a record with no chunk count deletes no chunks');
  assert.deepEqual(purgeKeys(id,null).files,[id,'fit-'+id],'the metadata is still removable');
  assert.deepEqual(purgeKeys(id,{chunks:-4}).chunks,[]);
});

test('the upload checkpoint forgets a purged score, so re-adding it uploads again',()=>{
  const lines=['{"id":"aaa","bytes":1}','{"id":"bbb","bytes":2}','','not json','{"id":"ccc","bytes":3}'];
  const kept=pruneCheckpoint(lines,['bbb']);
  assert.deepEqual(kept.map(line=>JSON.parse(line).id),['aaa','ccc']);
  assert.deepEqual(pruneCheckpoint(lines,[]).map(line=>JSON.parse(line).id),['aaa','bbb','ccc'],'blank and broken lines are dropped either way');
});
