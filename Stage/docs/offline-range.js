export function parseRange(header,size){
  const match=/^bytes=(\d*)-(\d*)$/.exec(header||'');if(!match||(!match[1]&&!match[2]))return null;
  let start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  let end=match[1]?(match[2]?Number(match[2]):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return null;
  return {start,end:Math.min(end,size-1)};
}
export async function cachedPDFResponse(response,request){
  if(!request.headers.has('range'))return response;
  const blob=await response.blob(),range=parseRange(request.headers.get('range'),blob.size);
  if(!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${blob.size}`}});
  const {start,end}=range;return new Response(blob.slice(start,end+1),{status:206,headers:{'Content-Type':'application/pdf','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${blob.size}`,'Content-Length':String(end-start+1)}});
}
