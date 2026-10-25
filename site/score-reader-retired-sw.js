// Retire the duplicate PDF reader without deleting annotations, PDFs or caches.
const root=new URL('./',self.location.href),editorEntry=new URL('../update.html',root);
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==root.origin||!url.pathname.startsWith(root.pathname))return;
  if(request.mode==='navigate'){event.respondWith(Promise.resolve(Response.redirect(editorEntry.href,302)));return;}
  // Already-open reading tabs can finish using their saved program/PDF bodies.
  event.respondWith((async()=>await caches.match(request)||fetch(request))());
});
