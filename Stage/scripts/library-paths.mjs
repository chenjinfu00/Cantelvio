import path from 'node:path';
import {describeWork,groupWorks,versionDisplayTitle} from '../docs/library-model.js';

export function segment(value){
  let result=String(value||'待核对').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim();
  while(Buffer.byteLength(result)>170)result=[...result].slice(0,-1).join('');
  return result||'待核对';
}

// A generated path always ends in the score's own fingerprint, which is how it can still be told
// apart from a name the file actually arrived with now that the shelves sit at the top.
export const generatedAlias=(alias,id)=>{
  const text=String(alias||'');
  return text.startsWith('曲谱/')||(!!id&&text.endsWith(' · '+String(id).slice(0,8)+'.pdf'));
};

export function classifyLibraryItem(item){
  // Generated paths describe the previous layout, not the music. Keeping them in the
  // classifier makes an old folder name feed back into the next folder name.
  const sourceAliases=(item.aliases||[]).filter(alias=>!generatedAlias(alias,item.id));
  const normalized={...item,aliases:sourceAliases,title:versionDisplayTitle({...item,aliases:sourceAliases})};
  const work=describeWork(normalized),browse=groupWorks([normalized])[0].browseGroup;
  const family=/^(原神|崩坏3|崩坏：星穹铁道|鸣潮)$/.test(browse)?'游戏音乐'
    :browse==='Animenz'?'Animenz'
    :browse==='动漫'?'动漫'
    :browse==='流行音乐'?'流行音乐'
    :/待核对/.test(browse)?'待核对':'古典与器乐';
  return {item:normalized,work,browse,family};
}

export function libraryRelativePath(item,{current=null,shelfWorks=Infinity}={}){
  const classified=classifyLibraryItem(item);
  const {family,browse,work}=classified;
  // Some manually curated genres are not present in the filename itself. Preserve that
  // useful decision when the automatic model can only say "其他作品".
  if(current&&work.genre==='其他作品'){
    // The curated genre sits above the work folder in the new layout and one level up in the old one.
    const parts=path.dirname(current).split(path.sep);
    const previous=[parts.at(-1),parts.at(-2)].find(name=>
      name&&![segment(work.title),'其他作品',family,browse,'曲谱','.'].includes(name));
    if(previous)work.genre=previous;
  }
  // The folders are the shelf the app shows: browse group, then the level you drill into.
  // A 游戏音乐／古典与器乐 layer would exist only on disk, so it is not one, and neither is a
  // 曲谱 layer wrapping the lot: opening the collection should land on the shelves themselves.
  const folders=[segment(browse)];
  // A folder should add information. These labels merely repeat their parent
  // category and otherwise force every score one click deeper.
  const redundantGenre=new Set(['游戏配乐','其他作品','流行歌曲','作曲家待核对']);
  const animeRepeatsParent=browse==='动漫'&&work.genre==='动漫／影视';
  // A shelf holding two or three works is already a short list; sorting it by genre only buries it.
  const tinyShelf=shelfWorks<=3;
  if(!redundantGenre.has(work.genre)&&!animeRepeatsParent&&!tinyShelf)folders.push(segment(work.genre));
  // One folder per work: every edition of it, plus its MIDI and engraving sources, live together.
  folders.push(segment(work.title));
  // A lone edition label that only repeats the shelf ("编曲：Animenz" under Animenz) says nothing.
  const blank=!work.edition||work.edition==='未标注版本'||work.edition==='编曲：'+browse;
  const label=blank?work.title:work.edition;
  folders.push(segment(label)+' · '+item.id.slice(0,8)+'.pdf');
  return {relative:path.join(...folders),...classified};
}

export function replaceLibraryAlias(aliases,relative){
  const id=String(relative||'').slice(-12,-4);
  return [relative,...(aliases||[]).filter(alias=>alias!==relative&&!generatedAlias(alias,id))];
}
