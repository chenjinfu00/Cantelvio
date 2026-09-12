import {allInkDrafts,saveInkDrafts} from './storage.js';
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
export function exportBackupRows(rows){
  const pages=rows.map(({id,data})=>({id,data})).filter(row=>row.data?.strokes?.length);
  const value={format:'volta-annotations',version:1,createdAt:new Date().toISOString(),pages};
  const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='volta-all-annotations-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  return pages.length;
}
export function setupAnnotationBackup(ink,toast,canRun){
  const $=id=>document.getElementById(id);let busy=false;
  async function drain(){for(const view of ink.views)view.finish?.();for(const record of ink.records.values()){clearTimeout(record.timer);await ink.flush(record);if(record.dirty)throw Error('请先确保批注已保存，再导出或导入。');}}
  $('backup-export').onclick=async()=>{
    if(busy||!canRun())return;busy=true;
    try{await drain();const count=exportBackupRows(await allInkDrafts());toast(`已导出这台设备全部 ${count} 页批注。`);
    }catch(error){toast(error.message);}finally{busy=false;}
  };
  $('backup-import').onclick=()=>{if(!busy&&canRun())$('backup-file').click();};
  $('backup-file').onchange=async event=>{
    const file=event.target.files[0];event.target.value='';if(!file||busy||!canRun())return;busy=true;
    try{
      if(file.size>30_000_000)throw Error('备份超过 30 MB，请分谱导出再导入。');
      const incoming=parseBackup(JSON.parse(await file.text()));
      if(!confirm(`合并导入 ${incoming.length} 页批注？保留现有笔迹，不自动上传云端。`))return;
      await drain();const merged=mergeBackup(await allInkDrafts(),incoming);
      await saveInkDrafts(merged);
      for(const row of merged){const record=ink.records.get(row.id);if(record){record.data=structuredClone(row.data);record.base=structuredClone(row.base);record.dirty=true;record.undo=[];record.redo=[];record.revision++;ink.draw(record);await ink.flush(record);}}
      toast('已合并到本机；云端版本可在设置中点击“更新批注”。');
    }catch(error){toast(error.message);}finally{busy=false;}
  };
}
