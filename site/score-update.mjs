// This entry lives outside the reader worker's scope. Refresh program files
// before resetting only that worker registration; user storage stays intact.
const REQUIRED=['index.html','app.js','library.js','reader-start.js','style.css','reader.css','offline.js'];
const PROGRAM=/\.(?:html|js|mjs|css|json|webmanifest)$/i;

function readerAssets(manifest,root){
  if(!Array.isArray(manifest))throw new Error('无法读取阅读器更新清单。');
  const assets=new Map();
  for(const entry of manifest){
    if(typeof entry!=='string')throw new Error('阅读器更新清单格式有误。');
    const url=new URL(entry,root);
    if(url.origin!==root.origin||!url.pathname.startsWith(root.pathname)||url.username||url.password)
      throw new Error('阅读器更新清单包含无效路径。');
    if(PROGRAM.test(url.pathname))assets.set(url.href,url);
  }
  for(const file of REQUIRED)if(!assets.has(new URL(file,root).href))throw new Error('阅读器更新清单不完整。');
  return [...assets.values()];
}

export async function refreshReader({readerRoot,expectedVersion='',fetcher=globalThis.fetch,serviceWorker=globalThis.navigator?.serviceWorker,onProgress=()=>{}}){
  const root=new URL(readerRoot);
  if(!root.pathname.endsWith('/')||root.search||root.hash)throw new Error('阅读器地址无效。');
  if(serviceWorker?.controller)throw new Error('请在 Safari 新标签页打开此更新链接。');
  const registrations=async()=>serviceWorker?.getRegistrations?await serviceWorker.getRegistrations():[];
  const exact=registration=>registration.scope===root.href;
  const current=(await registrations()).filter(exact);
  const destination=new URL('./',root);destination.searchParams.set('library','1');
  if(expectedVersion)destination.searchParams.set('updated',expectedVersion);
  if(expectedVersion&&current.some(registration=>{
    try{return new URL(registration.active?.scriptURL).searchParams.get('version')===expectedVersion;}catch{return false;}
  }))return {destination:destination.href,refreshed:false,assets:0};

  const response=await fetcher(new URL('cache-manifest.json',root).href,{cache:'reload',credentials:'same-origin'});
  if(!response.ok)throw new Error('暂时无法读取新版阅读器，请保持联网后重试。');
  const assets=readerAssets(await response.json(),root);
  let done=0;onProgress({done,total:assets.length});
  for(const url of assets){
    const asset=await fetcher(url.href,{cache:'reload',credentials:'same-origin'});
    if(!asset.ok)throw new Error('部分程序资源尚未下载完成，请保持联网后重试。');
    await asset.arrayBuffer();
    onProgress({done:++done,total:assets.length});
  }
  // Fetch completion alone only promises headers. All bodies above must have
  // finished before the old working registration can be replaced.
  for(const registration of (await registrations()).filter(exact))await registration.unregister();
  if((await registrations()).some(exact))throw new Error('请先关闭其他 Score 标签页，再点重试。');
  return {destination:destination.href,refreshed:true,assets:done};
}

if(typeof document!=='undefined'){
  const status=document.getElementById('update-status'),progress=document.getElementById('update-progress'),retry=document.getElementById('update-retry');
  const open=async()=>{
    retry.hidden=true;progress.hidden=false;status.textContent='正在准备新版 Score…';
    try{
      const result=await refreshReader({readerRoot:new URL('./library/',import.meta.url),expectedVersion:document.documentElement.dataset.readerVersion,
        onProgress:({done,total})=>{progress.max=total||1;progress.value=done;status.textContent=`正在准备新版 Score · ${done}/${total}`;}});
      status.textContent='已更新，正在打开曲谱库…';location.replace(result.destination);
    }catch(error){progress.hidden=true;status.textContent=error.message||'更新暂时未完成，请联网后重试。';retry.hidden=false;}
  };
  retry.addEventListener('click',open);open();
}
