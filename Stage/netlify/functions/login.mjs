import {getStore} from '@netlify/blobs';
import {COOKIE,SESSION_AGE,json,hex,hash,verifyPassword,requireSameOrigin,boundedJSON} from '../lib/security.js';
export default async request=>{
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(!requireSameOrigin(request))return json({error:'Invalid origin'},403);
  try{
    const body=await boundedJSON(request,2048);
    const config=await getStore('volta-auth-config',{consistency:'strong'}).get('password',{type:'json'});
    if(!config?.verifier)return json({error:'服务端密码配置尚未生效，请稍后重试。'},503);
    if(!await verifyPassword(body.password,config.verifier))return json({error:'密码不正确，请稍后重试。'},401);
    const token=hex(crypto.getRandomValues(new Uint8Array(32))),id=await hash(token),now=Date.now();
    const device={label:String(body.label||'我的设备').slice(0,80),createdAt:now,expiresAt:now+SESSION_AGE,revoked:false};
    await getStore('volta-devices',{consistency:'strong'}).setJSON(id,device,{onlyIfNew:true});
    return json({device:{...device,id}},200,{'Set-Cookie':`${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_AGE/1000}`});
  }catch{return json({error:'登录暂时不可用，请稍后重试。'},503);}
};
export const config={path:'/volta/api/login',rateLimit:{windowLimit:5,windowSize:60,aggregateBy:['ip','domain']}};
