import {getStore} from '@netlify/blobs';
import {json,sessionFor,requireSameOrigin,boundedJSON} from '../lib/security.js';
import {validateInk} from '../lib/notes.js';
export default async request=>{
  const session=await sessionFor(request,getStore('volta-devices',{consistency:'strong'}));
  if(!session)return json({error:'请先登录。'},401);
  const notes=getStore('volta-notes',{consistency:'strong'}),path=new URL(request.url).pathname;
  if(path==='/volta/api/notes'&&request.method==='GET'){
    const keys=[];for await(const page of notes.list({paginate:true}))for(const blob of page.blobs)keys.push(blob.key);
    return json({keys});
  }
  const match=/^\/volta\/api\/notes\/([a-f0-9]{64})\/([1-9][0-9]{0,4})$/.exec(path);if(!match)return json({error:'Invalid page'},400);
  const key=match[1]+'/'+match[2];
  if(request.method==='GET'){const item=await notes.getWithMetadata(key,{type:'json'});return json(item?.data||{version:1,strokes:[]},200,{ETag:item?.etag||'new'});}
  if(request.method!=='PUT'||!requireSameOrigin(request))return json({error:'Invalid request'},403);
  try{
    const value=await boundedJSON(request);if(!validateInk(value))return json({error:'Invalid annotations'},400);
    const expected=request.headers.get('If-Match');if(!expected)return json({error:'Revision required'},428);
    const written=await notes.setJSON(key,value,{...(expected==='new'?{onlyIfNew:true}:{onlyIfMatch:expected}),metadata:{updatedAt:Date.now(),device:session.id}});
    return written.modified?json({ok:true},200,{ETag:written.etag}):json({error:'批注已更新，请合并后重试。'},409);
  }catch{return json({error:'批注保存失败或内容过大。'},400);}
};
export const config={path:['/volta/api/notes','/volta/api/notes/*']};
