import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/tonnetz/sw.js',import.meta.url),'utf8');
function worker(path,{names=[],entries=new Map()}={}){
  const root=new URL(path,'https://example.test'),handlers={},deleted=[],opened=[];
  let claims=0;
  const cache={match:async key=>entries.get(String(key))};
  const context=vm.createContext({URL,Response,self:{
    location:{href:new URL('sw.js',root).href},registration:{scope:root.href},
    addEventListener:(name,handler)=>handlers[name]=handler,
    clients:{claim(){claims++;}},
  },caches:{
    keys:async()=>names,delete:async name=>{deleted.push(name);return true;},
    open:async name=>{opened.push(name);return cache;},
  },fetch:async()=>{throw new Error('offline');}});
  vm.runInContext(source,context);
  const {prefix,name}=vm.runInContext('({prefix:CACHE_PREFIX,name:CACHE_NAME})',context);
  return {root,handlers,deleted,opened,prefix,name,get claims(){return claims;}};
}

test('keyboard updates retire only the same installation cache and preserve legacy caches',async()=>{
  const other=worker('/old-demo/tonnetz/'),current=worker('/Cantelvio/harmony/');
  const old=current.prefix+'previous';
  const subject=worker('/Cantelvio/harmony/',{names:[old,current.name,other.name,'tonnetz-v38-melodic-phrases']});
  let completion;subject.handlers.activate({waitUntil:value=>completion=value});await completion;
  assert.deepEqual(subject.deleted,[old]);assert.equal(subject.claims,1);
  assert.notEqual(subject.name,other.name);
});

test('offline navigation uses the installation shell and ignores other module paths',async()=>{
  const root='https://example.test/Cantelvio/harmony/';
  const subject=worker('/Cantelvio/harmony/',{entries:new Map([[root+'index.html',new Response('keyboard shell')]])});
  let response;
  subject.handlers.fetch({request:{method:'GET',url:root+'offline-route/',mode:'navigate'},respondWith:value=>response=value});
  assert.equal(await (await response).text(),'keyboard shell');
  assert.deepEqual(subject.opened,[subject.name]);
  subject.handlers.fetch({request:{method:'GET',url:'https://example.test/Cantelvio/stage/',mode:'navigate'},respondWith:()=>assert.fail('another module is outside the keyboard scope')});
});
