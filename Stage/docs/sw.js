import {cachedPDFResponse} from './offline-range.js';
const SHELL='volta-shell-20260915-reader-9a',PDFS='volta-offline-pdfs-v1',METADATA='volta-offline-metadata-v1';
const root=new URL('./',self.location.href);
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const response=await fetch(new URL('./cache-manifest.json',root),{cache:'reload'});if(!response.ok)throw new Error('App manifest unavailable');
  const files=await response.json(),cache=await caches.open(SHELL);
  try{await cache.addAll(files.map(path=>new Request(new URL(path,root),{cache:'reload'})));}catch(error){await caches.delete(SHELL);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const name of await caches.keys())if(name.startsWith('volta-shell-')&&name!==SHELL)await caches.delete(name);
  await self.clients.claim();
})()));
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
