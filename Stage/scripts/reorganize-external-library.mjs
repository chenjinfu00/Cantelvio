// Apply Volta's private-library layout to an external score folder.
// The default run is a preview. --apply moves files only after a complete preflight.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const PDF='.pdf';
const METADATA='.整理元数据';
const RECORDS='整理记录';
const RELATED='相关源文件';
const DUPLICATES='重复文件待确认';
const IMPORTS='新导入 PDF';

const digest=async file=>{
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
};

const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const portable=relative=>relative.split(path.sep).join('/');
const native=relative=>relative.split('/').join(path.sep);

function cleanImportName(relative){
  const parts=relative.split('/');
  parts[parts.length-1]=parts.at(-1)
    .replace(/\s*[（(]\s*CN\s*[）)](?=\.pdf$)/i,'')
    .replace(/\s+(?=\.pdf$)/,'');
  return parts.join('/');
}

function flatPdfTarget(folder,record,hash,index=0){
  const parts=record.relative.split('/');
  if(parts.length===2&&parts[0]===folder)return record.relative;
  const cleaned=path.posix.basename(cleanImportName(record.relative));
  const extension=path.posix.extname(cleaned),stem=cleaned.slice(0,-extension.length);
  const copy=index?`-${index+1}`:'';
  return `${folder}/${stem} · ${hash.slice(0,8)}${copy}${extension}`;
}

function canonicalTarget(manifestPath){
  const relative=portable(manifestPath);
  if(!relative.startsWith('曲谱/'))throw new Error('Manifest path is outside 曲谱: '+manifestPath);
  return relative.slice('曲谱/'.length);
}

function sourceTarget(relative){
  if(relative.startsWith(RELATED+'/')||relative.startsWith(METADATA+'/'))return relative;
  if(path.posix.basename(relative)==='.DS_Store')return `${METADATA}/${relative}`;
  return `${RELATED}/${relative}`;
}

function preferredRecord(records,target){
  return [...records].sort((a,b)=>{
    if(a.relative===target)return -1;
    if(b.relative===target)return 1;
    const depth=a.relative.split('/').length-b.relative.split('/').length;
    return depth||a.relative.length-b.relative.length||a.relative.localeCompare(b.relative,'zh-CN');
  })[0];
}

export function createExternalPlan(records,manifestFiles){
  const pdfs=records.filter(record=>record.extension===PDF);
  const others=records.filter(record=>record.extension!==PDF&&!record.relative.startsWith(RECORDS+'/'));
  const groups=new Map();
  for(const record of pdfs){
    if(!record.hash)throw new Error('PDF has no SHA-256 hash: '+record.relative);
    if(!groups.has(record.hash))groups.set(record.hash,[]);
    groups.get(record.hash).push(record);
  }

  const moves=[];
  const add=(record,target,kind)=>{
    if(record.relative!==target)moves.push({...record,target,kind});
  };
  let matchedUnique=0,matchedCopies=0,unmatchedUnique=0,duplicateCopies=0;

  for(const [hash,copies] of groups){
    const manifestPath=manifestFiles[hash];
    if(manifestPath){
      matchedUnique++;matchedCopies+=copies.length;
      const target=canonicalTarget(manifestPath),keeper=preferredRecord(copies,target);
      add(keeper,target,'known-pdf');
      let duplicateIndex=0;
      for(const copy of copies)if(copy!==keeper){
        duplicateCopies++;
        const duplicateTarget=flatPdfTarget(DUPLICATES,copy,hash,duplicateIndex++);
        add(copy,duplicateTarget,'duplicate-pdf');
      }
    }else{
      unmatchedUnique++;
      for(const [index,copy] of copies.entries()){
        const importTarget=flatPdfTarget(IMPORTS,copy,hash,index);
        add(copy,importTarget,'new-pdf');
      }
    }
  }

  for(const record of others)add(record,sourceTarget(record.relative),'related-source');

  const targets=new Map();
  for(const move of moves){
    const previous=targets.get(move.target);
    if(previous)throw new Error(`Target collision: ${previous.relative} and ${move.relative} -> ${move.target}`);
    targets.set(move.target,move);
  }

  return {
    moves,
    summary:{
      files:records.length,
      pdfCopies:pdfs.length,
      uniquePdfHashes:groups.size,
      matchedCopies,
      matchedUnique,
      unmatchedCopies:pdfs.length-matchedCopies,
      unmatchedUnique,
      duplicateCopies,
      relatedSources:others.length,
      unchanged:records.length-moves.length,
      moves:moves.length
    }
  };
}

