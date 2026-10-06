export function parseRange(header,size){
  const match=/^bytes=(\d*)-(\d*)$/.exec(header||'');if(!match||(!match[1]&&!match[2]))return null;
  let start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  let end=match[1]?(match[2]?Number(match[2]):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return null;
  return {start,end:Math.min(end,size-1)};
}
// A 100 MB score answers hundreds of range requests. Reading the whole body once per request is what
// runs an iPad out of memory, so each file's body is held as one Blob and only sliced after that.
const bodies=new Map(),MAX_BODIES=3;
export function forgetCachedBody(url){if(url)bodies.delete(url);else bodies.clear();}
export async function cachedBody(response,url,{store=bodies,limit=MAX_BODIES}={}){
  const declared=Number(response.headers.get('Content-Length'));
  // Only a body whose length we can check is worth holding on to; anything else is read fresh.
  const known=Number.isFinite(declared)&&declared>0;
  const held=known?store.get(url):null;
  if(held){const blob=await held;if(blob.size===declared)return blob;store.delete(url);}
  const pending=response.blob();
  if(!known)return pending;
  store.set(url,pending);
  for(const key of [...store.keys()].slice(0,Math.max(0,store.size-limit)))if(key!==url)store.delete(key);
  try{return await pending;}catch(error){store.delete(url);throw error;}
}
export async function cachedPDFResponse(response,request,options={}){
  if(!request.headers.has('range'))return response;
  const blob=await cachedBody(response,request.url,options),range=parseRange(request.headers.get('range'),blob.size);
  if(!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${blob.size}`}});
  const {start,end}=range;return new Response(blob.slice(start,end+1),{status:206,headers:{'Content-Type':'application/pdf','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${blob.size}`,'Content-Length':String(end-start+1)}});
}
