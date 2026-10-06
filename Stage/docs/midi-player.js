// Plays a parsed MIDI file through the piano, scheduling a little ahead of the clock so that
// a long piece neither stalls the page nor drifts.
export const LOOKAHEAD=.25,TICK=60;

// The notes that start inside a window, and where to carry on from.
export function notesWithin(notes,from,to,start=0){
  let index=start;
  while(index<notes.length&&notes[index].time<from)index++;
  const due=[];
  while(index<notes.length&&notes[index].time<to)due.push(notes[index++]);
  return {due,index};
}

export class MIDIPlayer {
  constructor({piano,onProgress=()=>{},onEnd=()=>{},setTimer=(fn,ms)=>setInterval(fn,ms),clearTimer=id=>clearInterval(id)}={}){
    Object.assign(this,{piano,onProgress,onEnd,setTimer,clearTimer});
    this.midi=null;this.timer=null;this.index=0;this.offset=0;this.startedAt=0;this.playing=false;
  }
  load(midi){this.stop();this.midi=midi;this.offset=0;this.index=0;this.onProgress(0,midi?.duration||0);}
  get position(){return this.playing?Math.min(this.duration,this.offset+this.piano.context.currentTime-this.startedAt):this.offset;}
  get duration(){return this.midi?.duration||0;}
  play(){
    if(!this.midi||this.playing)return;
    this.playing=true;
    this.startedAt=this.piano.context.currentTime;
    this.timer=this.setTimer(()=>this.pump(),TICK);
    this.pump();
  }
  pump(){
    if(!this.playing)return;
    const now=this.position;
    const {due,index}=notesWithin(this.midi.notes,now,now+LOOKAHEAD,this.index);
    this.index=index;
    const clock=this.piano.context.currentTime;
    for(const note of due)
      this.piano.play(note.note,{at:clock+Math.max(0,note.time-now),duration:note.duration,velocity:note.velocity});
    this.onProgress(now,this.duration);
    if(now>=this.duration){this.stop();this.onEnd();}
  }
  pause(){
    if(!this.playing)return;
    this.offset=this.position;this.playing=false;
    this.clearTimer(this.timer);this.timer=null;this.piano.silence();
    this.onProgress(this.offset,this.duration);
  }
  seek(seconds){
    const was=this.playing;
    if(was)this.pause();
    this.offset=Math.max(0,Math.min(this.duration,Number(seconds)||0));
    this.index=notesWithin(this.midi?.notes||[],0,this.offset).index;
    this.onProgress(this.offset,this.duration);
    if(was)this.play();
  }
  stop(){
    this.playing=false;this.offset=0;this.index=0;
    if(this.timer!==null)this.clearTimer(this.timer);
    this.timer=null;this.piano?.silence();
    this.onProgress(0,this.duration);
  }
}
