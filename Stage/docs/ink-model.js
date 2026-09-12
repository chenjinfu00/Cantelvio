// Strokes are immutable; a three-way merge keeps independent device additions
// and respects deletions without resurrecting strokes erased on another device.
export function mergeInk(base,local,remote){
  const before=new Set(base.strokes.map(s=>s.id)),after=new Set(local.strokes.map(s=>s.id));
  const deleted=new Set([...before].filter(id=>!after.has(id)));
  const result=new Map(remote.strokes.filter(s=>!deleted.has(s.id)).map(s=>[s.id,s]));
  for(const s of local.strokes)if(!before.has(s.id))result.set(s.id,s);
  return {version:1,strokes:[...result.values()]};
}
export function distanceToSegment(p,a,b){
  const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
  const t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)):0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
}
