// Put每份 MIDI / 制谱源文件 next to the score it belongs to, inside that work's folder.
// Matching is by name only, and anything uncertain is left where it is and reported.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {libraryRoot} from './library-root.mjs';

export const SOURCE_TYPES=['.mid','.midi','.sib','.mscz','.musicxml','.mxl','.xml','.cap','.mus'];

// Names differ by punctuation, spacing and case far more often than by content.
export function normalizeName(value){
  return String(value||'')
    .normalize('NFKC').toLocaleLowerCase()
    .replace(/\.(pdf|mid|midi|sib|mscz|musicxml|mxl|xml|cap|mus)$/,'')
    .replace(/[（(][^）)]*[）)]/g,'')
    .replace(/\bv\d+(\.\d+)?\b/g,'')
    .replace(/[\s\p{P}\p{S}]+/gu,'');
}
// Every name a work answers to: its folder, its titles, and the file names it came from.
export function workNames(folder,items){
  const names=new Set([path.basename(folder)]);
  for(const item of items){
    names.add(item.title);
    for(const alias of item.aliases||[]){
      const text=String(alias);
      if(text.startsWith('曲谱/'))continue;
      names.add(path.basename(text));
    }
  }
  return [...names].map(normalizeName).filter(name=>name.length>=3);
}
export function buildIndex(manifestFiles,items){
  const byFolder=new Map();
  for(const item of items){
    const file=manifestFiles[item.id];if(!file)continue;
    const folder=path.dirname(file);
    byFolder.set(folder,[...(byFolder.get(folder)||[]),item]);
  }
  const index=new Map();
  for(const [folder,group] of byFolder)
    for(const name of workNames(folder,group)){
      if(index.has(name)){if(index.get(name)!==folder)index.set(name,null);}  // a name two works answer to belongs to neither
      else index.set(name,folder);
    }
  return {index,byFolder};
}
// A source file offers two names: the folder it sits in, and its own stem.
export function matchSource(relative,{index}){
  const parts=relative.split('/'),stem=parts.at(-1);
  const candidates=[parts.at(-2),stem].filter(Boolean);
  for(const candidate of candidates){
    const name=normalizeName(candidate);
    if(name.length<3)continue;
    const folder=index.get(name);
    if(folder)return {folder,by:candidate===stem?'文件名':'文件夹名'};
  }
  // A source folder often carries an update note or a fuller subtitle than the score does.
  // One work containing the name — or contained by it — is still an answer; two is not.
  for(const candidate of candidates){
    const name=normalizeName(candidate);
    if(name.length<5)continue;
    const hits=new Set();
    for(const [key,folder] of index)
      if(folder&&key.length>=5&&(key.includes(name)||name.includes(key)))hits.add(folder);
    if(hits.size===1)return {folder:[...hits][0],by:'名称包含'};
  }
  return null;
}
export function sourcePlan(files,index){
  const matched=[],unmatched=[];
  for(const relative of files){
    if(!SOURCE_TYPES.includes(path.extname(relative).toLocaleLowerCase()))continue;
    const hit=matchSource(relative,index);
    if(hit)matched.push({relative,...hit,target:path.join(hit.folder,path.basename(relative))});
    else unmatched.push(relative);
  }
  return {matched,unmatched};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.resolve(import.meta.dirname,'..');
  const library=libraryRoot();
  const argument=name=>{const at=process.argv.indexOf(name);return at>=0?process.argv[at+1]:null;};
  const sources=path.resolve(argument('--from')||path.join(root,'相关源文件'));
  const apply=process.argv.includes('--apply');
  const catalog=JSON.parse(await fs.readFile(path.join(library,'catalog.json')));
  const manifest=JSON.parse(await fs.readFile(path.join(library,'manifest.json')));
  const walk=async folder=>{
    const out=[];
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){
      if(entry.name.startsWith('.'))continue;
      const full=path.join(folder,entry.name);
      if(entry.isDirectory())out.push(...await walk(full));else out.push(path.relative(sources,full).split(path.sep).join('/'));
    }
    return out;
  };
  const files=await walk(sources);
  const plan=sourcePlan(files,buildIndex(manifest.files||{},catalog.items));
  const byKind={};
  for(const move of plan.matched)byKind[path.extname(move.relative).toLowerCase()]=(byKind[path.extname(move.relative).toLowerCase()]||0)+1;
  console.log(`可归位 ${plan.matched.length} 份`,byKind);
  for(const move of plan.matched.slice(0,8))console.log(`  ${move.relative}\n     → ${move.target}（按${move.by}）`);
  console.log(`\n认不出的 ${plan.unmatched.length} 份：`);
  for(const relative of plan.unmatched.slice(0,20))console.log('  '+relative);
  if(plan.unmatched.length>20)console.log(`  …还有 ${plan.unmatched.length-20} 份`);
  if(!apply){console.log('\n这是预览。确认后加 --apply 执行（只移动，不删除，认不出的留在原处）。');process.exit(0);}
  let moved=0;
  for(const move of plan.matched){
    const from=path.join(sources,move.relative),to=path.join(library,move.target);
    if(!to.startsWith(path.join(library,'曲谱')+path.sep))continue;
    try{await fs.access(to);continue;}catch{}
    await fs.mkdir(path.dirname(to),{recursive:true});
    await fs.rename(from,to);moved++;
  }
  console.log(`已归位 ${moved} 份；认不出的 ${plan.unmatched.length} 份仍在 ${path.relative(root,sources)}/。`);
}
