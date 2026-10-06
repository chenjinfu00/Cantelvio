import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {libraryRoot,CANDIDATES,ICLOUD_LIBRARY} from '../scripts/library-root.mjs';

test('the collection is found beside a project, beside its parent, or inside it',()=>{
  const project='/tmp/volta';
  const beside=path.join('/tmp','本地曲谱'),inside=path.join(project,'本地曲谱');
  assert.equal(libraryRoot({env:'',project,exists:file=>file===path.join(beside,'catalog.json')}),beside);
  assert.equal(libraryRoot({env:'',project,exists:file=>file===path.join(inside,'catalog.json')}),inside,'an older layout still works');
  const nested='/music/projects/Volta',collection='/music/本地曲谱';
  assert.equal(libraryRoot({env:'',project:nested,exists:file=>file===path.join(collection,'曲谱库数据/catalog.json')}),collection);
  assert.deepEqual(CANDIDATES,['../本地曲谱','../../本地曲谱','本地曲谱',ICLOUD_LIBRARY]);
  assert.equal(libraryRoot({env:'',project:'/apps/Cantelvio/Stage',exists:file=>file===path.join(ICLOUD_LIBRARY,'曲谱库数据/catalog.json')}),ICLOUD_LIBRARY,'falls back to iCloud Drive');
});

test('an explicit location wins, and a missing one says where it looked',()=>{
  const project='/tmp/volta';
  assert.equal(libraryRoot({env:'/somewhere/曲谱库',project,exists:()=>true}),'/somewhere/曲谱库');
  assert.throws(()=>libraryRoot({env:'',project,exists:()=>false}),/找不到本地曲谱[\s\S]*本地曲谱/);
  assert.throws(()=>libraryRoot({env:'/nope',project,exists:()=>false}),/nope/);
});
