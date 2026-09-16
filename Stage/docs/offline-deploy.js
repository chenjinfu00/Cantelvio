const $=id=>document.getElementById(id),root=new URL('./',import.meta.url);

// The only deployment target is the reader shell. PDFs stay in the user-selected folder and
// are never copied to a server or silently duplicated into browser storage.
export function installShell({onProgress=()=>{},timeout=180000}={}){
  if(!('serviceWorker' in navigator)||!('caches' in globalThis)||!isSecureContext)
    return Promise.reject(new Error('离线使用需要 HTTPS 或本机 localhost，并使用支持离线存储的浏览器。'));
  return new Promise(async(resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error('离线应用保存较慢，可稍后再试；已保存的部分会保留。'));},timeout);
    let retries=0;
    const listen=event=>{
      const data=event.data||{};
      if(data.type==='volta:shell-progress')onProgress(data);
      else if(data.type==='volta:shell-ready'){
        if(data.error){cleanup();reject(new Error(data.error));return;}
        if(data.failed&&retries<1){
          retries++;
          onProgress({...data,retry:true});
          const send=worker=>worker?.postMessage({type:'volta:prime'});
          if(navigator.serviceWorker.controller)send(navigator.serviceWorker.controller);
          else navigator.serviceWorker.ready.then(reg=>send(reg.active)).catch(()=>{});
          return;
        }
        cleanup();resolve(data);
      }
    };
    const cleanup=()=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('message',listen);};
    navigator.serviceWorker.addEventListener('message',listen);
    try{
      const registration=await navigator.serviceWorker.register(new URL('./sw.js?version=20260916-2352',root),{type:'module',scope:root.pathname,updateViaCache:'none'});
      const active=registration.active||navigator.serviceWorker.controller;
      if(active)active.postMessage({type:'volta:prime'});
      else await navigator.serviceWorker.ready.then(reg=>reg.active?.postMessage({type:'volta:prime'}));
    }catch(error){cleanup();reject(error);}
  });
}

export function setupDeploy({toast=()=>{},onDone=()=>{}}={}){
  const dialog=$('deploy-dialog');if(!dialog)return null;
  let running=false;
  const shellStatus=$('deploy-shell-status'),bar=$('deploy-shell-bar'),status=$('deploy-status'),start=$('deploy-start');
  const refresh=()=>{
    $('deploy-summary').textContent='曲谱不会在这里复制；打开曲谱时直接从你选择的本地文件夹读取。';
    start.disabled=running;
  };
  start.onclick=async()=>{
    if(running)return;
    running=true;start.disabled=true;bar.style.width='0%';shellStatus.textContent='准备保存阅谱应用…';
    try{
      status.textContent='正在保存阅谱应用…';
      const shell=await installShell({onProgress:({done,total,retry})=>{
        bar.style.width=total?Math.round(done/total*100)+'%':'0%';
        shellStatus.textContent=retry?`发现失败资源，正在重试（${done}/${total}）…`:`阅谱应用 ${done}/${total}`;
      }});
      bar.style.width='100%';
      shellStatus.textContent=shell.failed
        ? `阅谱应用已保存 ${shell.done}/${shell.total}，仍有 ${shell.failed} 项稍后重试。${shell.failedURLs?.[0]?' 失败资源：'+new URL(shell.failedURLs[0]).pathname:''}`
        : `阅谱应用已完整保存（${shell.done} 项）。`;
      try{await navigator.storage?.persist?.();}catch{}
      status.textContent=shell.failed
        ? '应用已保存，但有资源暂时失败；请保持联网后再次部署。'
        : '阅谱应用已部署到这台设备。曲谱仍从本地曲谱文件夹读取，断网后可继续使用已选数据库中的曲谱。';
      toast(status.textContent);
    }catch(error){status.textContent=error.message;toast(error.message);}
    finally{running=false;start.disabled=false;refresh();onDone();}
  };
  dialog.querySelectorAll('[data-close-deploy]').forEach(button=>button.onclick=()=>dialog.close());
  return {open(){dialog.showModal();refresh();},refresh};
}
