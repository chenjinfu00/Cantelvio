import {sha256} from './vendor/sha256.js';
// Only bounded network chunks enter JavaScript memory, even for large editions.
// A failed/interrupted download never replaces an already usable offline PDF.
export async function downloadVerifiedPDF(cache,pending,url,{id,progress=()=>{},fetcher=fetch}={}){
  const response=await fetcher(url,{cache:'no-store',signal:AbortSignal.timeout(180000)});
  if(!response.ok||response.status===206||!response.body)throw Error('未能完整下载，请联网重试。');
  const total=Number(response.headers.get('Content-Length')),hash=sha256.create();let loaded=0,yieldAt=performance.now();
  const body=response.body.pipeThrough(new TransformStream({
    async transform(chunk,controller){
      for(let offset=0;offset<chunk.byteLength;offset+=262144){
        hash.update(chunk.subarray(offset,offset+262144));
        if(performance.now()-yieldAt>12){await new Promise(resolve=>setTimeout(resolve,0));yieldAt=performance.now();}
      }
      loaded+=chunk.byteLength;progress(total?`正在下载 ${Math.min(99,Math.round(loaded/total*100))}%`:`已下载 ${(loaded/1048576).toFixed(1)} MB`);controller.enqueue(chunk);
    },
    flush(){
      if(total&&loaded!==total)throw Error('下载不完整，未标记为离线可用。');
      const actual=Array.from(hash.digest(),b=>b.toString(16).padStart(2,'0')).join('');
      if(actual!==id)throw Error('文件校验未通过，请重新下载。');
    }
  }));
  try{
    await cache.put(pending,new Response(body,{headers:response.headers}));
    progress('校验通过，正在保存…');
    await cache.put(url,await cache.match(pending));
    return loaded;
  }finally{hash.destroy();await cache.delete(pending);}
}
