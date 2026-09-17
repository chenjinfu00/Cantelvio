import {validateInk} from './ink-validation.js';
export function parseBackup(value){
  let pages;
  if(value?.format==='volta-annotations'&&value.version===1)pages=value.pages;
  else if(value?.version===1&&typeof value.scoreId==='string'&&value.pages)pages=Object.entries(value.pages).map(([page,data])=>({id:value.scoreId+'/'+page,data}));
  if(!Array.isArray(pages)||pages.length>20000)throw Error('不是有效的 Volta 批注备份。');
  const keys=new Set();
  for(const row of pages){if(!/^[a-f0-9]{64}\/[1-9][0-9]{0,4}$/.test(row?.id)||keys.has(row.id)||!validateInk(row.data))throw Error('批注备份格式不完整，未导入。');keys.add(row.id);}
  return pages;
}
export function mergeBackup(rows,incoming){
  const existing=new Map(rows.map(row=>[row.id,row]));
  return incoming.map(({id,data})=>{
    const previous=existing.get(id),strokes=new Map((previous?.data.strokes||[]).map(stroke=>[stroke.id,stroke]));
    for(const stroke of data.strokes){
      if(strokes.has(stroke.id)&&JSON.stringify(strokes.get(stroke.id))!==JSON.stringify(stroke))throw Error('同一笔迹存在不同版本，已取消导入以保护原批注。');
      strokes.set(stroke.id,stroke);
    }
    const merged={version:1,strokes:[...strokes.values()]};if(!validateInk(merged))throw Error('单页批注过大，未导入。');
    return {id,data:merged,base:previous?.base||{version:1,strokes:[]},etag:previous?.etag||'"local"',dirty:true};
  });
}
// Settle every stroke still in flight, so what is synchronized or written is what is on screen.
export async function drainInk(ink){
  for(const view of ink.views)view.finish?.();
  for(const record of ink.records.values()){clearTimeout(record.timer);await ink.flush(record);if(record.dirty)throw Error('请先确保批注已保存，再同步。');}
}
// Put merged pages back into the open score so the reader sees them without reopening.
export async function showMerged(ink,merged){
  for(const row of merged){
    const record=ink.records.get(row.id);
    if(!record)continue;
    record.data=structuredClone(row.data);record.base=structuredClone(row.base);
    record.dirty=true;record.undo=[];record.redo=[];record.revision++;
    ink.draw(record);await ink.flush(record);
  }
}
