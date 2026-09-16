import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {PageRenderCache,adjacentPages} from '../docs/page-cache.js';
import {readingGesture,TurnQueue} from '../docs/reader-shell.js';
import {normalizeSettings,defaults} from '../docs/settings.js';
import {parseRange,cachedPDFResponse} from '../docs/offline-range.js';
import {PerformanceMode,ManualTurnGuard,performanceKey} from '../docs/performance-mode.js';

test('left and right 40% turn; center reveals controls; edge swipes win over turns',()=>{
  const options={width:1000},tap=x=>readingGesture({x,y:400},{x:x+1,y:401},options);
  assert.equal(tap(100),'previous');assert.equal(tap(380),'previous');assert.equal(tap(500),'tools');assert.equal(tap(620),'next');assert.equal(tap(960),'next');
  assert.equal(readingGesture({x:500,y:20},{x:510,y:95},options),'tools');
  assert.equal(readingGesture({x:20,y:500},{x:110,y:510},options),'shelf');
  assert.equal(readingGesture({x:20,y:500},{x:110,y:510},{...options,performance:true}),'tools');
  assert.equal(readingGesture({x:800,y:300},{x:600,y:305},options),'next');
  assert.equal(readingGesture({x:800,y:300},{x:810,y:400},options),null);
  assert.equal(readingGesture({x:800,y:300},{x:800,y:300},{...options,tap:false}),null);
  assert.equal(readingGesture({x:500,y:300},{x:500,y:300},{...options,tap:false}),'tools');
  assert.equal(readingGesture({x:800,y:300},{x:600,y:305},{...options,canTurn:false}),null);
});

