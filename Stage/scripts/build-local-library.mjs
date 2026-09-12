// Byte-preserving local collection builder. Nothing is written under docs/.
import fs from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {describeWork,groupWorks,versionDisplayTitle} from '../docs/library-model.js';
const sourceDir=path.resolve(process.argv[2]||'../Score_Turner_Web/local_data');
const output=path.resolve(import.meta.dirname,'../.local-library');
const index=JSON.parse(await fs.readFile(path.join(sourceDir,'library-private-index.json')));
const imports=JSON.parse(await fs.readFile(path.join(sourceDir,'piascore-import-20260912/pdf-inspection.json')));
const overrides=JSON.parse(await fs.readFile(path.join(output,'metadata.json')));
const digest=async file=>{const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');};
function segment(value){let s=String(value||'待核对').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim();while(Buffer.byteLength(s)>170)s=[...s].slice(0,-1).join('');return s||'待核对';}
const candidates=new Map();
for(const item of index.items.filter(x=>x.format==='pdf')){
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
  metadata.title=versionDisplayTitle(metadata);const work=describeWork(metadata);
  if(/待核对/.test(metadata.composer||'')&&!/待核对/.test(work.composer))metadata.composer=work.composer;
  const browse=groupWorks([metadata])[0].browseGroup;
  const family=/^(原神|崩坏3|崩坏：星穹铁道|鸣潮|王者荣耀)$/.test(browse)?'游戏音乐':browse==='Animenz'?'Animenz':browse==='动漫'?'动漫':browse==='流行音乐'?'流行音乐':/待核对/.test(browse)?'待核对':'古典与器乐';
  if(family==='游戏音乐'){metadata.style='游戏音乐';if(!metadata.era||/待核对/.test(metadata.era))metadata.era='21 世纪';}
  if(family==='Animenz'){metadata.arranger='Animenz';metadata.style='动漫／影视';if(!metadata.era||/待核对/.test(metadata.era))metadata.era='21 世纪';}
  if(family==='流行音乐')metadata.style='流行音乐';
  const relative=path.join('曲谱',family,...(family===browse?[]:[segment(browse)]),segment(work.genre),segment(metadata.title)+' · '+id.slice(0,8)+'.pdf');
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
await fs.writeFile(path.join(output,'catalog.json'),JSON.stringify(catalog,null,2));
await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify({version:1,files},null,2));
await fs.writeFile(path.join(output,'merge-audit.json'),JSON.stringify({summary,audit},null,2));
console.log(JSON.stringify(summary));
