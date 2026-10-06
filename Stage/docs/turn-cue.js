// A cue is an estimate from observed musical progress, never a wall-clock trigger.
export const CUE_SECONDS=3;
export class TurnCue {
  constructor(anchors,frames,{lead=.4,seconds=CUE_SECONDS}={}){
    Object.assign(this,{anchors,frames,lead,seconds});this.reset();
  }
  reset(){this.history=[];this.rate=1;this.cue=null;this.lastIndex=-1;this.lastProgress=-Infinity;}
  observe(match,liveTime,anchorIndex){
    const next=this.anchors[anchorIndex+1],time=this.frames[match.index]?.time;
    if(!next||!Number.isFinite(time)||!Number.isFinite(liveTime)){this.reset();return null;}
    if(!match.active||!match.stable){
      this.history=[];
      if(this.cue)this.cue={...this.cue,paused:true};
      return this.cue;
    }
    if(match.index>this.lastIndex){this.lastProgress=liveTime;this.lastIndex=match.index;}
    if(liveTime-this.lastProgress>.5){
      this.history=[];
      if(this.cue)this.cue={...this.cue,paused:true};
      return this.cue;
    }
    this.history.push({live:liveTime,reference:time});
    while(this.history.length>2&&liveTime-this.history[0].live>2)this.history.shift();
    const first=this.history[0],elapsed=liveTime-first.live;
    if(elapsed>=.7){
      const rate=(time-first.reference)/elapsed;
      // A jump across a removed rest is not a tempo change.
      if(rate>=.25&&rate<=3)this.rate=.8*this.rate+.2*rate;
    }
    const remaining=Math.max(0,(next.time-time)/this.rate-this.lead);
    if(remaining>this.seconds+.2){this.cue=null;return null;}
    this.cue={page:next.page,remaining:Math.min(this.seconds,remaining),fraction:Math.min(1,remaining/this.seconds),paused:false};
    return this.cue;
  }
}

export function showTurnCue(element,cue){
  element.hidden=!cue;
  if(!cue)return;
  element.classList.toggle('paused',cue.paused);
  element.querySelector('[data-cue-label]').textContent=cue.paused?'等待音乐 · 翻页提示已暂停':`即将翻到第 ${cue.page} 页`;
  element.querySelector('[data-cue-time]').textContent=cue.paused?'暂停':`${cue.remaining.toFixed(1)} s`;
  const progress=element.querySelector('progress');progress.value=cue.remaining;
  progress.setAttribute('aria-valuetext',cue.paused?'已暂停':`约 ${cue.remaining.toFixed(1)} 秒后翻页`);
}
