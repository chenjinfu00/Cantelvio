export function capturePosition(stage){return {x:stage.scrollLeft/Math.max(1,stage.scrollWidth),y:stage.scrollTop/Math.max(1,stage.scrollHeight)};}
export function restorePosition(stage,pose={x:0,y:0}){
  const clamp=(v,max)=>Math.max(0,Math.min(max,Number.isFinite(v)?v:0));
  stage.scrollLeft=clamp(pose.x*stage.scrollWidth,stage.scrollWidth-stage.clientWidth);
  stage.scrollTop=clamp(pose.y*stage.scrollHeight,stage.scrollHeight-stage.clientHeight);
}
export class ReadingPosition {
  constructor(stage){this.stage=stage;this.score=null;this.blocked=false;this.profiles={};this.revision=0;stage.addEventListener('scroll',()=>this.remember(),{passive:true});}
  key(){return (this.stage.clientHeight>=this.stage.clientWidth?'portrait':'landscape')+':'+(this.stage.classList.contains('zoomed')?'zoom':'fit');}
  setScore(id){this.score=id;this.profiles={};try{const saved=JSON.parse(localStorage.getItem('volta:position:'+id));if(saved&&typeof saved==='object'&&!Array.isArray(saved))this.profiles=saved;}catch{}}
  remember(){
    if(this.blocked||!this.score)return;
    // A contained page has no scroll range; it must not erase the next tall page's alignment.
    if(this.stage.scrollHeight<=this.stage.clientHeight+1&&this.stage.scrollWidth<=this.stage.clientWidth+1)return;
    this.profiles[this.key()]=capturePosition(this.stage);try{localStorage.setItem('volta:position:'+this.score,JSON.stringify(this.profiles));}catch{}
  }
  snapshot(){return this.profiles[this.key()]||{x:0,y:0};}
  async paint(draw,pose=this.snapshot()){
    const revision=++this.revision;this.blocked=true;
    try{draw();restorePosition(this.stage,pose);await new Promise(resolve=>requestAnimationFrame(resolve));}
    finally{if(revision===this.revision)this.blocked=false;}
  }
  reset(){this.profiles={};try{localStorage.removeItem('volta:position:'+this.score);}catch{}return this.paint(()=>{}, {x:0,y:0});}
}
