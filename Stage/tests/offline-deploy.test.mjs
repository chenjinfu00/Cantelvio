import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {cachedBody,cachedPDFResponse,forgetCachedBody} from '../docs/offline-range.js';

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

test('deployment only saves the application shell, never a score plan',async()=>{
  const deploy=await fs.readFile(new URL('../docs/offline-deploy.js',import.meta.url),'utf8');
  assert.doesNotMatch(deploy,/deployPlan|matchScores|bufferFrom|saveOffline/);
  assert.match(deploy,/volta:prime/);
  const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="deploy-search"|id="deploy-list"|id="deploy-selection"/);
  assert.match(html,/id="deploy-summary"/);
});

test('the service worker saves the shell in batches and answers the page',async()=>{
  const sw=await fs.readFile(new URL('../docs/sw.js',import.meta.url),'utf8');
  assert.match(sw,/volta:prime/);
  assert.match(sw,/volta:shell-progress/);
  assert.match(sw,/volta:shell-status/);
  assert.doesNotMatch(sw,/cache\.addAll/,'one missing asset must not throw the whole shell away');
  assert.match(sw,/fetchShellAsset/,'a transient asset failure is retried before reporting the shell');
  assert.match(sw,/attempt<3/,'each shell asset gets bounded retries');
  assert.match(sw,/failedURLs/,'a persistent failure identifies the resource for diagnosis');
  assert.match(sw,/\.shell-state/,'the file list is kept for offline status');
  assert.match(sw,/volta-shell-20260917-0913-a/,'a published shell update gets a fresh cache');
  assert.match(sw,/skipWaiting/,'a new shell takes control without waiting for an old tab to close');
  const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.match(html,/id="offline-deploy"/);
  assert.match(html,/id="deploy-dialog"/);
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(app,/await requireCloudLogin/,'startup waits for nothing before opening the reader');
});

test('the local folder remains the only score source',async()=>{
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  assert.match(app,/if\(local\)return local\.sourceURL/,'MIDI reads from the selected folder');
  const library=await fs.readFile(new URL('../docs/library.js',import.meta.url),'utf8');
  assert.match(library,/path:localSource\?\.path/,'history stores a relative folder path');
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
  const preferences=await fs.readFile(new URL('version-preferences.js',docs),'utf8');
  assert.doesNotMatch(preferences,/fetcher\(|\/api\//,'version choices stay on this device');
});
