import {libraryData} from './library-root.mjs';
// Byte-preserving local collection builder. Nothing is written under docs/.
import fs from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {groupWorks} from '../docs/library-model.js';
import {cleanComposer} from './retitle-scores.mjs';
import {regionFor} from './region-rules.mjs';
import {classifyLibraryItem,libraryRelativePath} from './library-paths.mjs';
const sourceDir=path.resolve(process.argv[2]||'../Score_Turner_Web/local_data');
// The builder creates the collection, so it names the place rather than finding it.
const output=path.resolve(import.meta.dirname,'../../本地曲谱');
const index=JSON.parse(await fs.readFile(path.join(sourceDir,'library-private-index.json')));
const imports=JSON.parse(await fs.readFile(path.join(sourceDir,'piascore-import-20260912/pdf-inspection.json')));
const overrides=JSON.parse(await fs.readFile(path.join(libraryData(output),'metadata.json')));
// Scores retired on purpose never come back through a rebuild.
let retired={items:{}};try{retired=JSON.parse(await fs.readFile(path.join(libraryData(output),'retired.json')));}catch{}
const isRetired=id=>Object.hasOwn(retired.items||{},id);
const digest=async file=>{const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');};
const candidates=new Map();
for(const item of index.items.filter(x=>x.format==='pdf'&&!isRetired(x.id))){
  const sources=[];for(const alias of item.aliases){const file=path.resolve(index.root,alias);if(!file.startsWith(index.root+path.sep))throw new Error('Invalid source path');const info=await fs.stat(file);sources.push({file,mtime:info.mtimeMs,original:alias});}
  candidates.set(item.id,{metadata:item,sources});
}
const oldCount=candidates.size;let newCount=0;
for(const imported of imports){
  const item=candidates.get(imported.sha256),source={file:path.join(sourceDir,'piascore-import-20260912/raw',imported.relative),mtime:imported.mtimeSeconds*1000,original:'Piascore/'+imported.relative};
  if(item){item.sources.push(source);continue;}
  const metadata=overrides[imported.sha256.slice(0,8)];if(!metadata)throw new Error('Unclassified imported PDF: '+imported.relative);
  candidates.set(imported.sha256,{metadata:{...metadata,id:imported.sha256,sourceId:imported.sha256,bytes:imported.size,format:'pdf',pages:imported.pages,aliases:[imported.relative],metadataStatus:'按原文件名、谱面标题及已有收藏分类核对；未确定的归属明确标记'},sources:[source]});newCount++;
}
const items=[],files={},audit=[];
for(const [id,entry] of candidates){
  const metadata={...entry.metadata,...(overrides[id.slice(0,8)]||{})};
  metadata.composer=cleanComposer(metadata.composer);
  if(metadata.composer==='原神'&&!metadata.region)metadata.region=regionFor(metadata.title,(metadata.aliases||[]).join(' '));
  const classification=classifyLibraryItem(metadata);metadata.title=classification.item.title;const work=classification.work;
  if(/待核对/.test(metadata.composer||'')&&!/待核对/.test(work.composer))metadata.composer=work.composer;
  const {browse,family}=classifyLibraryItem(metadata);
  if(family==='游戏音乐'){metadata.style='游戏音乐';if(!metadata.era||/待核对/.test(metadata.era))metadata.era='21 世纪';}
  if(family==='Animenz'){metadata.arranger='Animenz';metadata.style='动漫／影视';if(!metadata.era||/待核对/.test(metadata.era))metadata.era='21 世纪';}
  if(family==='流行音乐')metadata.style='流行音乐';
  const relative=libraryRelativePath(metadata).relative;
  const target=path.join(output,relative);const sources=[...new Map(entry.sources.map(x=>[x.file,x])).values()].sort((a,b)=>b.mtime-a.mtime);
  for(const source of sources)if(await digest(source.file)!==id)throw new Error('Source changed; stop before merging: '+source.original);
  await fs.mkdir(path.dirname(target),{recursive:true});
  try{await fs.copyFile(sources[0].file,target,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
  if(await digest(target)!==id)throw new Error('Copy verification failed: '+relative);
  await fs.utimes(target,new Date(sources[0].mtime),new Date(sources[0].mtime));
  const {absolute,localStat,localStatus,metadataEvidence,...safe}=metadata;
  items.push({...safe,available:true,collection:'本地合并谱库',category:browse,aliases:[relative,...sources.map(s=>path.basename(s.original))],modifiedAt:new Date(sources[0].mtime).toISOString()});
  files[id]=relative;audit.push({id,target:relative,selectedSource:sources[0],sources});
  if(items.length%100===0)console.log(`已分类并校验 ${items.length} 份 PDF`);
}
const works=groupWorks(items),summary={pdfs:items.length,unique:items.length,pending:0,works:works.length,existing:oldCount,added:newCount,piascoreCopies:imports.length,piascoreUnique:new Set(imports.map(x=>x.sha256)).size,bytes:items.reduce((sum,x)=>sum+x.bytes,0)};
const catalog={version:1,localLibrary:true,publicLibrary:false,updatedAt:new Date().toISOString(),summary,items};
await fs.mkdir(libraryData(output),{recursive:true});
await fs.writeFile(path.join(libraryData(output),'catalog.json'),JSON.stringify(catalog,null,2));
await fs.writeFile(path.join(libraryData(output),'manifest.json'),JSON.stringify({version:1,files},null,2));
await fs.writeFile(path.join(libraryData(output),'merge-audit.json'),JSON.stringify({summary,audit},null,2));
console.log(JSON.stringify(summary));
