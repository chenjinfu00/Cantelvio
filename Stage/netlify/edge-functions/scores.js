import {getStore} from '@netlify/blobs';
import {json,sessionFor} from '../lib/security.js';
import {parseRange} from '../../docs/offline-range.js';
export default async request=>{
  if(!['GET','HEAD'].includes(request.method))return json({error:'Method not allowed'},405);
  if(!await sessionFor(request,getStore('volta-devices',{consistency:'strong'})))return json({error:'请先登录。'},401);
  const path=new URL(request.url).pathname,store=getStore('volta-files');
  if(path==='/volta/library/catalog.json'){
    const data=await store.get('catalog',{type:'json'});return data?json(data):json({error:'曲谱尚未上传完成。'},503);
  }
  const fit=/^\/volta\/fit\/([a-f0-9]{64})\.json$/.exec(path);
  if(fit){const data=await store.get('fit-'+fit[1],{type:'json'});return data?json(data):json({error:'Not found'},404);}
  const match=/^\/volta\/scores\/([a-f0-9]{64})\.pdf$/.exec(path);if(!match)return json({error:'Not found'},404);
  const id=match[1],meta=await store.get(id,{type:'json'});if(!meta)return json({error:'Not found'},404);
  const requested=request.headers.get('Range'),range=requested?parseRange(requested,meta.bytes):{start:0,end:meta.bytes-1};
  if(!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${meta.bytes}`,'Cache-Control':'private, no-store'}});
  const headers={'Content-Type':'application/pdf','Content-Length':String(range.end-range.start+1),'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename="${id}.pdf"`};
  if(requested)headers['Content-Range']=`bytes ${range.start}-${range.end}/${meta.bytes}`;
  if(request.method==='HEAD')return new Response(null,{status:requested?206:200,headers});
  let index=Math.floor(range.start/meta.chunkSize),cancelled=false;
  const stream=new ReadableStream({async pull(controller){
    if(cancelled)return;
    try{
      const bytes=await getStore('volta-pdf-chunks').get(id+'-'+index,{type:'arrayBuffer'});if(!bytes)throw Error('Missing chunk');
      const offset=index*meta.chunkSize,chunk=new Uint8Array(bytes).subarray(Math.max(0,range.start-offset),Math.min(bytes.byteLength,range.end-offset+1));
      if(cancelled)return;controller.enqueue(chunk);index++;
      if(index*meta.chunkSize>range.end)controller.close();
    }catch(error){if(!cancelled)controller.error(error);}
  },cancel(){cancelled=true;}});
  return new Response(stream,{status:requested?206:200,headers});
};
export const config={path:['/volta/scores/*','/volta/fit/*','/volta/library/catalog.json']};
