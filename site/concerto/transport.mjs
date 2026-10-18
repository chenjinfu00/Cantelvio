import {lowerBound} from './midi.mjs';

// Score time and audio time stay separate; only future MIDI events are queued.
export class Transport {
  constructor({midi,events,clock,send,onState=()=>{},onEnd=()=>{},onError=()=>{}}) {
    Object.assign(this,{midi,events,clock,send,onState,onEnd,onError}); this.playing=false;this.beat=0;this.index=0;this.rate=1;this.horizon=.08;this.sent=0;
  }
  start(beat=0,rate=1) {this.beat=beat;this.time=this.midi.clock.seconds(beat);this.rate=rate;this.index=lowerBound(this.events,beat);this.last=this.clock();this.nextTime=this.time;this.playing=true;this.sent=0;}
  tick(rate=this.rate, gate=Infinity) {
    if(!this.playing)return;
    const now=this.clock(),dt=Math.max(0,now-this.last);this.last=now;
    if(dt>.5) {this.playing=false;this.onError(Error('网页音频计时中断，已停止。请回到本页重新开始 / Audio timing interrupted; playback stopped'));return;}
    this.rate=Math.max(0,Math.min(4,rate));
    const gateTime=this.midi.clock.seconds(gate);
    this.time=Math.min(this.time+dt*this.rate,gateTime);
    this.beat=this.midi.clock.beat(this.time);
    const until=Math.min(this.time+this.horizon*this.rate,gateTime);
    while(this.index<this.events.length) {
      const e=this.events[this.index],when=this.midi.clock.seconds(e.beat);
      if(when>=until)break;
      this.index++;
      // Late events are emitted once. A long stalled tab is stopped above.
      this.send(e,now+Math.max(0,(when-this.time)/(this.rate||1)));this.sent++;
    }
    this.onState(this);
    if(this.beat>=this.midi.endBeat && this.index>=this.events.length) {this.playing=false;this.onEnd();}
  }
  stop() {this.playing=false;}
}

export function restoreState(events,beat,send,now) {
  const channels=new Map(),held=new Map();
  for(const e of events) {
    if(e.beat>=beat)break;
    const ch=`${e.track}:${e.channel}`,key=`${ch}:${e.a}`;
    if(e.command===9 && e.b) {const q=held.get(key)||[];q.push(e);held.set(key,q);}
    else if(e.command===8 || e.command===9 && !e.b)held.get(key)?.shift();
    else {const state=channels.get(ch)||new Map();state.set(e.command===11?`cc${e.a}`:e.command,e);channels.set(ch,state);}
  }
  for(const state of channels.values())for(const e of state.values())send(e,now);
  for(const queue of held.values())for(const e of queue)send(e,now);
}
