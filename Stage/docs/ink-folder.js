// Annotations that live beside the music. A collection folder can hold them under
// 曲谱库数据/批注/<曲谱 id>.json, one file per score, so a folder synced between devices
// carries the markings as well as the notes.
import {allInkDrafts,saveInkDrafts} from './storage.js';
import {parseBackup,mergeBackup,exportBackup} from './annotation-backup.js';
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

// Kept for the native/Chromium path; Safari uses exportBackup because its directory upload is read-only.
export async function writeFolderInk(local,rows){
  if(!local?.writeJSON)throw new Error('这个浏览器不能写入文件夹：无法申请曲谱库写入权限。');
  let written=0;
  for(const id of scoreIds(rows)){
    const value=inkFileFor(id,rows);
    if(value){await local.writeJSON(inkPath(id),value);written++;}
  }
  return written;
}

// The settings panel and the folder, joined: read what the folder holds when it is opened, and
// put this device's markings back whenever the browser allows it.
export function setupInkFolder({ink,library,toast=()=>{},canRun=()=>true,drain,showMerged}){
  const $=id=>document.getElementById(id),status=$('ink-folder-status');
  // There is one explicit export action, where the writing hand already is.
  const dock=$('ink-save');
  let busy=false;
  const source=()=>library?.local||null;
  const say=text=>{if(status)status.textContent=text;};
  const markExport=()=>{if(!dock)return;dock.title='导出批注备份';dock.setAttribute('aria-label','导出批注备份');const icon=dock.querySelector('svg');if(icon)icon.innerHTML='<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/><path d="M5 21a2 2 0 0 1-2-2v-3M19 21a2 2 0 0 0 2-2v-3"/>';};
  function describe(){
    const local=source();
    if(!local||local.needsFolder){
      if(dock)dock.disabled=false;markExport();
      return say('批注会自动保存在本机；点击“导出”后可选择保存到「曲谱库数据／批注」。');
    }
    say('批注会自动保存在本机；点击“导出”后，在系统保存面板选择「曲谱库数据／批注」。');
    if(dock){
      dock.disabled=false;
    }
    markExport();
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
  async function save(){
    // Finish the durable local draft before creating the export.
    await drain?.(ink);
    return exportBackup(await allInkDrafts());
  }
  async function keep(){
    if(busy||!canRun())return;
    busy=true;if(dock)dock.disabled=true;
    try{
      const result=await save();
      const message=result.count?`已导出 ${result.count} 页批注；请在系统面板选择「曲谱库数据／批注」。`:'还没有批注可以导出。';
      say(message);toast(message);
    }catch(error){say(error.message);toast(error.message);}
    finally{busy=false;if(dock)dock.disabled=false;}
  }
  if(dock)dock.onclick=keep;
  return {
    describe,save,keep,
    async onFolder(){
      describe();
      try{
        const count=await adopt();
        if(count)toast(`从曲谱文件夹读入了 ${count} 页批注。`);
      }catch(error){say(error.message);}
    },
  };
}
