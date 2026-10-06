import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fitLayout,includeInk,safeBounds} from '../docs/fit-layout.js';
import {pinchTransform,clampZoom} from '../docs/score-zoom.js';
import {validateInk} from '../docs/ink-validation.js';
import {libraryRoot,libraryData} from '../scripts/library-root.mjs';

test('content fit contains complete marked bounds for both orientations without stretching',()=>{
  for(const natural of [{width:600,height:900},{width:900,height:600}])for(const screen of [{width:1024,height:1366},{width:1366,height:1024}]){
    const bounds=[.05,.06,.93,.97],value=fitLayout(natural,{...screen,fit:'screen',zoom:1,protectFit:true},bounds);
    assert.ok(value.clip.width<=screen.width+1e-8&&value.clip.height<=screen.height+1e-8);
    assert.ok(Math.abs(value.width/value.height-natural.width/natural.height)<1e-9);
    assert.ok(value.clip.x>=0&&value.clip.y>=0);
  }
  assert.deepEqual(safeBounds([NaN,0,1,1]),[0,0,1,1]);
  const box=includeInk([.1,.1,.9,.9],[{width:.002,points:[[.03,.98,.5]]}]);assert.ok(box[0]<.03&&box[3]>.98);
});
test('all private pages have conservative finite bounds and keep originals unchanged',async t=>{
  let root;try{root=libraryRoot();}catch{t.skip('Private collection is not available at the configured library path');return;}
  const data=libraryData(root),summary=JSON.parse(await fs.readFile(path.join(data,'fit-summary.json'))),manifest=JSON.parse(await fs.readFile(path.join(data,'manifest.json')));
  let pages=0;assert.equal(summary.pdfs,Object.keys(manifest.files).length);assert.deepEqual(summary.failed,[]);
  for(const id of Object.keys(manifest.files)){const value=JSON.parse(await fs.readFile(path.join(data,'fit',id+'.json')));pages+=value.pages.length;for(const page of value.pages)assert.deepEqual(safeBounds(page.bounds),page.bounds);}
  assert.equal(summary.pages,pages);
});
test('pinch clamps minimum to fit and uses a score-local transform, not document zoom',()=>{
  const start={zoom:1,distance:100,left:0,top:0,center:{x:200,y:200}};
  const result=pinchTransform(start,[{x:100,y:200},{x:300,y:200}]);assert.equal(result.zoom,2);assert.equal(result.x,-200);assert.equal(result.y,-200);
  assert.equal(clampZoom(.5),1);assert.equal(clampZoom(20),4);assert.equal(clampZoom(NaN),1);
});
test('ink that arrives from a file or another device is checked before it is kept',()=>{
  assert.equal(validateInk({version:1,strokes:[]}),true);
  assert.equal(validateInk({version:1,strokes:[{id:'x',color:'red',width:1,points:[]}]}),false,'a stroke with no points is not ink');
});
