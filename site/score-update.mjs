// Compatibility for the retired Score PDF reader. Score is the notation editor;
// Stage owns PDF reading. Retire only the old Score worker, never user storage.
export async function restoreScoreEditor({readerRoot,serviceWorker=globalThis.navigator?.serviceWorker}){
  const root=new URL(readerRoot);
  if(!root.pathname.endsWith('/')||root.search||root.hash)throw new Error('旧入口地址无效。');
  if(serviceWorker?.controller)throw new Error('请在新标签页打开 Score 编辑器入口。');
  const registrations=async()=>serviceWorker?.getRegistrations?await serviceWorker.getRegistrations():[];
  const exact=registration=>registration.scope===root.href;
  let retired=0;
  for(const registration of (await registrations()).filter(exact)){await registration.unregister();retired++;}
  if((await registrations()).some(exact))throw new Error('请关闭其他旧阅谱标签页，再点重试。');
  return {destination:new URL('../',root).href,retired};
}

if(typeof document!=='undefined'){
  const status=document.getElementById('update-status'),retry=document.getElementById('update-retry');
  const open=async()=>{
    retry.hidden=true;status.textContent='正在打开打谱编辑器…';
    try{
      const result=await restoreScoreEditor({readerRoot:new URL('./library/',import.meta.url)});
      location.replace(result.destination);
    }catch(error){status.textContent=error.message||'暂时无法打开，请重试。';retry.hidden=false;}
  };
  retry.addEventListener('click',open);open();
}
