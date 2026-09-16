// Retiring a score never deletes it: the PDF moves to 本地曲谱/retired/ and the id is
// recorded so a later rebuild does not bring it back. Nothing here touches docs/.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {libraryRoot,libraryData} from './library-root.mjs';

export function resolveIds(items,wanted){
  const found=[],missing=[],ambiguous=[];
  for(const raw of wanted){
    const needle=String(raw||'').trim().toLowerCase();
    if(!needle)continue;
    const hits=items.filter(item=>item.id===needle||item.id.startsWith(needle));
    if(!hits.length)missing.push(raw);
    else if(hits.length>1)ambiguous.push({needle:raw,ids:hits.map(h=>h.id)});
    else if(!found.some(item=>item.id===hits[0].id))found.push(hits[0]);
  }
  return {found,missing,ambiguous};
}
// What the retirement will change, computed before anything moves.
export function retirePlan(catalog,manifest,wanted){
  const {found,missing,ambiguous}=resolveIds(catalog.items||[],wanted);
  const moves=found.map(item=>({id:item.id,title:item.title,bytes:item.bytes,from:manifest.files?.[item.id]||null}));
  const keep=(catalog.items||[]).filter(item=>!found.some(gone=>gone.id===item.id));
  return {moves,keep,missing,ambiguous,bytes:found.reduce((sum,item)=>sum+(Number(item.bytes)||0),0),
    unmapped:moves.filter(move=>!move.from).map(move=>move.id)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=libraryRoot();
  const args=process.argv.slice(2),apply=args.includes('--apply');
  const reasonAt=args.indexOf('--reason'),reason=reasonAt>=0?args[reasonAt+1]||'':'';
  const wanted=args.filter((value,index)=>!value.startsWith('--')&&args[index-1]!=='--reason');
  if(!wanted.length){console.error('用法: node scripts/retire-scores.mjs <id 或 id 前缀> [...] [--reason "原因"] [--apply]');process.exit(1);}
  const catalog=JSON.parse(await fs.readFile(path.join(libraryData(root),'catalog.json')));
  const manifest=JSON.parse(await fs.readFile(path.join(libraryData(root),'manifest.json')));
  let retired={version:1,items:{}};
  try{retired=JSON.parse(await fs.readFile(path.join(libraryData(root),'retired.json')));}catch{}
  const plan=retirePlan(catalog,manifest,wanted);
  for(const item of plan.missing)console.error('找不到:',item);
  for(const item of plan.ambiguous)console.error('前缀不唯一:',item.needle,item.ids.join(' '));
  if(plan.missing.length||plan.ambiguous.length)process.exit(1);
  for(const move of plan.moves)console.log(`${apply?'移出':'待移出'} ${move.id.slice(0,8)} · ${(move.bytes/1024).toFixed(0)} KB · ${move.title}`);
  console.log(`${plan.moves.length} 份 · ${(plan.bytes/1048576).toFixed(1)} MB · 保留 ${plan.keep.length} 份`);
  if(!apply){console.log('这是预览。确认无误后加 --apply 执行。');process.exit(0);}
  for(const move of plan.moves){
    if(move.from){
      const source=path.join(root,move.from),target=path.join(root,'retired',move.from);
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.rename(source,target).catch(async error=>{if(error.code!=='ENOENT')throw error;});
    }
    const fit=path.join(libraryData(root),'fit',move.id+'.json');
    await fs.mkdir(path.join(root,'retired','fit'),{recursive:true});
    await fs.rename(fit,path.join(root,'retired','fit',move.id+'.json')).catch(()=>{});
    delete manifest.files[move.id];
    retired.items[move.id]={title:move.title,bytes:move.bytes,path:move.from,reason,retiredAt:new Date().toISOString()};
  }
  catalog.items=plan.keep;
  if(catalog.summary){catalog.summary.pdfs=plan.keep.length;catalog.summary.unique=plan.keep.length;catalog.summary.bytes=plan.keep.reduce((sum,item)=>sum+(Number(item.bytes)||0),0);}
  catalog.updatedAt=new Date().toISOString();
  await fs.writeFile(path.join(libraryData(root),'catalog.json'),JSON.stringify(catalog,null,2));
  await fs.writeFile(path.join(libraryData(root),'manifest.json'),JSON.stringify(manifest,null,2));
  await fs.writeFile(path.join(libraryData(root),'retired.json'),JSON.stringify(retired,null,2));
  console.log('已完成。重新运行 scripts/upload-private-library.mjs 后，这些曲谱会从 app 里消失。');
}
