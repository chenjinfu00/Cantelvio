// Remove retired scores from the private cloud store: the metadata record, every 2 MiB chunk and the
// fit record. The catalogue no longer lists them, so this only reclaims space. Preview first.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

// Every key a single score owns in the two blob stores.
export function purgeKeys(id,meta){
  const chunks=Math.max(0,Math.round(Number(meta?.chunks)||0));
  return {files:[id,'fit-'+id],chunks:Array.from({length:chunks},(_,index)=>`${id}-${index}`)};
}
export function pruneCheckpoint(lines,ids){
  const gone=new Set(ids);
  return lines.filter(line=>{
    if(!line.trim())return false;
    try{return !gone.has(JSON.parse(line).id);}catch{return false;}
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.resolve(import.meta.dirname,'..'),library=path.join(root,'.local-library');
  const apply=process.argv.includes('--apply'),alsoLocal=process.argv.includes('--local');
  const retired=JSON.parse(await fs.readFile(path.join(library,'retired.json')));
  const ids=Object.keys(retired.items||{});
  if(!ids.length){console.log('没有已退役的曲谱。');process.exit(0);}
  const catalog=JSON.parse(await fs.readFile(path.join(library,'catalog.json')));
  const live=new Set(catalog.items.map(item=>item.id));
  const targets=ids.filter(id=>!live.has(id));
  if(targets.length!==ids.length)console.log(`跳过 ${ids.length-targets.length} 份：它们又回到了目录里。`);
  const {siteId}=JSON.parse(await fs.readFile(path.join(root,'.netlify/state.json')));
  const config=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Preferences/netlify/config.json')));
  const token=config.users?.[config.userId]?.auth?.token;
  if(!siteId||!token)throw Error('Run the official Netlify login and link commands first.');
  const {getStore}=await import('@netlify/blobs');
  const store=getStore('volta-files',{siteID:siteId,token}),chunks=getStore('volta-pdf-chunks',{siteID:siteId,token});
  let blobs=0,bytes=0,missing=0;
  for(const id of targets){
    const meta=await store.get(id,{type:'json'}).catch(()=>null);
    if(!meta){missing++;console.log(`  ${id.slice(0,8)} 云端没有记录 · ${retired.items[id].title}`);continue;}
    const keys=purgeKeys(id,meta);
    blobs+=keys.files.length+keys.chunks.length;bytes+=Number(meta.bytes)||0;
    console.log(`  ${apply?'删除':'待删除'} ${id.slice(0,8)} · ${keys.chunks.length} 块 · ${((meta.bytes||0)/1048576).toFixed(1)} MB · ${retired.items[id].title}`);
    if(!apply)continue;
    for(const key of keys.chunks)await chunks.delete(key).catch(()=>{});
    for(const key of keys.files)await store.delete(key).catch(()=>{});
  }
  console.log(`${targets.length} 份 · ${blobs} 个对象 · ${(bytes/1048576).toFixed(1)} MB${missing?` · ${missing} 份云端本就没有`:''}`);
  if(!apply){console.log('这是预览。确认后加 --apply 执行（云端删除不可撤销）。');process.exit(0);}
  const checkpoint=path.join(library,'upload-'+siteId+'.jsonl');
  try{
    const lines=(await fs.readFile(checkpoint,'utf8')).split('\n');
    const kept=pruneCheckpoint(lines,targets);
    await fs.writeFile(checkpoint,kept.join('\n')+(kept.length?'\n':''));
    console.log(`断点表已清理：${lines.filter(Boolean).length} → ${kept.length}`);
  }catch{}
  if(alsoLocal){
    for(const id of targets){
      const relative=retired.items[id].path;if(!relative)continue;
      const file=path.resolve(library,'retired',relative);
      if(!file.startsWith(path.join(library,'retired')+path.sep))continue;
      await fs.rm(file,{force:true});
    }
    console.log('本机 retired/ 里的副本也已删除。');
  }
  console.log('完成。');
}
