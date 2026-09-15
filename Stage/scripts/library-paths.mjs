import path from 'node:path';
import {describeWork,groupWorks,versionDisplayTitle} from '../docs/library-model.js';

export function segment(value){
  let result=String(value||'待核对').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim();
  while(Buffer.byteLength(result)>170)result=[...result].slice(0,-1).join('');
  return result||'待核对';
}

export function classifyLibraryItem(item){
  // Generated paths describe the previous layout, not the music. Keeping them in the
  // classifier makes an old folder name feed back into the next folder name.
  const sourceAliases=(item.aliases||[]).filter(alias=>!String(alias).startsWith('曲谱/'));
  const normalized={...item,aliases:sourceAliases,title:versionDisplayTitle({...item,aliases:sourceAliases})};
  const work=describeWork(normalized),browse=groupWorks([normalized])[0].browseGroup;
  const family=/^(原神|崩坏3|崩坏：星穹铁道|鸣潮)$/.test(browse)?'游戏音乐'
    :browse==='Animenz'?'Animenz'
    :browse==='动漫'?'动漫'
    :browse==='流行音乐'?'流行音乐'
    :/待核对/.test(browse)?'待核对':'古典与器乐';
  return {item:normalized,work,browse,family};
}

export function libraryRelativePath(item,{current=null}={}){
  const classified=classifyLibraryItem(item);
  const {family,browse,work}=classified;
  // Some manually curated genres are not present in the filename itself. Preserve that
  // useful decision when the automatic model can only say "其他作品".
  if(current&&work.genre==='其他作品'){
    const previous=path.dirname(current).split(path.sep).at(-1);
    if(previous&&previous!=='其他作品'&&previous!==family&&previous!==browse)work.genre=previous;
  }
  const folders=['曲谱',family];
  const redundantBrowse=family==='待核对'&&browse==='作曲家待核对';
  if(family!==browse&&!redundantBrowse)folders.push(segment(browse));
  // A folder should add information. These labels merely repeat their parent
  // category and otherwise force every score one click deeper.
  const redundantGenre=new Set(['游戏配乐','其他作品','流行歌曲','作曲家待核对']);
  const animeRepeatsParent=family==='动漫'&&work.genre==='动漫／影视';
  if(!redundantGenre.has(work.genre)&&!animeRepeatsParent)folders.push(segment(work.genre));
  folders.push(segment(classified.item.title)+' · '+item.id.slice(0,8)+'.pdf');
  return {relative:path.join(...folders),...classified};
}

export function replaceLibraryAlias(aliases,relative){
  return [relative,...(aliases||[]).filter(alias=>!String(alias).startsWith('曲谱/'))];
}
