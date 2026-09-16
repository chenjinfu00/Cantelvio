import {scoreID} from './storage.js';
import {downloadVerifiedPDF} from './verified-download.js';
const PDFS='volta-offline-pdfs-v1';
const root=new URL('./',import.meta.url),metaURL=id=>new URL('./.offline-meta/'+id,root).href;
const $=id=>document.getElementById(id),mb=bytes=>(bytes/1048576).toFixed(1)+' MB';
export async function offlineItems(){
  const cache=await caches.open(PDFS),items=[];
  for(const request of await cache.keys())if(request.url.startsWith(new URL('./.offline-meta/',root).href)){
    try{const item=await (await cache.match(request)).json();if(await cache.match(item.url))items.push(item);}catch{}
  }
  return items.sort((a,b)=>b.savedAt-a.savedAt);
}
// Return a stable URL for a PDF that was already kept on this device. Blob URLs from a
// previously selected iPad folder are intentionally never returned: they die with that page.
export async function offlineScore(id){
  if(!id)return null;
  return (await offlineItems()).find(item=>item.id===id)||null;
}
export async function saveOffline(score,progress=()=>{}){
  if(!score?.id)throw new Error('请先打开曲谱。');
  const sourceURL=score.remote?.url||new URL('./offline-score/'+score.id+'.pdf',root).href;
  const url=new URL('./offline-score/'+score.id+'.pdf',root).href;
  if(new URL(sourceURL).origin!==root.origin)throw new Error('请先把外部曲谱导入，再保存到本机。');
  const cache=await caches.open(PDFS),pending=new URL('./.offline-pending/'+score.id,root).href;let bytes;
  if(!score.buffer)bytes=await downloadVerifiedPDF(cache,pending,sourceURL,{id:score.id,progress,cacheURL:url});
  else{
    progress('正在校验并保存…');
    if(await scoreID(score.buffer)!==score.id)throw new Error('文件校验未通过，请重新下载。');
    bytes=score.buffer.byteLength;
    await cache.put(url,new Response(score.buffer,{headers:{'Content-Type':'application/pdf','Content-Length':String(bytes),'Accept-Ranges':'bytes'}}));
  }
  // Always publish the stable local URL. In particular, an iPad folder gives us a blob: URL
  // that cannot be reopened after Safari or the Home Screen app is restarted.
  const item={id:score.id,name:score.name,url,remote:{id:score.id,url},bytes,savedAt:Date.now()};
  try{await cache.put(metaURL(score.id),new Response(JSON.stringify(item),{headers:{'Content-Type':'application/json'}}));}catch(error){await cache.delete(url);throw error;}
  return item;
}
export function setupOffline(current,openPDF,toast,settings=()=>({})){ 
  let saving=false,shellReady=false,attempted=null;
  const supported='serviceWorker' in navigator&&'caches' in globalThis&&isSecureContext;
  const ready=supported?(async()=>{
    await navigator.serviceWorker.register(new URL('./sw.js',root),{type:'module',scope:root.pathname,updateViaCache:'none'});
    await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('离线应用准备较慢，请稍后再试。')),60000))]);
    shellReady=true;return true;
  })():Promise.reject(new Error('离线使用需要 HTTPS 或本机 localhost，并使用支持离线存储的浏览器。'));
  // The worker reports what it is saving, so "准备中" is a number instead of a wait.
  navigator.serviceWorker?.addEventListener?.('message',event=>{
    const data=event.data||{};
    if(data.type==='volta:shell-progress'&&!saving)$('offline-status').textContent=`正在保存离线阅谱应用 ${data.done}/${data.total}…`;
    else if(data.type==='volta:shell-ready'){shellReady=true;refresh();}
  });
  ready.then(()=>refresh()).catch(error=>{$('offline-summary').textContent=error.message;$('offline-status').textContent=error.message;});
  // Whether markings survive a closed app is not something a reader should have to click to find
  // out, so the answer is on screen whenever the settings are.
  async function sayDurability(){
    const node=$('storage-status');if(!node)return;
    try{
      const kept=await navigator.storage?.persisted?.();
      const estimate=await navigator.storage?.estimate?.();
      const used=estimate?.usage?` 本网站已用 ${mb(estimate.usage)}。`:'';
      node.textContent=kept===true?'浏览器已同意长期保留本机数据，关掉应用批注仍在。'+used
        :kept===false?'浏览器尚未保证长期保留。点下面的按钮申请；iPad 上把网页加到主屏幕后更容易获批。'+used
        :'此浏览器不报告存储状态，重要批注请定期导出备份。';
    }catch{node.textContent='此浏览器暂不支持持久存储申请。';}
  }
  async function refresh(){
    sayDurability();
    if(!supported){$('offline-save').disabled=true;return;}
    try{
      const items=await offlineItems(),score=current(),saved=items.some(item=>item.id===score?.id);
      $('offline-save').disabled=saving||!score||saved&&shellReady;
      $('offline-save').textContent=saved&&shellReady?'✓ 已保存到这台设备':'保存当前曲谱供离线使用';
      if(!saving)$('offline-status').textContent=saved&&shellReady?'PDF 和阅谱应用均已保存，可断网打开。':shellReady?'离线应用已就绪。保存 PDF 后可断网阅读。':'正在准备离线阅谱应用…';
      $('offline-summary').textContent=`${items.length} 份已保存 · ${mb(items.reduce((sum,item)=>sum+item.bytes,0))}${shellReady?' · 离线应用已就绪':''}`;
      const list=$('offline-list');list.replaceChildren();
      for(const item of items){
        const row=document.createElement('div');row.className='offline-item';
        const title=document.createElement('span');title.textContent=item.name;const size=document.createElement('small');size.textContent=mb(item.bytes);title.append(size);
        const open=document.createElement('button');open.className='quiet';open.textContent='打开';open.onclick=async()=>{try{await openPDF(item.remote,item.name);$('settings-dialog').close();}catch(error){toast(error.message);}};
        const remove=document.createElement('button');remove.className='quiet';remove.textContent='移除';remove.ariaLabel='移除离线副本：'+item.name;
        remove.onclick=async()=>{try{if(!confirm('仅移除这台设备上下载的 PDF？原谱和手写批注不会删除。'))return;const cache=await caches.open(PDFS);await cache.delete(item.url);await cache.delete(metaURL(item.id));navigator.serviceWorker?.controller?.postMessage({type:'volta:forget',url:item.url});await refresh();}catch{toast('离线副本暂时无法移除，请重试。');}};
        row.append(title,open,remove);list.append(row);
      }
      // Local libraries already have the authoritative PDF. Do not silently duplicate every
      // local score into Cache Storage; explicit offline deployment remains available.
      if(score&&!score.local&&!score.system&&shellReady&&!saved&&!saving&&navigator.onLine&&settings().autoOffline&&attempted!==score.id){attempted=score.id;setTimeout(()=>{if(current()?.id===score.id&&!current()?.local&&!saving&&settings().autoOffline)$('offline-save').click();},1200);}
    }catch{$('offline-summary').textContent='当前浏览器未允许本机存储，请检查浏览器设置。';}
  }
  $('offline-save').onclick=async()=>{
    if(saving||!current())return;saving=true;const score=current();$('offline-save').disabled=true;
    try{$('offline-status').textContent='正在确认离线应用已完整保存…';await ready;await saveOffline(score,message=>$('offline-status').textContent=message);toast('已完整保存到这台设备，可断网阅读。');}
    catch(error){$('offline-status').textContent=error.name==='QuotaExceededError'?'本机空间不足，未完成保存。请移除不需要的离线副本。':error.message;toast($('offline-status').textContent);}
    finally{const message=$('offline-status').textContent;saving=false;await refresh();if(!message.startsWith('正在')&&!message.startsWith('已下载'))$('offline-status').textContent=message;}
  };
  $('storage-persist').onclick=async()=>{
    try{const granted=await navigator.storage?.persist?.();const estimate=await navigator.storage?.estimate?.();$('storage-status').textContent=(granted?'浏览器已同意尽量保留本机数据。':'浏览器未保证长期保留；重要批注请另存备份。')+(estimate?.usage?` 本网站已用 ${mb(estimate.usage)}。`:'');}catch{$('storage-status').textContent='此浏览器暂不支持持久存储申请。';}
  };
  $('settings-dialog').addEventListener('toggle',()=>refresh());
  refresh();return {refresh};
}
