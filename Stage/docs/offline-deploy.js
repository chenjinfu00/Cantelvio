import {PUBLIC_LIBRARY} from './site-config.js';
import {saveOffline,offlineItems} from './offline.js';
const $=id=>document.getElementById(id),root=new URL('./',import.meta.url);
export const mb=bytes=>(bytes/1048576).toFixed(1)+' MB';
export const scoreURL=id=>new URL(PUBLIC_LIBRARY?'./scores/'+id+'.pdf':'./api/files/'+id,root).href;

// What a deployment will actually cost, before it starts.
export function deployPlan(items,selected){
  const chosen=new Set(selected||[]);
  const picked=(items||[]).filter(item=>chosen.has(item.id));
  return {count:picked.length,bytes:picked.reduce((sum,item)=>sum+(Number(item.bytes)||0),0),items:picked};
}
export function matchScores(items,query,limit=60){
  const words=String(query||'').toLowerCase().split(/\s+/).filter(Boolean);
  const hits=(items||[]).filter(item=>{
    if(item.format!=='pdf'||item.available===false)return false;
    if(!words.length)return true;
    const haystack=[item.title,item.composer,item.arranger,...(item.aliases||[])].join(' ').toLowerCase();
    return words.every(word=>haystack.includes(word));
  });
  return {total:hits.length,shown:hits.slice(0,limit)};
}

export async function loadCatalog(){
  const response=await fetch(new URL(PUBLIC_LIBRARY?'./library/catalog.json':'./api/library',root),{cache:'no-store'});
  if(!response.ok)throw new Error('曲谱库暂时不可用，请联网后重试。');
  const data=await response.json();return Array.isArray(data.items)?data.items:[];
}

// Ask the service worker to save every app asset, and follow along.
export function installShell({onProgress=()=>{},timeout=180000}={}){
  if(!('serviceWorker' in navigator)||!('caches' in globalThis)||!isSecureContext)
    return Promise.reject(new Error('离线使用需要 HTTPS 或本机 localhost，并使用支持离线存储的浏览器。'));
  return new Promise(async(resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error('离线应用保存较慢，可稍后再试；已保存的部分会保留。'));},timeout);
    const listen=event=>{
      const data=event.data||{};
      if(data.type==='volta:shell-progress')onProgress(data);
      else if(data.type==='volta:shell-ready'){cleanup();data.error?reject(new Error(data.error)):resolve(data);}
    };
    const cleanup=()=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('message',listen);};
    navigator.serviceWorker.addEventListener('message',listen);
    try{
      await navigator.serviceWorker.register(new URL('./sw.js',root),{type:'module',scope:root.pathname,updateViaCache:'none'});
      const registration=await navigator.serviceWorker.ready;
      (registration.active||navigator.serviceWorker.controller)?.postMessage({type:'volta:prime'});
    }catch(error){cleanup();reject(error);}
  });
}

export function setupDeploy({toast=()=>{},onDone=()=>{}}={}){
  const dialog=$('deploy-dialog');if(!dialog)return null;
  let items=[],selected=new Set(),saved=new Set(),running=false;
  const shellStatus=$('deploy-shell-status'),bar=$('deploy-shell-bar'),list=$('deploy-list'),status=$('deploy-status');
  function summary(){
    const plan=deployPlan(items,selected);
    $('deploy-selection').textContent=plan.count?`已选 ${plan.count} 份 · ${mb(plan.bytes)}`:'未选择曲谱（只装应用也可以）';
    $('deploy-start').disabled=running;
  }
  function render(){
    const {total,shown}=matchScores(items,$('deploy-search').value);
    list.textContent='';
    for(const item of shown){
      const row=document.createElement('label');row.className='deploy-item';
      const box=document.createElement('input');box.type='checkbox';box.checked=selected.has(item.id);box.disabled=running;
      box.onchange=()=>{box.checked?selected.add(item.id):selected.delete(item.id);summary();};
      const name=document.createElement('span');name.textContent=item.title;
      const size=document.createElement('small');size.textContent=(saved.has(item.id)?'已在本机 · ':'')+mb(item.bytes||0);
      row.append(box,name,size);list.append(row);
    }
    if(!shown.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='没有匹配的曲谱。';list.append(empty);}
    else if(total>shown.length){const more=document.createElement('p');more.className='muted';more.textContent=`还有 ${total-shown.length} 份未显示，用搜索缩小范围。`;list.append(more);}
    summary();
  }
  async function refresh(){
    try{saved=new Set((await offlineItems()).map(item=>item.id));}catch{saved=new Set();}
    if(!items.length){try{items=await loadCatalog();}catch(error){status.textContent=error.message;}}
    render();
  }
  $('deploy-search').oninput=render;
  $('deploy-start').onclick=async()=>{
    if(running)return;
    running=true;$('deploy-start').disabled=true;render();
    try{
      status.textContent='正在保存阅谱应用…';
      const shell=await installShell({onProgress:({done,total})=>{
        bar.style.width=total?Math.round(done/total*100)+'%':'0%';
        shellStatus.textContent=`阅谱应用 ${done}/${total}`;
      }});
      bar.style.width='100%';
      shellStatus.textContent=shell.failed?`阅谱应用已保存 ${shell.done}/${shell.total}，${shell.failed} 项稍后重试。`:`阅谱应用已完整保存（${shell.done} 项）。`;
      const plan=deployPlan(items,selected);let index=0,failed=0;
      for(const item of plan.items){
        index++;
        if(saved.has(item.id))continue;
        status.textContent=`正在下载 ${index}/${plan.count} · ${item.title}`;
        try{await saveOffline({id:item.id,name:item.title,remote:{id:item.id,url:scoreURL(item.id)}},message=>{status.textContent=`${index}/${plan.count} · ${item.title} · ${message}`;});saved.add(item.id);}
        catch(error){failed++;status.textContent=`${item.title}：${error.message}`;}
      }
      try{await navigator.storage?.persist?.();}catch{}
      status.textContent=failed?`部署完成，${failed} 份曲谱未能保存，可稍后重试。`:plan.count?`已部署到这台设备：应用 + ${plan.count} 份曲谱，断网可用。`:'阅谱应用已部署到这台设备，断网可打开已保存的曲谱。';
      toast(status.textContent);
    }catch(error){status.textContent=error.message;toast(error.message);}
    finally{running=false;await refresh();onDone();}
  };
  dialog.querySelectorAll('[data-close-deploy]').forEach(button=>button.onclick=()=>dialog.close());
  return {open(){dialog.showModal();refresh();},refresh};
}
