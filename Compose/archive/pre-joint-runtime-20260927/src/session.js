import {predictNext,sampleDistribution,prepareModels} from '../vendor/lib/harmony-models.js';
import {BASE_CHORDS} from '../vendor/lib/chord-vocabulary.js';
import {createTimelineMelodyPerformer} from './melody-timeline.js';
import {defaults,SCENES,snapshotScene} from './scenes.js';
import {ChordQueue} from './queue.js';
import {Transport} from './transport.js';
import {beatsFor,planHarmonyTimeline} from './planner.js';
import {chartRows,forecastBars} from './chord-chart.js';
export class Session {
 constructor(audio,{random=Math.random,onChange=()=>{},saved={}}={}){
  Object.assign(this,{audio,random,onChange,saved});this.state=defaults();this.pendingScene=null;this.pendingBpm=null;this.pendingKey=null;this.previous=[];this.editIntent=null;
  this.soundingScene=this.state.scene;this.soundingMode='hold';this.soundingChangeMode='bar';this.durationMode='bar';this.staged=null;this.scheduledUIDs=new Set();this.tailState=null;this.chordClock=null;this.replacementQueue=null;
  this.melody=createTimelineMelodyPerformer({random});this.queue=this.newQueue();this.queue.reset('C',this.state.key);this.soundingSlot=structuredClone(this.queue.slots[0]);this.chartArchive=new Map();this.chartScheduled=new Map();this.chartPrefetchGeneration=0;
  this.transport=new Transport({audio,boundary:arg=>this.boundary(arg),onChange:(message,error)=>{if(message==='interrupted'||message==='error'){this.clearPlanning();this.prefetchChart();}onChange(message,error);}});
 }
 newQueue(){return new ChordQueue({predict:predictNext,sample:d=>sampleDistribution(d, this.random),options:()=>this.options(),random:this.random});}
 async init(){await prepareModels();}
 options(){const feedback=this.state.melodyOn?this.melody.getFeedback():null;return {palette:this.state.harmonyStyle,temperature:this.state.harmonyT,keyWalk:this.state.keyWalk,keyEvery:this.state.keyEvery,changeMode:this.durationMode,beatsPerBar:beatsFor(this.state),...(feedback?{melodyFeedback:{...feedback,strength:this.state.interaction}}:{})};}
 notify(){this.onChange();}
 applyScene(id,at=null){const preset=this.saved[id]||SCENES.find(s=>s.id===id);if(!preset)return;Object.assign(this.state,structuredClone(snapshotScene(preset)));this.state.scene=id;this.audio.setMix(this.state.mix,this.state.mutes,at??this.audio.context?.currentTime);this.pendingScene=null;this.editIntent=null;if(at===null){this.queue.retime(this.durationMode,beatsFor(this.state));this.soundingScene=id;this.notify();this.prefetchChart();}}
 selectScene(id){this.editIntent=null;if(this.transport.running){this.pendingScene=this.pendingScene===id?null:id;this.notify();}else this.applyScene(id);}
 saveScene(id){this.saved[id]=snapshotScene(this.state);this.state.scene=id;this.notify();}
 boundary({bar,first,start=null}){
  if(this.pendingScene)this.applyScene(this.pendingScene,start);else if(!first&&this.state.randomScenes&&this.random()<1/this.state.randomEvery){const choices=SCENES.filter(s=>s.id!==this.state.scene);this.applyScene(choices[Math.floor(this.random()*choices.length)].id,start);}
  if(this.pendingBpm!==null){this.state.bpm=this.pendingBpm;this.pendingBpm=null;}
  const mode=this.state.mode,changeMode=this.state.changeMode||'bar',beats=beatsFor(this.state),seconds=60/this.state.bpm;
  const prior=this.tailState;this.durationMode=changeMode;
  let q=this.queue,keyChanged=false;
  if(this.pendingKey){
   q=this.newQueue();q.serial=this.queue.serial;q.revision=this.queue.revision+1;
   const key={...this.pendingKey},id=BASE_CHORDS[(key.mode==='minor'?12:0)+key.tonic].id;q.reset(id,key);
   this.queue.serial=q.serial;this.replacementQueue=q;this.pendingKey=null;keyChanged=true;this.melody.reset();this.previous=[];
  }
  q.retime(changeMode,beats);
  let index=Math.max(0,q.slots.findIndex(s=>s.uid===prior?.uid));
  if(first||keyChanged||mode==='hold')index=0;
  let current=q.slots[index],elapsed=first||keyChanged||!prior?0:prior.elapsedBeats;
  // Bar-unit holds preserve their position through a meter change. Quantize
  // the rare fractional remap to a sixteenth so decoder slot tokens stay integral.
  if(prior&&prior.beats!==beats&&current.durationSpec.unit==='bars'&&!first&&!keyChanged)elapsed=Math.round(elapsed*beats/prior.beats*4)/4;
  let remaining=Math.max(0,current.durationBeats-elapsed);
  if(mode==='hold'){elapsed=0;remaining=beats;}
  else if(changeMode==='bar'){remaining=(!first&&!keyChanged)?0:beats;elapsed=0;}
  else if(!first&&!keyChanged&&prior?.mode==='hold'){remaining=0;elapsed=0;}
  const segments=[];let cursor=0;
  while(cursor<beats){
   if(mode==='auto'&&remaining<=0){index++;q.fill(index+4);current=q.slots[index];elapsed=0;remaining=current.durationBeats;}
   const lengthBeats=mode==='hold'?beats:Math.min(remaining,beats-cursor);
   q.fill(index+4);
   segments.push({slot:structuredClone(current),nextSlot:structuredClone(mode==='hold'?current:q.slots[index+1]),startBeat:cursor,lengthBeats,elapsedBeats:elapsed});
   cursor+=lengthBeats;elapsed+=lengthBeats;remaining-=lengthBeats;
  }
  this.queue.serial=Math.max(this.queue.serial,q.serial);
  this.tailState={uid:current.uid,elapsedBeats:elapsed,mode,changeMode,beats};
  this.scheduledUIDs=new Set(segments.map(s=>s.slot.uid));
  const plan=planHarmonyTimeline(segments,this.state,bar,this.previous);this.previous=plan.chord;
  if(this.state.melodyOn){const firstSegment=plan.conditioned[0];const melody=this.melody.plan(firstSegment.chord,{enabled:true,style:this.state.melodyStyle,instrument:this.state.melodyInstrument,density:this.state.density,feel:this.state.feel,bpm:this.state.bpm,beatsPerBar:beats,bar,key:firstSegment.key,nextChord:firstSegment.nextChord,chordId:firstSegment.id,temperature:this.state.melodyT,rhythm:this.state.melodyRhythm,pattern:this.state.melodyPattern,register:this.state.melodyRegister,timeline:plan.conditioned.length>1?plan.conditioned:[]});plan.events.push(...melody.events.map(e=>({...e,role:'melody'})));plan.melodyContextEvents=melody.contextEvents;}
  const scene=this.state.scene,anchor=start??0;
  const commit=segment=>{
   if(this.queue!==q){this.queue=q;this.replacementQueue=null;}
   q.advanceTo(segment.slot.uid);this.state.key={...segment.slot.key};this.soundingSlot=structuredClone(segment.slot);this.soundingMode=mode;this.soundingChangeMode=changeMode;
   this.chordClock={uid:segment.slot.uid,totalBeats:segment.slot.durationBeats,elapsedBeats:segment.elapsedBeats,at:anchor+segment.startBeat*seconds,secondsPerBeat:seconds,held:mode==='hold'};this.notify();
  };
  this.staged={scene,uid:segments[0].slot.uid};
  const chartPlan={bar,meter:beats,segments:segments.map(s=>({slot:structuredClone(s.slot),startBeat:s.startBeat,lengthBeats:s.lengthBeats,continuation:s.elapsedBeats>0}))};
  this.chartScheduled.set(bar,chartPlan);
  plan.onStart=()=>{this.soundingScene=scene;this.staged=null;commit(segments[0]);this.chartScheduled.delete(bar);this.chartArchive.set(bar,chartPlan);this.pruneChart(bar);this.notify();this.prefetchChart();};
  plan.transitions=segments.slice(1).map(segment=>({time:segment.startBeat*seconds,onStart:()=>commit(segment)}));
  plan.timeline=segments.map(s=>({uid:s.slot.uid,id:s.slot.id,startBeat:s.startBeat,lengthBeats:s.lengthBeats,durationBeats:s.slot.durationBeats,elapsedBeats:s.elapsedBeats}));
  if(start===null){plan.onStart();for(const transition of plan.transitions)transition.onStart();}
  this.notify();return plan;
 }
 displayQueue(){const q=this.replacementQueue||this.queue,view=q.view();if(this.transport.running&&this.soundingSlot){if(view.slots[0].uid!==this.soundingSlot.uid)view.slots=[structuredClone(this.soundingSlot),...view.slots.slice(0,3)];else view.slots[0]=structuredClone(this.soundingSlot);}return view;}
 pruneChart(currentBar){for(const bar of this.chartArchive.keys())if(bar<currentBar-7)this.chartArchive.delete(bar);}
 chartView(){
  const currentBar=this.transport.frame?.bar??0,baseBar=Math.floor(currentBar/4)*4,q=this.replacementQueue||this.queue;
  const plans=new Map([...this.chartArchive,...this.chartScheduled]),visible=[...plans.values()].filter(p=>p.bar>=baseBar&&p.bar<baseBar+8);
  const lastPlan=[...plans.values()].sort((a,b)=>a.bar-b.bar).at(-1),startBar=lastPlan?lastPlan.bar+1:baseBar;
  const cursor=this.tailState&&q.slots.some(s=>s.uid===this.tailState.uid)?this.tailState:{uid:q.slots[0]?.uid,elapsedBeats:0,beats:beatsFor(this.state)};
  const forecast=forecastBars({slots:q.slots,startUid:cursor.uid,elapsedBeats:cursor.elapsedBeats,previousMeter:cursor.beats||beatsFor(this.state),advanceAtStart:!!lastPlan,resumeAfterHold:!!lastPlan&&cursor.mode==='hold'&&this.state.mode!=='hold',startBar,barCount:Math.max(0,baseBar+8-startBar),mode:this.state.mode,changeMode:this.state.changeMode||'bar',beatsPerBar:beatsFor(this.state)});
  return {baseBar,rows:chartRows({baseBar,plans:visible,forecast,beatsPerBar:beatsFor(this.state)}),scheduledUIDs:[...this.scheduledUIDs],queueRevision:q.revision,queueCount:q.slots.length};
 }
 prefetchChart(maxSlots=40){
  const q=this.replacementQueue||this.queue,revision=q.revision,generation=++this.chartPrefetchGeneration;
  return new Promise(resolve=>{const step=()=>{
   if(generation!==this.chartPrefetchGeneration||q!==(this.replacementQueue||this.queue)||revision!==q.revision){resolve(false);return;}
   if(!this.chartView().rows.some(row=>row.pending)){this.notify();resolve(true);return;}
   if(q.slots.length>=maxSlots){this.notify();resolve(false);return;}
   q.fill(q.slots.length+1);
   const timer=setTimeout(step,0);timer?.unref?.();
  };const timer=setTimeout(step,0);timer?.unref?.();});
 }
 isScheduled(uid){return this.scheduledUIDs.has(uid);}
 chordProgress(time){const clock=this.chordClock;if(!clock||clock.held||!this.transport.running)return 0;return Math.max(0,Math.min(1,(clock.elapsedBeats+Math.max(0,time-clock.at)/clock.secondsPerBeat)/clock.totalBeats));}
 prefillScheduled(q){const last=q.slots.reduce((found,slot,index)=>this.scheduledUIDs.has(slot.uid)?index:found,0);q.fill(last+4);}
 clearPlanning(){if(this.replacementQueue)this.queue.serial=Math.max(this.queue.serial,this.replacementQueue.serial);this.chartPrefetchGeneration++;this.chartArchive.clear();this.chartScheduled.clear();this.staged=null;this.scheduledUIDs.clear();this.tailState=null;this.chordClock=null;this.replacementQueue=null;this.editIntent=null;this.melody.reset();this.previous=[];}
 stop(){this.transport.stop();this.clearPlanning();this.soundingScene=this.state.scene;this.soundingSlot=structuredClone(this.queue.slots[0]);this.pendingScene=null;this.notify();this.prefetchChart();}
 setMelody(on){this.state.melodyOn=on;if(!on){this.audio.stopGroup('melody');this.melody.reset();}this.notify();}
 setParam(name,value){
  if(name==='bpm'){value=Math.max(40,Math.min(200,Number(value)||92));if(this.transport.running)this.pendingBpm=value;else this.state.bpm=value;}
  else {this.state[name]=value;
   if(name==='harmonyT'||name==='keyWalk'||name==='keyEvery'||name==='harmonyStyle'){const q=this.replacementQueue||this.queue;const locked=q.slots.filter(s=>this.scheduledUIDs.has(s.uid)).at(-1);q.regenerate(locked?.uid);this.prefillScheduled(q);this.editIntent=null;this.prefetchChart();}
   if((name==='changeMode'||name==='rhythm')&&!this.transport.running){this.durationMode=this.state.changeMode||'bar';this.queue.retime(this.durationMode,beatsFor(this.state));this.soundingSlot=structuredClone(this.queue.slots[0]);this.editIntent=null;}
   if(name==='bassOn'&&!value)this.audio.stopGroup('bass');
  }
  if(['mode','changeMode','rhythm'].includes(name))this.prefetchChart();
  this.notify();
 }
 setKey(key){this.editIntent=null;if(this.transport.running)this.pendingKey=key;else this.commitKey(key);this.notify();}
 commitKey(key){this.state.key={...key};const id=BASE_CHORDS[(key.mode==='minor'?12:0)+key.tonic].id;this.queue.reset(id,key);this.soundingSlot=structuredClone(this.queue.slots[0]);this.melody.reset();this.previous=[];this.prefetchChart();}
 mix(role,value){this.state.mix[role]=value;this.audio.setRoleMix(role,this.state.mix[role],this.state.mutes[role]);this.notify();}
 mute(role){this.state.mutes[role]=!this.state.mutes[role];this.audio.setRoleMix(role,this.state.mix[role],this.state.mutes[role]);this.notify();}
 editContext(uid){return (this.replacementQueue||this.queue).context(uid);}
 edit(uid){if(this.isScheduled(uid)||!this.editContext(uid))return null;this.editIntent={uid,revision:(this.replacementQueue||this.queue).revision};return this.editIntent;}
 commitEdit(id){if(!this.editIntent)return false;const q=this.replacementQueue||this.queue;const ok=!this.isScheduled(this.editIntent.uid)&&q.edit(this.editIntent,id);if(ok){this.prefillScheduled(q);this.prefetchChart();}this.editIntent=null;this.notify();return ok;}
}
