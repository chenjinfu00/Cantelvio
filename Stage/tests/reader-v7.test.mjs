import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pageDimensions} from '../docs/page-cache.js';
import {dockPlacement,nearestDockEdge} from '../docs/dock-position.js';
import {capturePosition,restorePosition,ReadingPosition} from '../docs/reading-position.js';
import {defaults,normalizeSettings} from '../docs/settings.js';
import {chooseVersion,groupWorks} from '../docs/library-model.js';
import {createPreviewServer} from '../scripts/preview.mjs';

test('protected screen fit contains every page edge for portrait, landscape, square and narrow PDFs',()=>{
  for(const natural of [{width:210,height:297},{width:400,height:200},{width:200,height:400},{width:600,height:600}])for(const screen of [{width:1024,height:1366},{width:1366,height:1024},{width:512,height:768}]){
    const size=pageDimensions(natural,{...screen,fit:'screen',zoom:1,protectFit:true});assert.ok(size.width<=screen.width+1e-9);assert.ok(size.height<=screen.height+1e-9);assert.ok(Math.abs(size.width/size.height-natural.width/natural.height)<1e-10);
  }
  assert.equal(defaults.protectFit,true);assert.equal(normalizeSettings({}).rememberPosition,true);
});
test('dock can snap to all four edges and restores proportional location without leaving the screen',()=>{
  const area={width:1024,height:1366,dockWidth:60,dockHeight:210};
  for(const [x,y,edge] of [[8,700,'left'],[956,700,'right'],[480,32,'top'],[480,1148,'bottom']]){
    const saved=nearestDockEdge(x,y,area);assert.equal(saved.edge,edge);
    for(const a of [area,{width:1366,height:1024,dockWidth:60,dockHeight:210},{width:350,height:600,dockWidth:60,dockHeight:210}]){const p=dockPlacement(saved,a);assert.ok(p.x>=8&&p.x+60<=a.width);assert.ok(p.y>=32&&p.y+210<=a.height);}
  }
  assert.equal(dockPlacement({fraction:NaN},area).edge,'right');
});
test('scroll alignment survives page swap, refinement, clamping and return to a tall page',async()=>{
  const originalRAF=globalThis.requestAnimationFrame,originalStorage=globalThis.localStorage,store=new Map();
  globalThis.requestAnimationFrame=fn=>{fn();return 1;};globalThis.localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  try{
    const stage={scrollLeft:120,scrollTop:150,scrollWidth:1200,scrollHeight:1800,clientWidth:1024,clientHeight:1366,classList:{contains:()=>false},addEventListener(){}};
    const positions=new ReadingPosition(stage);positions.setScore('a');positions.remember();const pose=positions.snapshot();assert.deepEqual(pose,capturePosition(stage));
    await positions.paint(()=>{stage.scrollTop=0;stage.scrollLeft=0;},pose);assert.equal(stage.scrollTop,150);
    stage.scrollHeight=1366;stage.scrollWidth=1024;restorePosition(stage,pose);positions.remember();assert.deepEqual(positions.snapshot(),pose);
    stage.scrollHeight=1800;stage.scrollWidth=1200;await positions.paint(()=>{},positions.snapshot());assert.equal(stage.scrollTop,150);
    positions.setScore('b');assert.deepEqual(positions.snapshot(),{x:0,y:0});positions.setScore('a');assert.deepEqual(positions.snapshot(),pose);
    await positions.reset();assert.equal(stage.scrollTop,0);
  }finally{globalThis.requestAnimationFrame=originalRAF;if(originalStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=originalStorage;}
});
test('latest version is the initial choice but a saved choice takes priority',()=>{
  const work={versions:[{id:'old',format:'pdf',available:true,modifiedAt:'2020-01-01'},{id:'new',format:'pdf',available:true,modifiedAt:'2025-01-01'}]};assert.equal(chooseVersion(work).id,'new');assert.equal(chooseVersion(work,'old').id,'old');
});
test('local collection stays out of public assets and has 701 distinct classified PDFs',async t=>{
  const folder=new URL('../.local-library/',import.meta.url);let catalog;
  try{catalog=JSON.parse(await fs.readFile(new URL('catalog.json',folder)));}catch(e){if(e.code==='ENOENT'){t.skip('Private collection is not distributed with the repository');return;}throw e;}
  const manifest=JSON.parse(await fs.readFile(new URL('manifest.json',folder)));
  assert.equal(catalog.items.length,701);assert.equal(new Set(catalog.items.map(v=>v.id)).size,701);assert.equal(Object.keys(manifest.files).length,701);
  for(const item of catalog.items){assert.ok(item.composer&&item.style&&item.era);assert.ok(manifest.files[item.id].startsWith('曲谱/'));assert.equal((await fs.stat(path.join(fileURLToPath(folder),manifest.files[item.id]))).size,item.bytes);assert.ok(!('absolute'in item));}
  const works=groupWorks(catalog.items);assert.ok(works.some(w=>w.browseGroup==='原神'));assert.ok(works.some(w=>w.browseGroup==='Animenz'));assert.ok(works.some(w=>w.browseGroup==='流行音乐'));assert.ok(works.some(w=>w.genre==='练习曲'));
  assert.equal(JSON.parse(await fs.readFile(new URL('../docs/library/catalog.json',import.meta.url))).items.length,10);
});
test('local server serves only registered PDFs and metadata, with byte ranges and no private index access',async t=>{
  const library=path.resolve(import.meta.dirname,'../.local-library');try{await fs.access(library+'/manifest.json');}catch{t.skip('Private collection absent');return;}
  const server=await createPreviewServer({library});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}/volta/`,response=await fetch(base+'library/catalog.json'),catalog=await response.json();assert.equal(catalog.items.length,701);assert.match(response.headers.get('Cache-Control'),/private/);
    const first=catalog.items[0],pdf=await fetch(base+'scores/'+first.id+'.pdf',{headers:{Range:'bytes=0-4'}});assert.equal(pdf.status,206);assert.equal(await pdf.text(),'%PDF-');
    for(const route of ['manifest.json','merge-audit.json','.local-library/catalog.json','scores/nope.pdf','scores/'+('f'.repeat(64))+'.pdf'])assert.ok([403,404].includes((await fetch(base+route)).status));
    assert.equal((await fetch(base+'library/catalog.json',{headers:{Origin:'https://other.example'}})).status,403);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
