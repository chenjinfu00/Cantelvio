import {allInkDrafts,inkDraft,cloudBase} from './storage.js';
import {mergeInk} from './ink-model.js';
import {cloudRequest} from './cloud-account.js';
import {CLOUD_LIBRARY} from './site-config.js';
const blank=()=>({version:1,strokes:[]});
export async function syncOnePage(key,{local,base,request=cloudRequest}){
  for(let attempt=0;attempt<4;attempt++){
    const response=await request('notes/'+key);if(!response.ok)throw Error('无法读取云端批注');
    const remote=await response.json(),merged=mergeInk(base,local,remote);
    if(JSON.stringify(merged)===JSON.stringify(remote))return merged;
    const put=await request('notes/'+key,{method:'PUT',headers:{'Content-Type':'application/json','If-Match':response.headers.get('ETag')||'new'},body:JSON.stringify(merged)});
    if(put.status===409)continue;if(!put.ok)throw Error('云端批注未保存，请重试。');return merged;
  }
  throw Error('另一台设备正在修改批注，请稍后再更新。');
}
export function setupCloudSync(ink,toast,canSync){
  const button=document.getElementById('cloud-sync'),status=document.getElementById('cloud-status');let busy=false;
  button.onclick=async()=>{
    if(busy||!CLOUD_LIBRARY)return;
    if(!canSync()){toast('请先停止演出或聆听，再更新批注。');return;}
    busy=true;button.disabled=true;status.textContent='正在保存本机批注…';
    try{
      // Suspend writing during this explicit action, preserving the current pen.
      for(const view of ink.views)view.finish?.();
      for(const record of ink.records.values()){clearTimeout(record.timer);await ink.flush(record);await ink.cache(record);}
      const list=await cloudRequest('notes');if(!list.ok)throw Error('无法读取云端批注清单');
      const drafts=new Map((await allInkDrafts()).map(row=>[row.id,row]));
      const keys=[...new Set([...drafts.keys(),...(await list.json()).keys])].filter(key=>/^[a-f0-9]{64}\/[1-9][0-9]{0,4}$/.test(key));
      let count=0;
      for(const key of keys){
        status.textContent=`正在更新批注 ${count+1}/${keys.length}…`;
        const local=drafts.get(key)?.data||blank(),base=await cloudBase(key)||blank();
        const merged=await syncOnePage(key,{local,base});
        // Save local data before the merge base: interruption safely repeats.
        await inkDraft(key,{data:merged,base:merged,etag:'"local"',dirty:false});await cloudBase(key,merged);
        const record=ink.records.get(key);if(record){record.data=structuredClone(merged);record.base=structuredClone(merged);record.dirty=false;record.undo=[];record.redo=[];record.revision++;ink.draw(record);}
        count++;
      }
      const text=`已更新 ${count} 页批注 · ${new Date().toLocaleString()}`;localStorage.setItem('volta:last-cloud-sync',text);status.textContent=text;toast('批注已合并更新到云端与这台设备。');
    }catch(error){status.textContent=error.message+' 本机批注仍保留。';toast(status.textContent);}finally{busy=false;button.disabled=false;}
  };
  if(CLOUD_LIBRARY)status.textContent=localStorage.getItem('volta:last-cloud-sync')||'点击“更新批注”，合并本机与云端的最新版本。';
  return {get busy(){return busy;}};
}
