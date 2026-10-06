export function validateInk(value){
  if(value?.version!==1||!Array.isArray(value.strokes)||value.strokes.length>10000)return false;
  const ids=new Set();let count=0;
  for(const stroke of value.strokes){
    if(typeof stroke.id!=='string'||!stroke.id||stroke.id.length>150||ids.has(stroke.id)||!/^#[a-f0-9]{6}$/i.test(stroke.color)||!Number.isFinite(stroke.width)||stroke.width<=0||stroke.width>.1||!Array.isArray(stroke.points))return false;
    ids.add(stroke.id);count+=stroke.points.length;if(count>100000)return false;
    for(const p of stroke.points)if(!Array.isArray(p)||p.length!==3||!p.every(n=>Number.isFinite(n)&&n>=0&&n<=1))return false;
  }
  return true;
}
