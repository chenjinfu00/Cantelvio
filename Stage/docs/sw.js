import {cachedPDFResponse,forgetCachedBody} from './offline-range.js';
const SHELL='volta-shell-20260916-midi-b',PDFS='volta-offline-pdfs-v1',METADATA='volta-offline-metadata-v1';
const root=new URL('./',self.location.href),STATE=new URL('./.shell-state',root).href,BATCH=8;

async function report(message){for(const client of await self.clients.matchAll({includeUncontrolled:true}))client.postMessage(message);}
async function shellFiles(cache){
  try{
    const response=await fetch(new URL('./cache-manifest.json',root),{cache:'reload'});
    if(!response.ok)throw new Error('App manifest unavailable');
    return (await response.json()).map(path=>new URL(path,root).href);
  }catch(error){
    // Offline, the last plan we saved is a better answer than none.
    const saved=await cache.match(STATE);if(!saved)throw error;
    return (await saved.json()).files||[];
  }
}
// Saving the shell one small batch at a time: a single missing asset no longer throws the whole app away.
async function primeShell({refresh=false}={}){
  const cache=await caches.open(SHELL),files=await shellFiles(cache);
  let done=0,failed=0;
  for(let index=0;index<files.length;index+=BATCH){
    await Promise.all(files.slice(index,index+BATCH).map(async href=>{
      try{
        if(!refresh&&await cache.match(href)){done++;return;}
        const response=await fetch(href,{cache:'reload'});if(!response.ok)throw new Error(String(response.status));
        await cache.put(href,response);done++;
      }catch{failed++;}
    }));
    await report({type:'volta:shell-progress',done,failed,total:files.length});
  }
  await cache.put(STATE,new Response(JSON.stringify({files,done,failed,at:Date.now()}),{headers:{'Content-Type':'application/json'}}));
  await report({type:'volta:shell-ready',done,failed,total:files.length});
  return {done,failed,total:files.length};
}
async function shellStatus(){
  const cache=await caches.open(SHELL);
  let files=[];try{files=await shellFiles(cache);}catch{}
  let done=0;for(const href of files)if(await cache.match(href))done++;
  await report({type:'volta:shell-ready',done,failed:files.length-done,total:files.length});
}
self.addEventListener('install',event=>event.waitUntil(primeShell().catch(()=>{})));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const name of await caches.keys())if(name.startsWith('volta-shell-')&&name!==SHELL)await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('message',event=>{
  const data=event.data||{};
  if(data.type==='volta:prime')event.waitUntil(primeShell({refresh:!!data.refresh}).catch(()=>report({type:'volta:shell-ready',done:0,failed:0,total:0,error:'离线应用未能完整保存，请联网后重试。'})));
  else if(data.type==='volta:shell-status')event.waitUntil(shellStatus());
  else if(data.type==='volta:forget')forgetCachedBody(data.url);
});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==root.origin||!url.pathname.startsWith(root.pathname))return;
  // Session, device list and annotations must never be answered from a cache.
  if(url.pathname.includes('/api/'))return;
  if(url.pathname.endsWith('/library/catalog.json')||url.pathname.includes('/fit/')){
    event.respondWith((async()=>{const cache=await caches.open(METADATA);try{const response=await fetch(request);if(response.ok)await cache.put(request.url,response.clone());return response;}catch(error){const saved=await cache.match(request.url);if(saved)return saved;throw error;}})());return;
  }
  if(url.pathname.endsWith('.pdf')){
    event.respondWith((async()=>{const saved=await (await caches.open(PDFS)).match(request.url);return saved?cachedPDFResponse(saved,request):fetch(request);})());return;
  }
  event.respondWith((async()=>{
    const cache=await caches.open(SHELL),key=request.mode==='navigate'?new URL('./index.html',root).href:request.url;
    return await cache.match(key)||fetch(request);
  })());
});
