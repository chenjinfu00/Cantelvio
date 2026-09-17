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

// Writing needs a folder handle the browser will let us write to. Safari's directory upload
// gives the reader files but no writable handle, so the local database remains the fallback there.
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
  // There is one explicit sync action, where the writing hand already is.
  const dock=$('ink-save');
  let busy=false;
  const source=()=>library?.local||null;
  const say=text=>{if(status)status.textContent=text;};
  function describe(){
    const local=source();
    if(!local||local.needsFolder){
      if(dock){dock.disabled=false;dock.title='同步批注到本机曲谱库';dock.querySelector('span').textContent='同步';}
      return say(local?.needsFolder?'请重新连接本地曲谱文件夹后同步批注。':'请先选择本地曲谱文件夹。');
    }
    say(local.writable?'已连接曲谱库，批注会同步到「曲谱库数据／批注」。':local.canRequestWrite?'点击“同步批注到本机”时，系统会请求曲谱库写入权限。':'当前浏览器只能把批注保存在本机数据库，无法申请曲谱库写入权限。');
    if(dock){
      dock.disabled=false;
      dock.title='同步批注到本机曲谱库';
      dock.querySelector('span').textContent='同步';
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
    busy=true;if(dock)dock.disabled=true;
    try{
      await drain?.(ink);
      const local=source();
      if(local?.canRequestWrite&&!local.writable&&!local.needsFolder){
        const granted=await local.requestWrite();
        if(!granted){
          const message='没有获得曲谱库写入权限；批注仍已保存在本机数据库。';
          say(message);toast(message);return;
        }
      }
      if(local?.writable&&!local.needsFolder){
        const written=await save();
        say(`已写入 ${written} 首曲子的批注。`);
        toast(written?'批注已保存到曲谱文件夹。':'还没有批注可以保存。');
      }else{
        const message=local?.needsFolder?'请先重新连接本地曲谱文件夹，再同步批注。':'当前浏览器无法申请曲谱库写入权限；批注已保存在本机数据库。';
        say(message);toast(message);
      }
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
        await save({quiet:true});
      }catch(error){say(error.message);}
    },
  };
}
