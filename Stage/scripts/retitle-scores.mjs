// Tidy the titles a download left behind, keeping every file's identity: the id is the file's
// SHA-256 and never changes here. Only names, the composer suffix and the path on disk move.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Leftovers from downloading the same file twice, or from a copy in Finder.
export function cleanTitle(title){
  let value=String(title||'');
  value=value.replace(/\s*[·・]\s*副本\s*\d+/g,'');
  // Only a small counter is a download leftover; a year in brackets tells two pieces apart.
  value=value.replace(/[（(]\s*(?:原编号\s*)?\d{1,2}\s*[）)]/g,'');
  value=value.replace(/\s*[（(]\s*CN\s*[）)]/gi,'');
  value=value.replace(/[（(]\s*[）)]/g,'');
  // A full-width bracket carries its own spacing in Chinese typesetting.
  return value.replace(/\s{2,}/g,' ').replace(/\s+([·，,（])/g,'$1').trim();
}
// The bracketed role belongs to the metadata, not to the name on the shelf.
export function cleanComposer(composer){
  return String(composer||'').replace(/[（(](?:编曲|原作|改编)[）)]/g,'').trim();
}
export function retitlePlan(items,{overrides={}}={}){
  const changes=[];
  for(const item of items){
    const title=overrides[item.id]??overrides[item.id.slice(0,8)]??cleanTitle(item.title);
    const composer=cleanComposer(item.composer);
    if(title!==item.title||composer!==item.composer)
      changes.push({id:item.id,from:item.title,to:title,composerFrom:item.composer,composerTo:composer});
  }
  return changes;
}
export function renamedPath(current,fromTitle,toTitle){
  if(!current||fromTitle===toTitle)return current;
  const directory=path.dirname(current),file=path.basename(current);
  if(!file.startsWith(fromTitle))return current;
  return path.join(directory,toTitle+file.slice(fromTitle.length));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.resolve(import.meta.dirname,'../.local-library');
  const args=process.argv.slice(2),apply=args.includes('--apply');
  const overrides={};
  for(const pair of args.filter(value=>value.startsWith('--set='))){
    const [id,...rest]=pair.slice('--set='.length).split('=');overrides[id]=rest.join('=');
  }
  const catalog=JSON.parse(await fs.readFile(path.join(root,'catalog.json')));
  const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json')));
  const changes=retitlePlan(catalog.items,{overrides});
  const titles=changes.filter(change=>change.from!==change.to);
  for(const change of titles)console.log(`  ${change.id.slice(0,8)}  ${change.from}\n        → ${change.to}`);
  const composers=new Map();
  for(const change of changes)if(change.composerFrom!==change.composerTo)composers.set(change.composerFrom,change.composerTo);
  for(const [from,to] of composers)console.log(`  作曲家 ${from} → ${to}`);
  console.log(`${titles.length} 处标题、${composers.size} 个作曲家名`);
  if(!apply){console.log('这是预览。确认后加 --apply 执行。');process.exit(0);}
  const byId=new Map(catalog.items.map(item=>[item.id,item]));
  for(const change of changes){
    const item=byId.get(change.id);
    if(change.from!==change.to){
      const current=manifest.files[item.id],next=renamedPath(current,change.from,change.to);
      if(current&&next!==current){
        await fs.mkdir(path.dirname(path.join(root,next)),{recursive:true});
        await fs.rename(path.join(root,current),path.join(root,next)).catch(error=>{if(error.code!=='ENOENT')throw error;});
        manifest.files[item.id]=next;
        item.aliases=[next,change.to+'.pdf'];
      }
      item.title=change.to;
    }
    item.composer=change.composerTo;
  }
  catalog.updatedAt=new Date().toISOString();
  await fs.writeFile(path.join(root,'catalog.json'),JSON.stringify(catalog,null,2));
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2));
  console.log('已完成。重新运行 scripts/upload-private-library.mjs 后，app 里的名字会跟着更新。');
}