async function walk(root,folder=root){
  const files=[];
  for(const entry of await fs.readdir(folder,{withFileTypes:true})){
    // Finder and iCloud may recreate these immediately after a move. They are
    // directory cache files, not library content, so repeated runs ignore them.
    if(entry.name==='.DS_Store')continue;
    const full=path.join(folder,entry.name),relative=portable(path.relative(root,full));
    if(entry.isDirectory()){
      if(relative===RECORDS)continue;
      files.push(...await walk(root,full));
    }else files.push({relative,extension:path.extname(entry.name).toLowerCase(),bytes:(await fs.stat(full)).size});
  }
  return files;
}

export async function scanExternalLibrary(root,{onProgress=()=>{}}={}){
  const records=await walk(root),pdfs=records.filter(record=>record.extension===PDF);
  for(let index=0;index<pdfs.length;index++){
    pdfs[index].hash=await digest(path.join(root,native(pdfs[index].relative)));
    if((index+1)%100===0||index+1===pdfs.length)onProgress(index+1,pdfs.length);
  }
  return records;
}

async function preflight(root,moves){
  for(const move of moves){
    const source=path.resolve(root,native(move.relative)),target=path.resolve(root,native(move.target));
    if(!inside(root,source)||!inside(root,target))throw new Error('Unsafe path: '+move.relative);
    const sourceStat=await fs.stat(source);
    if(!sourceStat.isFile()||sourceStat.size!==move.bytes)throw new Error('Source changed: '+move.relative);
    if(move.hash&&await digest(source)!==move.hash)throw new Error('Source hash changed: '+move.relative);
    try{await fs.access(target);throw new Error('Target already exists: '+move.target);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}

async function pruneEmpty(folder,keep){
  for(const entry of await fs.readdir(folder,{withFileTypes:true}))if(entry.isDirectory())await pruneEmpty(path.join(folder,entry.name),keep);
  if(folder!==keep&&!(await fs.readdir(folder)).length)await fs.rmdir(folder);
}

export async function applyExternalPlan(root,plan){
  await preflight(root,plan.moves);
  for(const move of plan.moves){
    const source=path.join(root,native(move.relative)),target=path.join(root,native(move.target));
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.rename(source,target);
    if((await fs.stat(target)).size!==move.bytes)throw new Error('Moved file size mismatch: '+move.target);
  }
  await pruneEmpty(root,root);
  const completedAt=new Date().toISOString(),stamp=completedAt.replace(/[:.]/g,'-');
  const record={version:1,completedAt,root,summary:plan.summary,moves:plan.moves.map(({relative,target,kind,bytes,hash})=>({source:relative,target,kind,bytes,hash:hash||null}))};
  const recordPath=path.join(root,RECORDS,`${stamp}.json`);
  await fs.mkdir(path.dirname(recordPath),{recursive:true});
  await fs.writeFile(recordPath,JSON.stringify(record,null,2));
  return recordPath;
}

function argument(name){
  const index=process.argv.indexOf(name);
  return index<0?null:process.argv[index+1];
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const rootArgument=argument('--root');
  if(!rootArgument)throw new Error('Usage: node scripts/reorganize-external-library.mjs --root /path/to/曲谱 [--apply]');
  const root=path.resolve(rootArgument),apply=process.argv.includes('--apply');
  const manifest=JSON.parse(await fs.readFile(path.resolve(import.meta.dirname,'../本地曲谱/manifest.json'),'utf8'));
  const records=await scanExternalLibrary(root,{onProgress:(done,total)=>console.error(`已核对 ${done}/${total} 份 PDF`)});
  const plan=createExternalPlan(records,manifest.files||{});
  console.log(JSON.stringify(plan.summary,null,2));
  const byKind={};
  for(const move of plan.moves)byKind[move.kind]=(byKind[move.kind]||0)+1;
  console.log(byKind);
  if(!apply){console.log('这是预览。确认后加 --apply 执行。');process.exit(0);}
  const recordPath=await applyExternalPlan(root,plan);
  console.log(`已整理 ${plan.moves.length} 个文件；记录：${recordPath}`);
}
