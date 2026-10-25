import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreScoreEditor} from '../score-update.mjs';

const readerRoot=new URL('https://example.test/Cantelvio/score/library/');
const destination=new URL('../',readerRoot).href;

function registrations({version='reader-current',race=false,refuse=false}={}){
  let removed=false;
  const unregistered=[];
  const unrelated=[
    {scope:'https://example.test/Cantelvio/stage/'},
    {scope:readerRoot.href+'nested/'},
    {scope:'https://example.test/Cantelvio/score/library-old/'},
  ];
  for(const registration of unrelated)registration.unregister=async()=>assert.fail('An unrelated registration must remain intact');
  const exact={scope:readerRoot.href,active:{scriptURL:readerRoot.href+'sw.js?version='+version},async unregister(){
    unregistered.push(this.scope);if(!refuse)removed=true;return !refuse;
  }};
  const serviceWorker={controller:null,async getRegistrations(){return !removed||race?[exact,...unrelated]:[...unrelated];}};
  return {serviceWorker,exact,unrelated,unregistered};
}

async function withoutDataAccess(run){
  const names=['fetch','caches','indexedDB','localStorage'];
  const originals=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
  try{
    for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,get(){assert.fail('Restoring the editor must not access '+name);}});
    return await run();
  }finally{
    for(const [name,descriptor] of originals)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
  }
}

test('restoring Score unregisters only the exact retired reader and returns the notation editor',async()=>{
  const state=registrations({version:'reader-old'});
  const result=await withoutDataAccess(()=>restoreScoreEditor({readerRoot,serviceWorker:state.serviceWorker}));
  assert.deepEqual(result,{destination,retired:1});
  assert.deepEqual(state.unregistered,[readerRoot.href]);
  assert.deepEqual(await state.serviceWorker.getRegistrations(),state.unrelated);
});

test('even an already current reader registration is retired instead of reopened',async()=>{
  const state=registrations();
  const result=await withoutDataAccess(()=>restoreScoreEditor({readerRoot:readerRoot.href,serviceWorker:state.serviceWorker}));
  assert.equal(result.retired,1);assert.equal(result.destination,destination);
  assert.deepEqual(state.unregistered,[readerRoot.href]);
});

test('a controlled compatibility page refuses to reset registrations',async()=>{
  const state=registrations();state.serviceWorker.controller={scriptURL:readerRoot.href+'sw.js'};
  await withoutDataAccess(()=>assert.rejects(restoreScoreEditor({readerRoot,serviceWorker:state.serviceWorker})));
  assert.equal(state.unregistered.length,0);
});

test('an absent reader registration leaves Stage and nested registrations untouched',async()=>{
  const state=registrations();
  state.serviceWorker.getRegistrations=async()=>[...state.unrelated];
  const result=await withoutDataAccess(()=>restoreScoreEditor({readerRoot,serviceWorker:state.serviceWorker}));
  assert.deepEqual(result,{destination,retired:0});assert.equal(state.unregistered.length,0);
});

test('without service-worker support the compatibility entry still opens the editor',async()=>{
  const result=await withoutDataAccess(()=>restoreScoreEditor({readerRoot:readerRoot.href}));
  assert.deepEqual(result,{destination,retired:0});
});

test('an unsuccessful unregister never returns a completed restoration',async()=>{
  const state=registrations({refuse:true});
  await withoutDataAccess(()=>assert.rejects(restoreScoreEditor({readerRoot,serviceWorker:state.serviceWorker})));
  assert.deepEqual(state.unregistered,[readerRoot.href]);
});

test('a competing re-registration is detected before returning the editor destination',async()=>{
  const state=registrations({race:true});
  await withoutDataAccess(()=>assert.rejects(restoreScoreEditor({readerRoot,serviceWorker:state.serviceWorker})));
  assert.deepEqual(state.unregistered,[readerRoot.href]);
});

test('reader roots require a trailing slash and cannot carry search or fragment state',async t=>{
  for(const invalid of [readerRoot.href.slice(0,-1),readerRoot.href+'?release=old',readerRoot.href+'#old']){
    await t.test(invalid,async()=>{
      const state=registrations();
      await withoutDataAccess(()=>assert.rejects(restoreScoreEditor({readerRoot:invalid,serviceWorker:state.serviceWorker})));
      assert.equal(state.unregistered.length,0);
    });
  }
});
