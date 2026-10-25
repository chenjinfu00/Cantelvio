import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshReader} from '../score-update.mjs';

const readerRoot=new URL('https://example.test/Cantelvio/score/library/');
const expectedVersion='reader-current';
const required=['./index.html','./app.js','./library.js','./reader-start.js','./style.css','./reader.css','./offline.js'];
const extra=['./vendor/pdf.mjs','./touch-select.js','./library-ui.css','./manifest.webmanifest','./appearance/core.mjs','./public-settings.json'];
const skipped=['./version-update.pdf','./vendor/cmaps/78-H.bcmap','./vendor/standard_fonts/FoxitSans.pfb','./vendor/piano/C4.mp3','./icon.svg'];
const shell=[...required,...extra,...skipped];
const assetURL=relative=>new URL(relative,readerRoot).href;

function downloads({manifest=shell,httpFailure=null,bodyFailure=null}={}){
  const calls=[],drained=new Set();
  const fetcher=async(input,options={})=>{
    const url=new URL(String(input),readerRoot),relative='./'+url.pathname.slice(readerRoot.pathname.length);
    calls.push({url:url.href,options});
    const ok=relative!==httpFailure;
    return {
      ok,status:ok?200:503,
      json:async()=>structuredClone(manifest),
      async arrayBuffer(){
        await Promise.resolve();
        if(relative===bodyFailure)throw new Error('Download interrupted');
        drained.add(url.href);return new ArrayBuffer(1);
      },
    };
  };
  return {fetcher,calls,drained};
}

function registrations({current=false,race=false,beforeUnregister=()=>{}}={}){
  let removed=false;
  const unregistered=[];
  const unrelated=[
    {scope:'https://example.test/Cantelvio/stage/',active:{scriptURL:'https://example.test/Cantelvio/stage/sw.js?version='+expectedVersion}},
    {scope:readerRoot.href+'nested/',active:{scriptURL:readerRoot.href+'nested/sw.js'}},
  ];
  for(const registration of unrelated)registration.unregister=async()=>assert.fail('An unrelated registration must remain intact');
  const exact={scope:readerRoot.href,active:{scriptURL:readerRoot.href+'sw.js?version='+(current?expectedVersion:'reader-old')},async unregister(){
    beforeUnregister();unregistered.push(this.scope);removed=true;return true;
  }};
  const serviceWorker={controller:null,async getRegistrations(){return !removed||race?[exact,...unrelated]:[...unrelated];}};
  return {serviceWorker,exact,unrelated,unregistered};
}

function assertDestination(destination){
  const url=new URL(destination);
  assert.equal(url.origin,readerRoot.origin);assert.equal(url.pathname,readerRoot.pathname);
  assert.equal(url.searchParams.get('library'),'1');assert.equal(url.searchParams.get('updated'),expectedVersion);
}

test('an outside-scope page warms and drains public code before unregistering only the reader',async()=>{
  const source=downloads(),wanted=[...required,...extra].map(assetURL);
  const state=registrations({beforeUnregister(){
    assert.deepEqual([...source.drained].sort(),[...wanted].sort(),'every successful response body is consumed before unregister');
  }});
  const result=await refreshReader({readerRoot,expectedVersion,fetcher:source.fetcher,serviceWorker:state.serviceWorker,onProgress(){}});
  assert.equal(result.refreshed,true);assert.equal(result.assets,wanted.length);assertDestination(result.destination);
  assert.deepEqual(state.unregistered,[readerRoot.href]);
  assert.deepEqual(await state.serviceWorker.getRegistrations(),state.unrelated);
  assert.deepEqual(source.calls.map(call=>call.url).sort(),[assetURL('./cache-manifest.json'),...wanted].sort());
  for(const call of source.calls)assert.equal(call.options.cache,'reload');
});

test('a controlled updater refuses to reset or download anything',async()=>{
  const state=registrations(),source=downloads();state.serviceWorker.controller={scriptURL:readerRoot.href+'sw.js'};
  await assert.rejects(refreshReader({readerRoot:readerRoot.href,expectedVersion,fetcher:source.fetcher,serviceWorker:state.serviceWorker}));
  assert.equal(source.calls.length,0);assert.equal(state.unregistered.length,0);
});

test('an exact reader already on the requested version skips warming and unregistering',async()=>{
  const state=registrations({current:true}),source=downloads();
  const result=await refreshReader({readerRoot:readerRoot.href,expectedVersion,fetcher:source.fetcher,serviceWorker:state.serviceWorker});
  assert.equal(result.refreshed,false);assert.equal(result.assets,0);assertDestination(result.destination);
  assert.equal(source.calls.length,0);assert.equal(state.unregistered.length,0);
});

test('unsafe manifest entries never cause a reader reset or an outside fetch',async t=>{
  for(const unsafe of ['https://other.test/app.js','../stage/app.js','./%2e%2e/outside.js','/Cantelvio/score/library-evil/app.js','javascript:alert(1)']){
    await t.test(unsafe,async()=>{
      const source=downloads({manifest:[...required,unsafe]}),state=registrations();
      await assert.rejects(refreshReader({readerRoot:readerRoot.href,expectedVersion,fetcher:source.fetcher,serviceWorker:state.serviceWorker}));
      assert.equal(state.unregistered.length,0);
      for(const call of source.calls)assert.ok(call.url.startsWith(readerRoot.href),'no unsafe URL reaches fetch');
    });
  }
});

test('a manifest missing any required entry cannot reset the reader',async t=>{
  for(const missing of required)await t.test(missing,async()=>{
    const source=downloads({manifest:required.filter(asset=>asset!==missing)}),state=registrations();
    await assert.rejects(refreshReader({readerRoot,expectedVersion,fetcher:source.fetcher,serviceWorker:state.serviceWorker}));
    assert.equal(state.unregistered.length,0);
  });
});

test('HTTP failures and interrupted bodies leave the working registration in place',async t=>{
  for(const failure of [{httpFailure:'./cache-manifest.json'},{httpFailure:'./library.js'},{bodyFailure:'./app.js'}]){
    await t.test(JSON.stringify(failure),async()=>{
      const source=downloads(failure),state=registrations();
      await assert.rejects(refreshReader({readerRoot,expectedVersion,fetcher:source.fetcher,serviceWorker:state.serviceWorker}));
      assert.equal(state.unregistered.length,0);
    });
  }
});

test('a competing reader re-registration is detected before returning a destination',async()=>{
  const source=downloads(),state=registrations({race:true});
  await assert.rejects(refreshReader({readerRoot,expectedVersion,fetcher:source.fetcher,serviceWorker:state.serviceWorker}));
  assert.deepEqual(state.unregistered,[readerRoot.href]);
});

test('without service-worker support the updater still warms current code',async()=>{
  const source=downloads();
  const result=await refreshReader({readerRoot:readerRoot.href,expectedVersion,fetcher:source.fetcher});
  assert.equal(result.refreshed,true);assert.equal(result.assets,required.length+extra.length);assertDestination(result.destination);
  for(const path of [...required,...extra])assert.ok(source.drained.has(assetURL(path)));
  for(const path of skipped)assert.ok(!source.calls.some(call=>call.url===assetURL(path)));
});
