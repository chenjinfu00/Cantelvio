// The shelf keeps the scores you actually played within reach.
export const RECENT_KEY='volta:recent:v1',RECENT_LIMIT=10;
const $=id=>document.getElementById(id);

export function rememberScore(list,entry,limit=RECENT_LIMIT){
  const kept=(Array.isArray(list)?list:[]).filter(item=>item&&typeof item.id==='string');
  if(!entry||typeof entry.id!=='string'||!entry.id)return kept.slice(0,limit);
  const name=String(entry.name||'').replace(/\.pdf$/i,'').trim()||'未命名曲谱';
  return [{id:entry.id,name,at:Number.isFinite(entry.at)?entry.at:Date.now()},...kept.filter(item=>item.id!==entry.id)].slice(0,limit);
}
export function readRecent(storage=localStorage){
  try{const saved=JSON.parse(storage.getItem(RECENT_KEY));return Array.isArray(saved)?saved.filter(item=>item&&typeof item.id==='string').slice(0,RECENT_LIMIT):[];}catch{return [];}
}
export function writeRecent(list,storage=localStorage){try{storage.setItem(RECENT_KEY,JSON.stringify(list));}catch{}}

// Relative time reads faster than a date when the list is about what you just played.
export function whenLabel(at,now=Date.now()){
  const minutes=Math.floor((now-at)/60000);
  if(!Number.isFinite(minutes)||minutes<0)return '';
  if(minutes<1)return '刚刚';
  if(minutes<60)return minutes+' 分钟前';
  const hours=Math.floor(minutes/60);if(hours<24)return hours+' 小时前';
  const days=Math.floor(hours/24);return days<30?days+' 天前':Math.floor(days/30)+' 个月前';
}

export function setupRecentScores({open,canOpen=()=>true,onError=()=>{},storage=localStorage,now=()=>Date.now()}={}){
  const section=$('recent-scores'),list=$('recent-list');
  let items=readRecent(storage),busy=false;
  function render(){
    if(!section||!list)return;
    section.hidden=!items.length;list.textContent='';
    for(const item of items){
      const button=document.createElement('button');
      button.type='button';button.className='recent-item';button.title=item.name;
      const name=document.createElement('span');name.className='recent-name';name.textContent=item.name;
      const when=document.createElement('small');when.textContent=whenLabel(item.at,now());
      button.append(name,when);
      button.onclick=async()=>{
        if(busy||!canOpen())return;
        busy=true;button.disabled=true;
        try{await open(item.id,item);}
        catch(error){onError(error,item);}
        finally{busy=false;button.disabled=false;}
      };
      list.append(button);
    }
  }
  render();
  return {
    get items(){return items;},
    remember(entry){items=rememberScore(items,{...entry,at:now()});writeRecent(items,storage);render();},
    forget(id){items=items.filter(item=>item.id!==id);writeRecent(items,storage);render();},
    render,
  };
}
