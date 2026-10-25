import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../score-reader-retired-sw.js',import.meta.url),'utf8');
const root=new URL('https://example.test/Cantelvio/score/library/');
const update=new URL('../update.html',root).href;

function worker(){
  const handlers=new Map(),saved=new Map(),network=[],reads=[],effects=[];
  const clients={
    async claim(){effects.push('claim');},
    matchAll(){assert.fail('Retirement must not navigate existing annotation clients');},
    openWindow(){assert.fail('Retirement must not open or navigate another client');},
  };
  const read=async request=>{const url=typeof request==='string'?request:request.url;reads.push(url);return saved.get(url);};
  const cache={match:read,delete(){assert.fail('Cached user data must not be deleted');},put(){assert.fail('Retirement must not rewrite cached user data');}};
  const context={URL,Response,Request,
    self:{location:{href:new URL('sw.js?version=retired',root).href},clients,async skipWaiting(){effects.push('skipWaiting');},addEventListener:(name,handler)=>handlers.set(name,handler)},
    clients,
    caches:{match:read,async open(){return cache;},delete(){assert.fail('CacheStorage must remain intact');}},
    fetch:async request=>{const url=typeof request==='string'?request:request.url;network.push(url);return new Response('network:'+url);},
  };
  for(const name of ['indexedDB','localStorage'])Object.defineProperty(context,name,{get(){assert.fail('Retirement must not access '+name);}});
  vm.runInNewContext(source,context,{filename:'score-reader-retired-sw.js'});
  async function lifecycle(type){
    const promises=[];assert.ok(handlers.has(type),type+' handler is installed');
    handlers.get(type)({waitUntil:promise=>promises.push(Promise.resolve(promise))});
    assert.ok(promises.length,type+' waits for its lifecycle effect');await Promise.all(promises);
  }
  async function request(path,{mode='same-origin',method='GET'}={}){
    let response=null,intercepted=false;
    const url=new URL(path,root).href;
    handlers.get('fetch')({request:{url,mode,method},respondWith:promise=>{assert.equal(intercepted,false);intercepted=true;response=Promise.resolve(promise);}});
    return {intercepted,response:response?await response:null};
  }
  return {handlers,saved,network,reads,effects,lifecycle,request};
}

test('the retired worker installs immediately and claims scope without removing stored data',async()=>{
  const state=worker();
  await state.lifecycle('install');await state.lifecycle('activate');
  assert.deepEqual(state.effects,['skipWaiting','claim']);
  assert.equal(state.network.length,0);assert.equal(state.reads.length,0);
});

test('legacy reader navigations redirect outside its worker scope to the editor compatibility entry',async()=>{
  const state=worker();
  for(const path of ['./?library=1','index.html?release=old','nested/old.html']){
    const result=await state.request(path,{mode:'navigate'});
    assert.equal(result.intercepted,true);assert.equal(result.response.status,302);
    assert.equal(result.response.headers.get('location'),update);
    assert.ok(!new URL(update).pathname.startsWith(root.pathname));
  }
  assert.equal(state.network.length,0);assert.equal(state.reads.length,0);
});

test('cached PDFs and program resources remain readable while old pages finish their work',async()=>{
  const state=worker();
  for(const path of ['offline-score/'+'a'.repeat(64)+'.pdf','app.js','vendor/pdf.worker.mjs']){
    const url=new URL(path,root).href;state.saved.set(url,new Response('kept:'+path));
    const result=await state.request(path);
    assert.equal(result.intercepted,true);assert.equal(await result.response.text(),'kept:'+path);
    assert.ok(state.saved.has(url));
  }
  assert.equal(state.network.length,0);
});

test('an uncached reader subresource falls back to the network without caching or deleting it',async()=>{
  const state=worker(),path='missing.css';
  const result=await state.request(path);
  assert.equal(result.intercepted,true);assert.equal(await result.response.text(),'network:'+new URL(path,root).href);
  assert.deepEqual(state.network,[new URL(path,root).href]);assert.equal(state.saved.size,0);
});

test('non-GET, cross-origin and outside-scope requests are left alone',async()=>{
  const state=worker();
  for(const [path,options] of [
    ['app.js',{method:'POST'}],
    ['app.js',{method:'HEAD'}],
    ['https://other.test/Cantelvio/score/library/index.html',{mode:'navigate'}],
    ['https://example.test/Cantelvio/stage/?library=1',{mode:'navigate'}],
    ['https://example.test/Cantelvio/score/',{mode:'navigate'}],
    ['https://example.test/Cantelvio/score/library-old/index.html',{mode:'navigate'}],
  ])assert.equal((await state.request(path,options)).intercepted,false,path);
  assert.equal(state.network.length,0);assert.equal(state.reads.length,0);
});
