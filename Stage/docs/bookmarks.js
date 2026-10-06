// Pages you keep coming back to: a movement's start, a hard passage, the coda.
import {loadBookmarks,saveBookmarks} from './storage.js';
export const BOOKMARK_KEY='volta:bookmarks:v1',BOOKMARK_LIMIT=40;
const $=id=>document.getElementById(id);
const defaultStorage=()=>{try{return globalThis.localStorage||null;}catch{return null;}};

export function addBookmark(list,page,label='',{limit=BOOKMARK_LIMIT,at=Date.now()}={}){
  const number=Math.max(1,Math.round(Number(page)||1));
  const name=String(label||'').trim().slice(0,24);
  const rest=(Array.isArray(list)?list:[]).filter(item=>item&&item.page!==number);
  if(rest.length>=limit)return sortBookmarks(rest);
  return sortBookmarks([...rest,{page:number,label:name,at}]);
}
export function removeBookmark(list,page){
  return sortBookmarks((Array.isArray(list)?list:[]).filter(item=>item&&item.page!==Math.round(Number(page))));
}
export const sortBookmarks=list=>(Array.isArray(list)?list:[])
  .filter(item=>item&&Number.isFinite(item.page)&&item.page>=1)
  .map(item=>({page:Math.round(item.page),label:String(item.label||'').slice(0,24),at:Number(item.at)||0}))
  .sort((a,b)=>a.page-b.page);
export const bookmarkName=item=>item.label?`${item.page} · ${item.label}`:`第 ${item.page} 页`;

export function readAll(storage=defaultStorage()){
  if(!storage)return {};
  try{const saved=JSON.parse(storage.getItem(BOOKMARK_KEY));return saved&&typeof saved==='object'&&!Array.isArray(saved)?saved:{};}catch{return {};}
}
export function readBookmarks(scoreId,storage=defaultStorage()){return sortBookmarks(readAll(storage)[scoreId]);}
export function writeBookmarks(scoreId,list,storage=defaultStorage()){
  if(!scoreId||!storage)return;
  const all=readAll(storage);
  if(list.length)all[scoreId]=list;else delete all[scoreId];
  try{storage.setItem(BOOKMARK_KEY,JSON.stringify(all));}catch{}
}

export function setupBookmarks({score=()=>null,page=()=>1,jump=()=>{},canJump=()=>true,storage=defaultStorage(),toast=()=>{}}={}){
  const bar=$('bookmark-bar'),list=$('bookmark-list'),label=$('bookmark-label'),add=$('bookmark-add');
  if(!bar)return null;
  let items=[],id=null,loadToken=0;
  const persist=(scoreId,value)=>{
    writeBookmarks(scoreId,value,storage);
    saveBookmarks(scoreId,value).catch(()=>toast('书签保存失败，但当前页面仍可使用。'));
  };
  function render(){
    add.disabled=!id;label.disabled=!id;
    add.textContent=id?`收藏第 ${page()} 页`:'收藏本页';
    list.textContent='';
    if(!items.length){
      const empty=document.createElement('p');empty.className='muted';
      empty.textContent=id?'暂无书签':'打开曲谱后可用';
      list.append(empty);return;
    }
    for(const item of items){
      const chip=document.createElement('span');chip.className='bookmark'+(item.page===page()?' current':'');
      const go=document.createElement('button');go.type='button';go.className='bookmark-go';go.textContent=bookmarkName(item);
      go.title=`跳到第 ${item.page} 页`;
      go.onclick=()=>{if(canJump())jump(item.page);};
      const remove=document.createElement('button');remove.type='button';remove.className='bookmark-remove';
      remove.textContent='✕';remove.ariaLabel=`删除书签 ${bookmarkName(item)}`;
      remove.onclick=()=>{items=removeBookmark(items,item.page);persist(id,items);render();};
      chip.append(go,remove);list.append(chip);
    }
  }
  add.onclick=()=>{
    if(!id)return;
    const before=items.length;
    items=addBookmark(items,page(),label.value);
    if(items.length===before&&!items.some(item=>item.page===page()))return toast(`书签最多 ${BOOKMARK_LIMIT} 个，先删掉一些。`);
    persist(id,items);label.value='';render();
  };
  label.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();add.click();}};
  render();
  return {
    setScore(score){
      id=score?.id||null;const scoreId=id,token=++loadToken;
      items=id?readBookmarks(id,storage):[];render();
      if(!id)return Promise.resolve();
      return loadBookmarks(id).then(saved=>{
        if(token!==loadToken||scoreId!==id)return;
        if(Array.isArray(saved))items=sortBookmarks(saved);
        else if(items.length)saveBookmarks(id,items).catch(()=>{});
        render();
      }).catch(()=>{});
    },
    refresh:render,
    get items(){return items;},
  };
}
