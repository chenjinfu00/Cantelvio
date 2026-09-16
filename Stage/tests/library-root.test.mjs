import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {libraryRoot,CANDIDATES} from '../scripts/library-root.mjs';

test('the collection is looked for beside the project, then inside it',()=>{
  const project='/tmp/volta';
  const beside=path.join('/tmp','本地曲谱'),inside=path.join(project,'本地曲谱');
  assert.equal(libraryRoot({env:'',project,exists:file=>file===path.join(beside,'catalog.json')}),beside);
  assert.equal(libraryRoot({env:'',project,exists:file=>file===path.join(inside,'catalog.json')}),inside,'an older layout still works');
  assert.deepEqual(CANDIDATES,['../本地曲谱','本地曲谱']);
});

test('an explicit location wins, and a missing one says where it looked',()=>{
  const project='/tmp/volta';
  assert.equal(libraryRoot({env:'/somewhere/曲谱库',project,exists:()=>true}),'/somewhere/曲谱库');
  assert.throws(()=>libraryRoot({env:'',project,exists:()=>false}),/找不到本地曲谱[\s\S]*本地曲谱/);
  assert.throws(()=>libraryRoot({env:'/nope',project,exists:()=>false}),/nope/);
});
