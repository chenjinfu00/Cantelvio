// Stroke identifiers are not credentials. getRandomValues also works on a
// local-network HTTP preview, where randomUUID is unavailable in Safari.
let sequence=0;
export function strokeID(random=globalThis.crypto){
  if(random?.randomUUID)return random.randomUUID();
  if(random?.getRandomValues){const bytes=random.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
  return `stroke-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class PencilInput {
  constructor(effects,{setTimer=setTimeout,clearTimer=clearTimeout,holdMs=1000,slop=10}={}){Object.assign(this,{effects,setTimer,clearTimer,holdMs,slop});this.active=null;this.timer=null;}
  down(event){
    if(this.active||!['pen','mouse'].includes(event.pointerType)||event.button!==0||!this.effects.allowed(event))return false;
    const gesture={id:event.pointerId,x:event.clientX,y:event.clientY,type:event.pointerType,held:false,drawn:false};this.active=gesture;
    try{this.effects.begin(event);}catch(error){this.active=null;throw error;}
    this.armHold();
    return true;
  }
  move(event){
    if(!this.active||event.pointerId!==this.active.id)return false;
    const samples=event.getCoalescedEvents?.()||[],events=samples.length?samples:[event];
    if(!this.active.held&&events.some(point=>Math.hypot(point.clientX-this.active.x,point.clientY-this.active.y)>this.slop)){
      this.active.drawn=true;const last=events.at(-1);this.active.x=last.clientX;this.active.y=last.clientY;this.armHold();
    }
    if(!this.active.held)this.effects.move(events);return true;
  }
  end(event,cancel=false){if(!this.active||event.pointerId!==this.active.id)return false;this.finish(cancel);return true;}
  clearHold(){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
  armHold(){
    this.clearHold();const gesture=this.active;if(gesture?.type!=='pen'||gesture.held)return;
    this.timer=this.setTimer(()=>{
      this.timer=null;if(this.active!==gesture)return;gesture.held=true;
      // A pause after writing keeps the stroke; an isolated long press leaves no dot.
      if(gesture.drawn)this.effects.commit();else this.effects.cancel();
      this.effects.toggle();
    },this.holdMs);
  }
  finish(cancel=false){
    if(!this.active)return;const gesture=this.active;this.active=null;this.clearHold();
    if(!gesture.held){if(cancel)this.effects.cancel();else this.effects.commit();}
    this.effects.end?.(gesture);
  }
}
