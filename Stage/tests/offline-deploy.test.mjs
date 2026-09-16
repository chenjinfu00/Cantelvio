import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {cachedBody,cachedPDFResponse,forgetCachedBody} from '../docs/offline-range.js';
import {deployPlan,matchScores} from '../docs/offline-deploy.js';

test('a cached score is read into memory once, not once per range request',async()=>{
  const body=new Uint8Array(1000).fill(7);
  let reads=0;
  const response=()=>{const r=new Response(body,{headers:{'Content-Length':String(body.length),'Content-Type':'application/pdf'}});
    const blob=r.blob.bind(r);r.blob=()=>{reads++;return blob();};return r;};
  const store=new Map();
  const first=await cachedBody(response(),'https://test/big.pdf',{store});
  const second=await cachedBody(response(),'https://test/big.pdf',{store});
  assert.equal(reads,1,'the second range reuses the held body');
  assert.equal(first.size,1000);assert.equal(second.size,1000);
  // A replaced file is never served from the old body.
  const shorter=new Response(new Uint8Array(10),{headers:{'Content-Length':'10'}});
  assert.equal((await cachedBody(shorter,'https://test/big.pdf',{store})).size,10);
  // Bodies without a declared length are read fresh, so nothing stale can be served.
  const plain=await cachedPDFResponse(new Response('0123456789'),new Request('https://test/x.pdf',{headers:{Range:'bytes=2-5'}}),{store});
  assert.equal(await plain.text(),'2345');
  assert.equal((await cachedPDFResponse(new Response('abc'),new Request('https://test/x.pdf',{headers:{Range:'bytes=9-'}}),{store})).status,416);
  forgetCachedBody();
});

test('a deployment says what it will cost before it starts',()=>{
  const items=[{id:'a',title:'甲',bytes:1048576,format:'pdf'},{id:'b',title:'乙',bytes:2097152,format:'pdf'}];
  assert.deepEqual(deployPlan(items,[]),{count:0,bytes:0,items:[]});
  const plan=deployPlan(items,['a','b','missing']);
  assert.equal(plan.count,2);assert.equal(plan.bytes,3145728);
  assert.equal(deployPlan(items,['b']).items[0].title,'乙');
});

test('the picker searches titles and hides unavailable or non-PDF entries',()=>{
  const items=[
    {id:'a',title:'肖邦 - 夜曲 Op.9 No.2',composer:'弗雷德里克·肖邦',format:'pdf'},
    {id:'b',title:'原神 - 璃月',composer:'原神',format:'pdf'},
    {id:'c',title:'未上传',format:'pdf',available:false},
    {id:'d',title:'音频',format:'mp3'},
  ];
  assert.deepEqual(matchScores(items,'').shown.map(i=>i.id),['a','b']);
  assert.deepEqual(matchScores(items,'夜曲').shown.map(i=>i.id),['a']);
  assert.deepEqual(matchScores(items,'肖邦 op.9').shown.map(i=>i.id),['a'],'all words must match');
  assert.deepEqual(matchScores(items,'找不到').shown,[]);
  const many=Array.from({length:100},(_,i)=>({id:'s'+i,title:'第 '+i+' 份',format:'pdf'}));
  const limited=matchScores(many,'',20);
  assert.equal(limited.total,100);assert.equal(limited.shown.length,20);
});

test('the service worker saves the shell in batches and answers the page',async()=>{
  const sw=await fs.readFile(new URL('../docs/sw.js',import.meta.url),'utf8');
  assert.match(sw,/volta:prime/);
  assert.match(sw,/volta:shell-progress/);
  assert.match(sw,/volta:shell-status/);
  assert.doesNotMatch(sw,/cache\.addAll/,'one missing asset must not throw the whole shell away');
  assert.match(sw,/\.shell-state/,'the file list is kept for offline status');
  assert.match(sw,/volta-shell-20260916-start-b/,'a published shell update gets a fresh cache');
  const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.match(html,/id="offline-deploy"/);
  assert.match(html,/id="deploy-dialog"/);
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(app,/await requireCloudLogin/,'startup waits for nothing before opening the reader');
});

test('a chosen folder is what gets saved for offline use, with no server in the picture',async()=>{
  const {loadCatalog,bufferFrom}=await import('../docs/offline-deploy.js');
  const local={catalog:{items:[{id:'a',title:'甲'},{id:'b',title:'乙'}]},url:id=>id==='a'?'blob:fake-a':null};
  assert.deepEqual((await loadCatalog(local)).map(item=>item.id),['a','b'],'the folder answers instead of the network');
  assert.equal(await bufferFrom(local,'b'),null,'a score the folder does not hold is not invented');
  assert.equal(await bufferFrom(null,'a'),null);
  const deploy=await fs.readFile(new URL('../docs/offline-deploy.js',import.meta.url),'utf8');
  assert.match(deploy,/saveOffline\(\{id:item\.id,name:item\.title,buffer\}/,'folder bytes are saved directly, never downloaded');
  assert.doesNotMatch(deploy,/scoreURL/,'there is no server address left to fall back to');
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  assert.match(app,/local:\(\)=>library\?\.local/,'the dialog is told which folder is open');
});

test('the published page is the app, with no server left to talk to',async()=>{
  const docs=new URL('../docs/',import.meta.url);
  for(const gone of ['cloud-account.js','cloud-sync.js','site-config.js'])
    await assert.rejects(fs.access(new URL(gone,docs)),'the server-era module '+gone+' is gone');
  const html=await fs.readFile(new URL('index.html',docs),'utf8');
  assert.doesNotMatch(html,/cloud-login|cloud-password|受信任设备/,'nothing asks for a password any more');
  for(const name of ['app.js','library.js','offline-deploy.js','ink.js','version-preferences.js']){
    const source=await fs.readFile(new URL(name,docs),'utf8');
    assert.doesNotMatch(source,/PUBLIC_LIBRARY|CLOUD_LIBRARY|CLOUD_HOME/,name+' still branches on a server mode');
  }
  const library=await fs.readFile(new URL('library.js',docs),'utf8');
  assert.doesNotMatch(library,/fetch\(/,'the shelf makes no request at all');
});
