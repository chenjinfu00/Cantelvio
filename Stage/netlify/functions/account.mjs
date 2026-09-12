import {getStore} from '@netlify/blobs';
import {COOKIE,json,sessionFor,requireSameOrigin,boundedJSON} from '../lib/security.js';
export default async request=>{
  const devices=getStore('volta-devices',{consistency:'strong'}),session=await sessionFor(request,devices);
  if(!session)return json({error:'请先登录。'},401);
  const path=new URL(request.url).pathname;
  if(request.method==='GET'&&path.endsWith('/session'))return json({device:session});
  if(request.method==='GET'&&path.endsWith('/devices')){
    const result=[];for await(const page of devices.list({paginate:true}))for(const blob of page.blobs){const item=await devices.get(blob.key,{type:'json'});if(item&&!item.revoked&&item.expiresAt>Date.now())result.push({...item,id:blob.key,current:blob.key===session.id});}
    return json({devices:result});
  }
  if(request.method!=='POST'||!requireSameOrigin(request))return json({error:'Invalid request'},403);
  if(path.endsWith('/logout'))return json({ok:true},200,{'Set-Cookie':`${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`});
  if(path.endsWith('/devices/revoke')){
    const body=await boundedJSON(request,1024);if(!/^[a-f0-9]{64}$/.test(body.id||''))return json({error:'Invalid device'},400);
    const existing=await devices.get(body.id,{type:'json'});if(!existing)return json({error:'Device not found'},404);
    await devices.setJSON(body.id,{...existing,revoked:true,revokedAt:Date.now()});return json({ok:true});
  }
  return json({error:'Not found'},404);
};
export const config={path:['/volta/api/session','/volta/api/devices','/volta/api/devices/revoke','/volta/api/logout']};
