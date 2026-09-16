// Give every Genshin score the part of Teyvat it comes from, so the shelf can be browsed by region.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {regionFor,REGIONS} from './region-rules.mjs';
import {libraryRoot} from './library-root.mjs';

export function regionPlan(items,{overrides={},composer='原神'}={}){
  const changes=[],undecided=[];
  for(const item of items){
    if(item.composer!==composer)continue;
    const manual=overrides[item.id]??overrides[item.id.slice(0,8)];
    const region=manual??regionFor(item.title,(item.aliases||[]).join(' '));
    if(!region){undecided.push(item);continue;}
    if(!REGIONS.includes(region))throw new Error('未知地区: '+region);
    if(item.region!==region)changes.push({id:item.id,title:item.title,region});
  }
  return {changes,undecided};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=libraryRoot();
  const args=process.argv.slice(2),apply=args.includes('--apply');
  const overrides={};
  for(const pair of args.filter(value=>value.startsWith('--set='))){
    const [id,...rest]=pair.slice('--set='.length).split('=');overrides[id]=rest.join('=');
  }
  const catalog=JSON.parse(await fs.readFile(path.join(root,'catalog.json')));
  const {changes,undecided}=regionPlan(catalog.items,{overrides});
  const counts={};for(const change of changes)counts[change.region]=(counts[change.region]||0)+1;
  for(const [region,count] of Object.entries(counts).sort((a,b)=>b[1]-a[1]))console.log(`  ${region}: ${count} 份`);
  if(undecided.length){console.log(`\n待定 ${undecided.length} 份：`);for(const item of undecided)console.log(`  ${item.id.slice(0,8)}  ${item.title}`);}
  if(!apply){console.log('\n这是预览。确认后加 --apply 执行。');process.exit(0);}
  const byId=new Map(catalog.items.map(item=>[item.id,item]));
  for(const change of changes)byId.get(change.id).region=change.region;
  catalog.updatedAt=new Date().toISOString();
  await fs.writeFile(path.join(root,'catalog.json'),JSON.stringify(catalog,null,2));
  console.log(`已写入 ${changes.length} 份的地区。`);
}
