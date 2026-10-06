const clamp=(v,min,max)=>Math.max(min,Math.min(Math.max(min,max),v));
export function dockPlacement(saved,{width,height,dockWidth,dockHeight}){
  const xMax=Math.max(8,width-dockWidth-8),yMax=Math.max(32,height-dockHeight-8);
  const edge=['left','right','top','bottom'].includes(saved?.edge)?saved.edge:'right';
  const fraction=Number.isFinite(saved?.fraction)?clamp(saved.fraction,0,1):.9;
  return {edge,x:edge==='left'?8:edge==='right'?xMax:8+(xMax-8)*fraction,y:edge==='top'?32:edge==='bottom'?yMax:32+(yMax-32)*fraction};
}
export function nearestDockEdge(x,y,area){
  const xMax=Math.max(8,area.width-area.dockWidth-8),yMax=Math.max(32,area.height-area.dockHeight-8);
  x=clamp(x,8,xMax);y=clamp(y,32,yMax);
  const edge=[['left',x-8],['right',xMax-x],['top',y-32],['bottom',yMax-y]].sort((a,b)=>a[1]-b[1])[0][0];
  return {edge,fraction:edge==='left'||edge==='right'?(y-32)/Math.max(1,yMax-32):(x-8)/Math.max(1,xMax-8)};
}
export function installDockPosition(){
  const dock=document.getElementById('ink-toolbar'),handle=document.getElementById('ink-drag');
  const closePopovers=()=>{for(const popover of dock.querySelectorAll('.pencil-popover'))popover.open=false;};
  const key='volta:dock-position:v1';let profiles={};try{const saved=JSON.parse(localStorage.getItem(key));if(saved&&typeof saved==='object'&&!Array.isArray(saved))profiles=saved;}catch{}
  let drag=null;
  const area=()=>({width:document.body.clientWidth,height:document.body.clientHeight,dockWidth:dock.offsetWidth||60,dockHeight:dock.offsetHeight||220});
  const orientation=a=>a.height>=a.width?'portrait':'landscape';
  function place(x,y,a){
    dock.style.left=clamp(x,8,a.width-a.dockWidth-8)+'px';dock.style.top=clamp(y,32,a.height-a.dockHeight-8)+'px';dock.style.right='auto';dock.style.bottom='auto';
    dock.dataset.side=x+a.dockWidth/2<a.width/2?'left':'right';dock.dataset.vertical=y+a.dockHeight/2<a.height/2?'top':'bottom';
  }
  function restore(){if(drag)return;const a=area(),p=dockPlacement(profiles[orientation(a)],a);place(p.x,p.y,a);}
  handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;const box=dock.getBoundingClientRect();drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:box.left,top:box.top};closePopovers();e.preventDefault();e.stopPropagation();handle.setPointerCapture(e.pointerId);dock.classList.add('dragging');});
  handle.addEventListener('pointermove',e=>{if(drag?.id!==e.pointerId)return;e.preventDefault();place(drag.left+e.clientX-drag.x,drag.top+e.clientY-drag.y,area());});
  const finish=e=>{if(drag?.id!==e.pointerId)return;const a=area(),box=dock.getBoundingClientRect();if(e.type!=='pointercancel'){profiles[orientation(a)]=nearestDockEdge(box.left,box.top,a);try{localStorage.setItem(key,JSON.stringify(profiles));}catch{}}drag=null;dock.classList.remove('dragging');restore();};
  for(const event of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(event,finish);
  handle.addEventListener('keydown',e=>{if(!e.key.startsWith('Arrow'))return;e.preventDefault();const a=area(),p=dock.getBoundingClientRect();profiles[orientation(a)]=nearestDockEdge(p.left+(e.key==='ArrowRight'?24:e.key==='ArrowLeft'?-24:0),p.top+(e.key==='ArrowDown'?24:e.key==='ArrowUp'?-24:0),a);try{localStorage.setItem(key,JSON.stringify(profiles));}catch{}restore();});
  new ResizeObserver(restore).observe(document.body);new ResizeObserver(restore).observe(dock);restore();
}
