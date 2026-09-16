// Annotations that live beside the music. A collection folder can hold them under
// 曲谱库数据/批注/<曲谱 id>.json, one file per score, so a folder synced between devices
// carries the markings as well as the notes.
import {allInkDrafts,saveInkDrafts} from './storage.js';
import {parseBackup,mergeBackup} from './annotation-backup.js';
import {DATA} from './local-library.js';
export const INK_DIR=DATA+'/批注';
export const inkPath=id=>INK_DIR+'/'+id+'.json';

// One score's pages, in the same shape the export and import already understand.
export function inkFileFor(scoreId,rows){
  const pages=(rows||[]).filter(row=>row.id.startsWith(scoreId+'/')&&row.data?.strokes?.length).map(({id,data})=>({id,data}));
  return pages.length?{format:'volta-annotations',version:1,scoreId,createdAt:new Date().toISOString(),pages}:null;
}
export function scoreIds(rows){
  return [...new Set((rows||[]).filter(row=>row.data?.strokes?.length).map(row=>row.id.split('/')[0]))];
}

// Reading is safe everywhere; a file that is damaged or from elsewhere is skipped, not trusted.
export async function readFolderInk(local){
  if(!local?.inkFiles)return [];
  const pages=[];
  for(const {id,read} of await local.inkFiles()){
    try{
      const value=await read();
      if(value?.scoreId&&value.scoreId!==id)continue;
      pages.push(...parseBackup(value));
    }catch{}
  }
  return pages;
}

// Merging keeps both sides: a stroke that exists on one device is added, and a stroke that
// disagrees with itself stops the merge rather than picking a winner.
export async function mergeIntoDevice(pages){
  if(!pages.length)return 0;
  const merged=mergeBackup(await allInkDrafts(),pages);
  await saveInkDrafts(merged);
  return merged.length;
}

// Writing needs a folder handle the browser will let us write to, which today means Chromium.
export async function writeFolderInk(local,rows){
  if(!local?.writeJSON)throw new Error('这个浏览器不能写入文件夹。请用「保存批注到曲谱文件夹」把文件存进去。');
  let written=0;
  for(const id of scoreIds(rows)){
    const value=inkFileFor(id,rows);
    if(value){await local.writeJSON(inkPath(id),value);written++;}
  }
  return written;
}

// Where a browser cannot write, the reader can still hand the file to their own Files app.
export async function offerInkFile(rows,{share=navigator.share?.bind(navigator),canShare=navigator.canShare?.bind(navigator)}={}){
  const pages=(rows||[]).filter(row=>row.data?.strokes?.length).map(({id,data})=>({id,data}));
  if(!pages.length)throw new Error('还没有批注可以保存。');
  const value={format:'volta-annotations',version:1,createdAt:new Date().toISOString(),pages};
  const name='volta-批注-'+new Date().toISOString().slice(0,10)+'.json';
  const file=new File([JSON.stringify(value)],name,{type:'application/json'});
  if(share&&canShare?.({files:[file]})){await share({files:[file],title:'Volta 批注'});return {pages:pages.length,how:'share'};}
  const url=URL.createObjectURL(file),a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  return {pages:pages.length,how:'download'};
}

// The settings panel and the folder, joined: read what the folder holds when it is opened, and
// put this device's markings back whenever the browser allows it.
export function setupInkFolder({ink,library,toast=()=>{},canRun=()=>true,drain,showMerged}){
  const $=id=>document.getElementById(id),button=$('ink-folder-save'),status=$('ink-folder-status');
  // The same action from two places: the settings panel, and the dock the writing hand is on.
  const dock=$('ink-save');
  let busy=false;
  const source=()=>library?.local||null;
  const say=text=>{if(status)status.textContent=text;};
  function describe(){
    const local=source();
    if(!local||local.needsFolder){
      // Safari/iPad cannot write to a user-selected Files folder. The ordinary save action
      // therefore confirms the IndexedDB copy; exporting is kept as an explicit backup action.
      if(button)button.textContent='确认本机保存';
      if(dock){dock.disabled=false;dock.title='批注已自动保存到本机';dock.querySelector('span').textContent='已保存';}
      return say('批注已自动保存在这台设备上，无需另选保存位置。');
    }
    say(local.writable?'已连接文件夹，批注会自动存进「曲谱库数据／批注」。':'Safari 不能直接写入文件 App 的指定文件夹；批注已自动保存在这台设备上。需要文件时，请使用下面的“导出批注”。');
    if(button)button.textContent=local.writable?'立即保存批注到曲谱文件夹':'确认本机保存';
    if(dock){
      dock.disabled=false;
      dock.title=local.writable?'保存批注到曲谱文件夹':'批注已自动保存到本机';
      dock.querySelector('span').textContent=local.writable?'保存':'已保存';
    }
  }
  // Opening a folder brings in whatever other devices left there.
  async function adopt(){
    const local=source();
    if(!local||local.needsFolder)return 0;
    const pages=await readFolderInk(local);
    if(!pages.length)return 0;
    const merged=mergeBackup(await allInkDrafts(),pages);
    await saveInkDrafts(merged);
    await showMerged?.(ink,merged);
    return merged.length;
  }
  async function save({quiet=false}={}){
    const local=source();
    // Safari cannot write beside the PDF, but it can still finish the durable local draft.
    // Drain before checking the folder so pagehide/visibilitychange never lose the last strokes.
    await drain?.(ink);
    if(!local||local.needsFolder||!local.writable)return 0;
    const written=await writeFolderInk(local,await allInkDrafts());
    if(!quiet&&written)toast(`已把 ${written} 首曲子的批注写进曲谱文件夹。`);
    return written;
  }
  async function keep(){
    if(busy||!canRun())return;
    busy=true;if(button)button.disabled=true;if(dock)dock.disabled=true;
    try{
      await drain?.(ink);
      const local=source();
      if(local?.writable&&!local.needsFolder){
        const written=await save();
        say(`已写入 ${written} 首曲子的批注。`);
        toast(written?'批注已保存到曲谱文件夹。':'还没有批注可以保存。');
      }else{
        // The draft is already written to IndexedDB while drawing. Drain here so the button
        // still provides a meaningful save checkpoint without opening Safari's file picker.
        await drain?.(ink);
        const message='批注已保存到这台设备，无需另选位置。若要放进曲谱文件夹，请使用设置里的“导出这份曲谱的批注”。';
        say(message);toast(message);
      }
    }catch(error){say(error.message);toast(error.message);}
    finally{busy=false;if(button)button.disabled=false;if(dock)dock.disabled=false;}
  }
  if(button)button.onclick=keep;
  if(dock)dock.onclick=keep;
  return {
    describe,save,keep,
    async onFolder(){
      describe();
      try{
        const count=await adopt();
        if(count)toast(`从曲谱文件夹读入了 ${count} 页批注。`);
        await save({quiet:true});
      }catch(error){say(error.message);}
    },
  };
}
