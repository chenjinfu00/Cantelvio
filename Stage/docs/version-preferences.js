import {PUBLIC_LIBRARY} from './site-config.js';
async function address(workKey){
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(workKey));
  const id=[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return './api/preferences/versions/'+id;
}
export function versionPreferences(fetcher=fetch,{localOnly=PUBLIC_LIBRARY,storage}={}){
  return {
    async load(workKey){
      if(localOnly){try{return (storage||globalThis.localStorage).getItem('volta:version:'+workKey)||null;}catch{return null;}}
      const response=await fetcher(await address(workKey),{cache:'no-store',signal:AbortSignal.timeout(6000)});
      if(!response.ok)throw new Error('暂时无法读取上次使用的版本。请重试，或展开“版本与来源”直接选择。');
      return (await response.json()).sourceId||null;
    },
    async save(workKey,sourceId){
      if(localOnly){(storage||globalThis.localStorage).setItem('volta:version:'+workKey,sourceId);return;}
      const response=await fetcher(await address(workKey),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId}),signal:AbortSignal.timeout(6000)});
      if(!response.ok)throw new Error('此次版本选择未能保存，下次可能仍会打开旧版本。');
    },
  };
}
