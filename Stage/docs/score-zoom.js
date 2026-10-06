export const clampZoom=value=>Math.max(1,Math.min(4,Number.isFinite(value)?value:1));
export function pinchTransform(start,points){
  const [a,b]=points,center={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
  const zoom=clampZoom(start.zoom*Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,start.distance));
  const ratio=zoom/start.zoom;
  return {zoom,center,ratio,x:center.x-start.left-(start.center.x-start.left)*ratio,y:center.y-start.top-(start.center.y-start.top)*ratio};
}

// Browser zoom includes every drawer. A score-owned gesture instead transforms
// paper + ink only, with one bounded high-quality render after both fingers lift.
export function installScoreZoom(stage,{getZoom,canZoom,commit,onStart=()=>{},onError=()=>{}}){
  const points=new Map();let gesture=null,pending=null,busy=false;
  const paper=()=>document.getElementById('pages');
  const clear=()=>{const node=paper();node.style.transform='';node.style.transformOrigin='';node.style.willChange='';};
  stage.addEventListener('pointerdown',event=>{
    if(event.pointerType!=='touch'||!canZoom()||busy)return;
    points.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(points.size!==2)return;
    const pair=[...points.values()],box=paper().getBoundingClientRect(),center={x:(pair[0].x+pair[1].x)/2,y:(pair[0].y+pair[1].y)/2};
    gesture={zoom:getZoom(),distance:Math.hypot(pair[0].x-pair[1].x,pair[0].y-pair[1].y),left:box.left,top:box.top,center,anchor:{x:(center.x-box.left)/box.width,y:(center.y-box.top)/box.height}};
    pending=null;onStart();paper().style.transformOrigin='0 0';paper().style.willChange='transform';
    for(const id of points.keys())try{stage.setPointerCapture(id);}catch{}
    event.preventDefault();
  },{capture:true});
  stage.addEventListener('pointermove',event=>{
    if(!points.has(event.pointerId))return;points.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(!gesture||points.size!==2)return;
    pending=pinchTransform(gesture,[...points.values()]);paper().style.transform=`translate(${pending.x}px,${pending.y}px) scale(${pending.ratio})`;
    event.preventDefault();event.stopPropagation();
  },{capture:true});
  const end=event=>{
    points.delete(event.pointerId);if(!gesture)return;
    if(event.type==='pointercancel')gesture.cancelled=true;
    event.preventDefault();event.stopPropagation();
    if(points.size)return;
    const previous=gesture,result=pending;gesture=null;pending=null;
    if(previous.cancelled||!result){clear();return;}
    busy=true;
    Promise.resolve(commit(result.zoom,{...previous.anchor,clientX:result.center.x,clientY:result.center.y},clear)).catch(onError).finally(()=>{clear();busy=false;});
  };
  stage.addEventListener('pointerup',end,{capture:true});stage.addEventListener('pointercancel',end,{capture:true});
  // iPadOS may also emit legacy gesture events. Never let these zoom the UI.
  for(const type of ['gesturestart','gesturechange','gestureend'])stage.addEventListener(type,event=>event.preventDefault(),{passive:false});
  stage.addEventListener('touchmove',event=>{if(event.touches.length>1)event.preventDefault();},{passive:false});
  return {get active(){return !!gesture||busy;},cancel(){points.clear();gesture=null;pending=null;clear();}};
}
