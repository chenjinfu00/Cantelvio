export const COOKIE='__Host-volta-device';
export const SESSION_AGE=365*24*60*60*1000;
export const json=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...extra}});
export const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export const hash=async value=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
export function deviceCookie(request){
  const value=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  return /^[a-f0-9]{64}$/.test(value||'')?value:null;
}
export async function sessionFor(request,store,now=Date.now()){
  const token=deviceCookie(request);if(!token)return null;
  const id=await hash(token),session=await store.get(id,{type:'json',consistency:'strong'});
  return session&&!session.revoked&&session.expiresAt>now?{...session,id}:null;
}
export function requireSameOrigin(request){
  return request.headers.get('origin')===new URL(request.url).origin&&request.headers.get('content-type')?.split(';')[0]==='application/json';
}
export async function verifyPassword(password,verifier){
  if(typeof password!=='string'||password.length<12||password.length>256)return false;
  const [kind,rounds,salt,digest]=String(verifier||'').split('$');
  if(kind!=='pbkdf2'||Number(rounds)<310000||Number(rounds)>1000000||!/^([a-f0-9]{2}){16,32}$/.test(salt)||!/^[a-f0-9]{64}$/.test(digest))return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const actual=hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Uint8Array.from(salt.match(/../g),v=>parseInt(v,16)),iterations:Number(rounds)},key,256));
  let mismatch=0;for(let i=0;i<64;i++)mismatch|=actual.charCodeAt(i)^digest.charCodeAt(i);return mismatch===0;
}
export async function boundedJSON(request,limit=2_000_000){
  if(Number(request.headers.get('Content-Length'))>limit)throw new Error('Too large');
  const reader=request.body?.getReader();if(!reader)throw new Error('Empty');
  const chunks=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw new Error('Too large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(await new Blob(chunks).text());
}
