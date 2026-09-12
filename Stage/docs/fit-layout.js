export function safeBounds(value){
  if(!Array.isArray(value)||value.length!==4||!value.every(Number.isFinite))return [0,0,1,1];
  const [x,y,r,b]=value;if(x<0||y<0||r>1||b>1||r-x<.1||b-y<.1)return [0,0,1,1];
  return value;
}
export function fitLayout(natural,metrics,bounds){
  const box=metrics.fit==='screen'&&metrics.protectFit?safeBounds(bounds):[0,0,1,1];
  const width=natural.width*(box[2]-box[0]),height=natural.height*(box[3]-box[1]);
  // Preserve the entire detected content, including safety margins. Never use
  // cover scaling in protected fit; excess space is preferable to clipped notes.
  const scale=(metrics.fit==='screen'&&!metrics.protectFit?Math.max:Math.min)(metrics.width/width,metrics.height/height)*metrics.zoom;
  return {width:natural.width*scale,height:natural.height*scale,clip:{x:box[0]*natural.width*scale,y:box[1]*natural.height*scale,width:width*scale,height:height*scale}};
}
export function includeInk(bounds,strokes=[]){
  const box=[...safeBounds(bounds)];
  for(const stroke of strokes)for(const point of stroke.points||[]){const margin=Math.max(.008,(stroke.width||0)*2);box[0]=Math.max(0,Math.min(box[0],point[0]-margin));box[1]=Math.max(0,Math.min(box[1],point[1]-margin));box[2]=Math.min(1,Math.max(box[2],point[0]+margin));box[3]=Math.min(1,Math.max(box[3],point[1]+margin));}
  return box;
}
