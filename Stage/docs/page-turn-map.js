export function pageTurnMap(scoreId,reference){
  return {version:1,scoreId,sourceId:reference.sourceId,sourceName:reference.sourceName,
    anchors:reference.anchors.map(a=>({...a})),rests:reference.rests||[]};
}
export function validatePageTurnMap(map,{scoreId,sourceId,pageCount,duration}){
  if(map?.version!==1||map.scoreId!==scoreId)throw new Error('翻页点不属于这份 PDF，请打开对应版本。');
  if(!sourceId||map.sourceId!==sourceId)throw new Error('翻页点对应另一份 MIDI 或录音，请使用原参考文件。');
  if(!Array.isArray(map.anchors)||map.anchors.length<2||map.anchors.length>2000)throw new Error('至少需要起始页和一个翻页点。');
  const anchors=map.anchors.map((a,i)=>{
    if(!Number.isInteger(a.page)||a.page<1||a.page>pageCount||!Number.isFinite(a.time)||a.time<0||a.time>duration||(i&&a.time<=map.anchors[i-1].time))throw new Error('翻页点的时间或页码无效。');
    return {page:a.page,time:a.time,...(Number.isInteger(a.bar)&&a.bar>0?{bar:a.bar}:{})};
  });
  const rests=map.rests||[];
  if(!Array.isArray(rests)||rests.some(r=>!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end<=r.start||r.end>duration))throw new Error('休止标记无效。');
  return {anchors,rests:rests.map(r=>({start:r.start,end:r.end}))};
}
