// Record the MIDI and engraving files sitting in each work's folder, so the reader can offer them.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {libraryRoot,libraryData} from './library-root.mjs';

export const PLAYABLE=new Set(['.mid','.midi']);
export const KEEPABLE=new Set([...PLAYABLE,'.sib','.mscz','.musicxml','.mxl','.xml']);
export const sourceKind=name=>PLAYABLE.has(path.extname(name).toLowerCase())?'midi':'engraving';

// Every version in a folder answers with the same sources: they belong to the work, not the print.
export function indexSources(items,files,folderFiles){
  const changed=[];
  for(const item of items){
    const file=files[item.id];if(!file)continue;
    const names=(folderFiles.get(path.dirname(file))||[]).filter(name=>KEEPABLE.has(path.extname(name).toLowerCase()));
    const sources=names.sort((a,b)=>a.localeCompare(b,'zh-CN')).map(name=>({name,kind:sourceKind(name)}));
    const before=JSON.stringify(item.sources||[]);
    if(before!==JSON.stringify(sources))changed.push({id:item.id,title:item.title,sources});
  }
  return changed;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const library=libraryRoot(),apply=process.argv.includes('--apply');
  const catalog=JSON.parse(await fs.readFile(path.join(libraryData(library),'catalog.json')));
  const manifest=JSON.parse(await fs.readFile(path.join(libraryData(library),'manifest.json')));
  const folders=new Map();
  for(const file of Object.values(manifest.files||{})){
    const folder=path.dirname(file);
    if(folders.has(folder))continue;
    folders.set(folder,(await fs.readdir(path.join(library,folder))).filter(name=>!name.startsWith('.')));
  }
  const changed=indexSources(catalog.items,manifest.files||{},folders);
  const midi=changed.filter(change=>change.sources.some(source=>source.kind==='midi'));
  console.log(`${changed.length} 份曲谱的源文件记录有变化，其中 ${midi.length} 份带 MIDI。`);
  for(const change of changed.slice(0,6))console.log(`  ${change.title}: ${change.sources.map(s=>s.name).join(' · ')||'（已清空）'}`);
  if(!apply){console.log('这是预览。确认后加 --apply 执行。');process.exit(0);}
  const byId=new Map(catalog.items.map(item=>[item.id,item]));
  for(const change of changed){
    const item=byId.get(change.id);
    if(change.sources.length)item.sources=change.sources;else delete item.sources;
  }
  catalog.updatedAt=new Date().toISOString();
  await fs.writeFile(path.join(libraryData(library),'catalog.json'),JSON.stringify(catalog,null,2));
  console.log('目录已更新。');
}
