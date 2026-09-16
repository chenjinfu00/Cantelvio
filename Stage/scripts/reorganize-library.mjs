// Rebuild the private library's physical folders from the same model the Volta shelf uses.
// The default run is a preview. --apply moves files only after every source hash and target is checked.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {libraryRelativePath,replaceLibraryAlias,classifyLibraryItem} from './library-paths.mjs';
import {libraryRoot,libraryData} from './library-root.mjs';

const digest=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);

export function shelfSizes(items){
  const works=new Map();
  for(const item of items){
    const {browse,work}=classifyLibraryItem(item);
    works.set(browse,(works.get(browse)||new Set()).add(work.key));
  }
  return new Map([...works].map(([browse,keys])=>[browse,keys.size]));
}
export function reorganizationPlan(items,files){
  const moves=[],folders=new Map(),shelves=shelfSizes(items);
  // macOS and iCloud fold case, so two versions of one work must not disagree on the folder's
  // spelling: the first spelling seen wins for every version that lands in the same folder.
  const settle=relative=>{
    const folder=path.dirname(relative),key=folder.toLocaleLowerCase();
    const canonical=folders.get(key)??folder;
    folders.set(key,canonical);
    return path.join(canonical,path.basename(relative));
  };
  for(const item of items){
    const current=files[item.id];
    const classified=libraryRelativePath(item,{current,shelfWorks:shelves.get(classifyLibraryItem(item).browse)??Infinity});
    if(!current)throw new Error('Manifest has no path for '+item.id);
    const next=settle(classified.relative);
    if(current!==next)moves.push({id:item.id,title:item.title,current,next,classified});
  }
  const targets=moves.map(move=>move.next);
  if(new Set(targets).size!==targets.length)throw new Error('Two scores resolve to the same target path');
  return moves;
}

async function pruneEmpty(folder,keep){
  for(const entry of await fs.readdir(folder,{withFileTypes:true}))if(entry.isDirectory())await pruneEmpty(path.join(folder,entry.name),keep);
  if(folder!==keep&&!(await fs.readdir(folder)).length)await fs.rmdir(folder);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=libraryRoot(),apply=process.argv.includes('--apply');
  const catalog=JSON.parse(await fs.readFile(path.join(libraryData(root),'catalog.json'))),manifest=JSON.parse(await fs.readFile(path.join(libraryData(root),'manifest.json')));
  const moves=reorganizationPlan(catalog.items,manifest.files||{}),counts={};
  for(const move of moves){const group=path.dirname(move.next).split(path.sep).join(' / ');counts[group]=(counts[group]||0)+1;}
  for(const [group,count] of Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'zh-CN')))console.log(`  ${count}  ${group}`);
  console.log(`${moves.length} / ${catalog.items.length} 份需要移动或改名。`);
  if(!apply){console.log('这是预览。确认后加 --apply 执行。');process.exit(0);}

  // Complete the entire preflight before the first rename.
  for(const move of moves){
    const source=path.resolve(root,move.current),target=path.resolve(root,move.next);
    if(!inside(root,source)||!inside(root,target))throw new Error('Unsafe path for '+move.id);
    if(await digest(source)!==move.id)throw new Error('Source hash mismatch: '+move.current);
    try{await fs.access(target);throw new Error('Target already exists: '+move.next);}catch(error){if(error.code!=='ENOENT')throw error;}
  }

  for(const move of moves){
    const source=path.join(root,move.current),target=path.join(root,move.next);
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.rename(source,target);
    manifest.files[move.id]=move.next;
    const item=catalog.items.find(candidate=>candidate.id===move.id);
    item.category=move.classified.browse;item.aliases=replaceLibraryAlias(item.aliases,move.next);
  }
  catalog.updatedAt=new Date().toISOString();
  await fs.writeFile(path.join(libraryData(root),'catalog.json'),JSON.stringify(catalog,null,2));
  await fs.writeFile(path.join(libraryData(root),'manifest.json'),JSON.stringify(manifest,null,2));
  try{
    const auditPath=path.join(libraryData(root),'merge-audit.json'),audit=JSON.parse(await fs.readFile(auditPath));
    for(const record of audit.audit||[])if(manifest.files[record.id])record.target=manifest.files[record.id];
    await fs.writeFile(auditPath,JSON.stringify(audit,null,2));
  }catch{}
  await pruneEmpty(root,root);
  console.log(`已整理 ${moves.length} 份；目录、manifest、catalog 与审计记录已同步。`);
}
