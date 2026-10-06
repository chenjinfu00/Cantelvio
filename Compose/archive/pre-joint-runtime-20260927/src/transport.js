/** True bar clock. Within-bar chord display callbacks share its audio start and
 * cancellation generation; musical bars never become artificial chord bars. */
export class Transport {
 constructor({audio,boundary,onChange=()=>{},setTimer=(fn,ms)=>globalThis.setTimeout(fn,ms),clearTimer=id=>globalThis.clearTimeout(id)}){Object.assign(this,{audio,boundary,onChange,setTimer,clearTimer});this.generation=0;this.lastStopReason='Not started';this.running=false;this.starting=false;this.bar=0;this.timer=null;this.onsetTimers=new Set();this.frame=null;}
 async start(){if(this.running||this.starting)return;const token=++this.generation;this.starting=true;this.onChange();try{await this.audio.ensureReady();if(token!==this.generation)return;this.starting=false;this.running=true;this.lastStopReason='';this.bar=0;this.nextAt=this.audio.context.currentTime+.12;this.tick(token,true);}catch(error){if(token===this.generation){this.stop(error.message);throw error;}}finally{if(token===this.generation){this.starting=false;this.onChange();}}}
 onset(token,at,callback){let handle;handle=this.setTimer(()=>{this.onsetTimers.delete(handle);if(token!==this.generation||!this.running)return;if(this.audio.context.state!=='running'||this.audio.context.currentTime-at>.15){this.stop('Scheduling deadline or audio interruption');this.onChange('interrupted');return;}callback();this.onChange();},Math.max(0,(at-this.audio.context.currentTime)*1000));this.onsetTimers.add(handle);}
 tick(token,first=false){if(token!==this.generation||!this.running)return;const now=this.audio.context.currentTime;if(this.audio.context.state!=='running'||now-this.nextAt>.05){this.stop('Scheduling deadline or audio interruption');this.onChange('interrupted');return;}
  try{const plan=this.boundary({bar:this.bar,first,start:this.nextAt});if(token!==this.generation||!this.running)return;if(this.audio.context.currentTime-this.nextAt>.05){this.stop('Scheduling deadline or audio interruption');this.onChange('interrupted');return;}for(const event of plan.events)this.audio.play(event,this.nextAt);
   const frame={start:this.nextAt,duration:plan.duration,bar:this.bar,beats:plan.beats};
   this.onset(token,this.nextAt,()=>{this.frame=frame;plan.onStart?.();});
   for(const transition of plan.transitions||[])this.onset(token,this.nextAt+transition.time,transition.onStart);
   this.nextAt+=plan.duration;this.bar++;this.onChange();this.timer=this.setTimer(()=>this.tick(token),Math.max(4,(this.nextAt-this.audio.context.currentTime-.1)*1000));
  }catch(error){this.stop(error.message);this.onChange('error',error);}
 }
 stop(reason='Stopped by user'){this.lastStopReason=reason;this.generation++;this.running=false;this.starting=false;this.clearTimer(this.timer);for(const timer of this.onsetTimers)this.clearTimer(timer);this.onsetTimers.clear();this.timer=null;this.frame=null;this.audio.panic();this.onChange();}
}