test('page cache coalesces, reuses and evicts within a bounded raster budget',async()=>{
  let renders=0;const disposed=[];const cache=new PageRenderCache(async page=>{renders++;return {page,pixels:10};},{maxEntries:3,maxPixels:30,dispose:v=>disposed.push(v.page)});
  const first=cache.get(1,{}),second=cache.get(1,{});assert.equal(first,second);await first;assert.equal(renders,1);
  cache.pin([cache.key(1,{})]);await cache.get(2,{});await cache.get(3,{});await cache.get(4,{});
  assert.deepEqual(disposed,[2]);assert.equal(cache.has(1,{}),true);assert.equal(cache.entries.size,3);
  await cache.get(1,{});assert.equal(renders,4);cache.clear();assert.equal(cache.entries.size,0);assert.equal(disposed.length,4);
});
test('new visible pages stay pinned until atomic replacement; cancelled work cannot reenter cache',async()=>{
  let resolve;const cache=new PageRenderCache(page=>page===2?new Promise(r=>resolve=()=>r({page,pixels:10})):Promise.resolve({page,pixels:10}),{maxEntries:1,maxPixels:10,dispose:()=>{}});
  await cache.get(1,{});cache.pin([cache.key(1,{}),cache.key(2,{})]);const loading=cache.get(2,{});await Promise.resolve();
  cache.prioritize([cache.key(1,{})]);resolve();await assert.rejects(loading,{name:'AbortError'});assert.equal(cache.has(1,{}),true);assert.equal(cache.has(2,{}),false);
  await cache.get(3,{});assert.equal(cache.has(1,{}),true);
});
test('next spread is warmed first; neighbors never cross document boundaries',()=>{
  assert.deepEqual(adjacentPages(1,2),[2]);assert.deepEqual(adjacentPages(1,8,true),[3,4]);assert.deepEqual(adjacentPages(8,8),[7]);
});
test('intentional taps accumulate during a slow render and can reverse direction',async()=>{
  let page=4,release;const targets=[];
  const queue=new TurnQueue({page:()=>page,total:()=>20,navigate:async target=>{targets.push(target);if(targets.length===1)await new Promise(r=>release=r);page=target;}});
  const done=queue.turn(1);await Promise.resolve();queue.turn(1);queue.turn(1);queue.turn(-1);release();await done;
  assert.equal(page,6);assert.deepEqual(targets,[5,6]);
  await queue.turn(-100);assert.equal(page,1);await queue.turn(100);assert.equal(page,20);
});
test('a failed turn queue recovers for the next tap',async()=>{
  let page=1,fail=true;const queue=new TurnQueue({page:()=>page,total:()=>4,navigate:async p=>{if(fail)throw Error('render failed');page=p;}});
  await assert.rejects(queue.turn(1));fail=false;await queue.turn(1);assert.equal(page,2);
});
test('default blue, responsive touch and five-page pre-read survive malformed settings',()=>{
  assert.deepEqual(normalizeSettings(null),defaults);assert.deepEqual(normalizeSettings({theme:'not-a-theme',tap:'false'}),defaults);
  assert.equal(normalizeSettings({theme:'jade',tap:false}).theme,'jade');assert.equal(normalizeSettings({tap:false}).tap,false);
});
test('cached PDF serves valid ranges, suffixes, open ends and 416 errors',async()=>{
  assert.deepEqual(parseRange('bytes=2-5',10),{start:2,end:5});assert.deepEqual(parseRange('bytes=-3',10),{start:7,end:9});assert.deepEqual(parseRange('bytes=8-',10),{start:8,end:9});
  for(const header of ['bytes=20-30','bytes=8-2','bytes=-0','bytes=1-2,4-5','bytes=-'])assert.equal(parseRange(header,10),null);
  const response=await cachedPDFResponse(new Response('0123456789'),new Request('https://test/score.pdf',{headers:{Range:'bytes=2-5'}}));assert.equal(response.status,206);assert.equal(await response.text(),'2345');assert.equal(response.headers.get('Content-Range'),'bytes 2-5/10');
  assert.equal((await cachedPDFResponse(new Response('abc'),new Request('https://test/score.pdf',{headers:{Range:'bytes=9-'}}))).status,416);
});
test('performance requests fullscreen within entry click; fallback and manual corrections remain safe',async()=>{
  const events=[];const mode=new PerformanceMode({activate:()=>events.push('activate'),fullscreen:()=>{events.push('fullscreen');return false;},render:async()=>events.push('render'),wakeLock:()=>null,deactivate:()=>events.push('deactivate'),exitFullscreen:()=>events.push('exitFullscreen')});
  const entering=mode.enter();assert.deepEqual(events,['activate','fullscreen','render']);await entering;assert.equal(mode.active,true);assert.equal(mode.native,false);await mode.exit();assert.equal(mode.active,false);
  let now=0;const guard=new ManualTurnGuard(()=>now);guard.manual();const revision=guard.revision;assert.equal(guard.permits(),false);now=2600;assert.equal(guard.permits(),true);guard.manual();now=5200;assert.equal(guard.permits(revision),false);
  assert.equal(performanceKey({key:'ArrowRight',repeat:true}),'ignore');
});
test('offline shell includes all local modules, the built-in update PDF and no score PDFs',async()=>{
  const root=new URL('../docs/',import.meta.url),manifest=JSON.parse(await fs.readFile(new URL('cache-manifest.json',root),'utf8'));
  for(const path of ['./index.html','./reader.css','./app.js','./reader-shell.js','./offline.js','./local-library.js','./vendor/pdf.worker.mjs'])assert.ok(manifest.includes(path),path);
  assert.ok(manifest.some(p=>p.includes('/cmaps/')));assert.ok(manifest.some(p=>p.includes('/wasm/')));
  for(const path of manifest){assert.ok(path.startsWith('./'));if(path.endsWith('.pdf'))assert.equal(path,'./version-update.pdf');await fs.access(new URL(path,root));}
  assert.doesNotMatch(await fs.readFile(new URL('style.css',root),'utf8'),/@import/);
});
test('service worker serves offline navigation and PDF ranges within /volta only',async()=>{
  const handlers={},saved=new Map(),cache={match:async key=>saved.get(typeof key==='string'?key:key.url)?.clone()};
  const context={self:{location:{href:'https://example.test/volta/sw.js'},addEventListener:(name,fn)=>handlers[name]=fn},URL,Response,Request,cachedPDFResponse,caches:{open:async()=>cache},fetch:async()=>new Response('network')};
  let source=await fs.readFile(new URL('../docs/sw.js',import.meta.url),'utf8');source=source.replace(/^import .+;\n/,'');vm.runInNewContext(source,context);
  saved.set('https://example.test/volta/index.html',new Response('offline shell'));saved.set('https://example.test/volta/scores/x.pdf',new Response('0123456789'));
  async function request(url,headers={},mode){let result;const request=new Request(url,{headers});if(mode)Object.defineProperty(request,'mode',{value:mode});handlers.fetch({request,respondWith:promise=>result=promise});return result;}
  assert.equal(await (await request('https://example.test/volta/?library=1',{},'navigate')).text(),'offline shell');
  assert.equal(await (await request('https://example.test/volta/scores/x.pdf',{Range:'bytes=4-6'})).text(),'456');
  assert.equal(await (await request('https://example.test/volta/scores/not-saved.pdf')).text(),'network');
  assert.equal(await request('https://example.test/personal/'),undefined);
});
