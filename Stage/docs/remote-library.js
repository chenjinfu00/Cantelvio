// An explicitly configured, same-origin connection to the owner's score server.
// Static/offline readers keep using the device folder unless the server adds this marker.
import {catalogueWithFolderShelves} from './local-library.js';

export async function connectRemoteLibrary({marker=globalThis.document?.getElementById('score-library-connection'),base=globalThis.location?.href,request=globalThis.fetch}={}){
  if(!marker)return null;
  const endpoint=new URL(marker.textContent.trim(),base);
  if(endpoint.origin!==new URL(base).origin)throw new Error('曲谱库必须与阅谱页面使用同一个地址。');
  const read=async url=>{
    const response=await request(url,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('无法连接 Mac 曲谱库，请确认电脑已开机并连接同一 Wi-Fi。');
    return response.json();
  };
  let catalog,files;
  const address=relative=>new URL('../'+relative,endpoint).href;
  const reload=async()=>{
    const data=await read(endpoint);
    if(!Array.isArray(data.catalog?.items)||!data.manifest?.files)throw new Error('曲谱目录不完整，请在 Mac 上检查曲谱库。');
    catalog=catalogueWithFolderShelves(data.catalog,data.manifest);files=data.manifest.files;
  };
  await reload();
  return {
    kind:'server',needsFolder:false,writable:false,canRequestWrite:false,
    get catalog(){return catalog;},get size(){return catalog.items.filter(item=>item.available&&item.format==='pdf').length;},
    get missing(){return catalog.items.filter(item=>!item.available).map(item=>item.id);},
    reload,
    url:id=>Object.hasOwn(files,id)?address('scores/'+id+'.pdf'):null,
    path:id=>files[id]||null,
    pathURL:relative=>{const id=Object.keys(files).find(id=>files[id]===relative);return id?address('scores/'+id+'.pdf'):null;},
    sourceURL:(id,name)=>Object.hasOwn(files,id)&&name&&!/[\\/]/.test(name)?address('sources/'+id+'/'+encodeURIComponent(name)):null,
    async fit(id){try{return await read(address('fit/'+id+'.json'));}catch{return null;}},
    inkFiles:async()=>[],writeJSON:null,release(){},
  };
}
