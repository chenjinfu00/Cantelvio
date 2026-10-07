import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=(await readFile(new URL('../docs/sw.js',import.meta.url),'utf8')).replace(/^import .+;\n/,'');
function worker(path,{names=[],clients=[]}={}){
  const root=new URL(path,'https://example.test'),handlers={},deleted=[];
  let claims=0;
  const cache={match:async()=>null};
  const context=vm.createContext({URL,Response,self:{
    location:{href:new URL('sw.js',root).href},addEventListener:(name,handler)=>handlers[name]=handler,
    clients:{matchAll:async()=>clients,claim(){claims++;}},
  },caches:{keys:async()=>names,delete:async name=>{deleted.push(name);return true;},open:async()=>cache},
  fetch:async()=>new Response('[]',{headers:{'Content-Type':'application/json'}})});
  vm.runInContext(source,context);
  const {prefix,name}=vm.runInContext('({prefix:SHELL_PREFIX,name:SHELL})',context);
  return {root,handlers,deleted,prefix,name,get claims(){return claims;}};
}

test('reader updates preserve legacy readers, other installations and offline PDFs',async()=>{
  const other=worker('/volta/'),current=worker('/Cantelvio/stage/'),old=current.prefix+'previous';
  const subject=worker('/Cantelvio/stage/',{names:[old,current.name,other.name,'volta-shell-20260928-auto-turn-1','volta-offline-pdfs-v1']});
  let completion;subject.handlers.activate({waitUntil:value=>completion=value});await completion;
  assert.deepEqual(subject.deleted,[old]);assert.equal(subject.claims,1);
  assert.notEqual(subject.name,other.name);
});

test('reader shell status only reaches pages inside this installation scope',async()=>{
  const paths=['/Cantelvio/stage/','/Cantelvio/stage/index.html','/volta/','/Cantelvio/stage-copy/'];
  const messages=paths.map(()=>[]);
  const clients=paths.map((path,index)=>({url:new URL(path,'https://example.test').href,postMessage:value=>messages[index].push(value)}));
  const foreign=[];clients.push({url:'https://other.test/Cantelvio/stage/',postMessage:value=>foreign.push(value)});
  const subject=worker('/Cantelvio/stage/',{clients});
  let completion;subject.handlers.message({data:{type:'volta:shell-status'},waitUntil:value=>completion=value});await completion;
  assert.deepEqual(messages.map(list=>list.length),[1,1,0,0]);assert.deepEqual(foreign,[]);
  for(const list of messages.slice(0,2)){
    assert.equal(list[0].type,'volta:shell-ready');assert.equal(list[0].scope,subject.root.href);
  }
});

test('manual installation ignores status from another reader or a legacy worker',async()=>{
  const handlers=new Map();
  const navigator={serviceWorker:{
    addEventListener:(name,handler)=>handlers.set(name,handler),
    removeEventListener:name=>handlers.delete(name),
    register:async()=>({active:{postMessage(){}}}),
  }};
  const context=vm.createContext({URL,navigator,caches:{},isSecureContext:true,setTimeout:()=>1,clearTimeout(){}});
  const deploy=(await readFile(new URL('../docs/offline-deploy.js',import.meta.url),'utf8'))
    .replaceAll('export function ','function ').replaceAll('import.meta.url',JSON.stringify('https://example.test/Cantelvio/stage/offline-deploy.js'));
  vm.runInContext(deploy,context);
  let settled=false;
  const installation=vm.runInContext('installShell()',context).then(value=>{settled=true;return value;});
  const notify=handlers.get('message');
  notify({data:{type:'volta:shell-ready',scope:'https://example.test/volta/',done:10,failed:0,total:10}});
  notify({data:{type:'volta:shell-ready',done:10,failed:0,total:10}});
  await Promise.resolve();await Promise.resolve();
  assert.equal(settled,false);assert.equal(handlers.has('message'),true);
  notify({data:{type:'volta:shell-ready',scope:'https://example.test/Cantelvio/stage/',done:286,failed:0,total:286}});
  assert.equal((await installation).done,286);assert.equal(handlers.has('message'),false);
});
