import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.js';
import {Transport} from '../src/transport.js';
import {distributionEvidence,chooseDurationSpec,durationBeats} from '../src/duration-policy.js';
import {planHarmonyTimeline} from '../src/planner.js';
import {defaults,SCENES,snapshotScene} from '../src/scenes.js';
import {createTimelineMelodyPerformer} from '../src/melody-timeline.js';
import {createMelodyPerformer} from '../vendor/improvisation.js';
const seeded=seed=>{let n=seed|0;return()=>{n=(Math.imul(n,1664525)+1013904223)|0;return(n>>>0)/4294967296;};};
const audio=()=>({context:{state:'running',currentTime:0},ensureReady:async()=>{},panic(){this.panics=(this.panics||0)+1;},setMix(){},setRoleMix(){},stopGroup(){},play(e,at){this.events.push({...e,at});},events:[]});
function freeSession(meter=4){const a=audio(),s=new Session(a,{random:seeded(42)});s.setParam('mode','auto');s.setParam('changeMode','free');if(meter===3)s.setParam('rhythm','waltz');return {s,a};}
function spec(slot,unit,count,meter=4){Object.assign(slot,{durationSpec:{unit,count},durationBeats:unit==='bars'?count*meter:count,meter});}
function complete(plan){plan.onStart();for(const t of plan.transitions)t.onStart();}
test('duration evidence aggregates inversions and confident predictions materially favor longer holds',()=>{
 const split=distributionEvidence([{id:'C',probability:.3},{id:'C/E',probability:.3},{id:'C/G',probability:.1},{id:'G',probability:.3}],'C/E');
 const collapsed=distributionEvidence([{id:'C',probability:.7},{id:'G',probability:.3}],'C');assert.ok(Math.abs(split.entropy-collapsed.entropy)<1e-12);assert.equal(split.confidence,collapsed.confidence);assert.equal(split.selectedMass,.7);
 const average=e=>Array.from({length:1000},(_,i)=>durationBeats(chooseDurationSpec(e,'C',{tonic:0,mode:'major'},i/1000),'free',4)).reduce((a,b)=>a+b)/1000;
 assert.ok(average({confidence:.8,entropy:.17,selectedMass:.8})>average({confidence:.16,entropy:.56,selectedMass:.1})+1);
});
test('short and long commitments produce internal changes while true bar and chord clocks stay separate',()=>{
 const {s,a}=freeSession();s.transport.running=true;spec(s.queue.slots[0],'beats',1);spec(s.queue.slots[1],'beats',2);spec(s.queue.slots[2],'bars',2);spec(s.queue.slots[3],'beats',1);const ids=s.queue.slots.map(e=>e.uid);
 const p0=s.boundary({bar:0,first:true,start:0});assert.deepEqual(p0.timeline.map(e=>[e.uid,e.startBeat,e.lengthBeats]),[[ids[0],0,1],[ids[1],1,2],[ids[2],3,1]]);assert.equal(p0.beats,4);assert.equal(p0.duration,4*60/92);assert.equal(s.queue.slots[0].uid,ids[0]);assert.equal(s.edit(ids[1]),null);
 p0.onStart();a.context.currentTime=60/92;p0.transitions[0].onStart();assert.equal(s.queue.slots[0].uid,ids[1]);a.context.currentTime=3*60/92;p0.transitions[1].onStart();assert.equal(s.queue.slots[0].uid,ids[2]);assert.equal(s.chordProgress(a.context.currentTime),0);
 const p1=s.boundary({bar:1,first:false,start:4*60/92});assert.equal(p1.timeline.length,1);assert.equal(p1.timeline[0].uid,ids[2]);p1.onStart();assert.equal(s.chordProgress(4*60/92),1/8);assert.equal(s.chordProgress(6*60/92),3/8);
 s.setParam('bpm',120);const p2=s.boundary({bar:2,first:false,start:8*60/92});assert.deepEqual(p2.timeline.slice(0,2).map(e=>[e.uid,e.startBeat,e.lengthBeats]),[[ids[2],0,3],[ids[3],3,1]]);p2.onStart();assert.equal(s.chordProgress(8*60/92),5/8);assert.equal(s.chordProgress(8*60/92+.5),6/8);assert.equal(p2.duration,2);
});
test('Stop before and between scheduled onsets never consumes unheard future chords',()=>{
 for(const consumed of [0,1]){const {s}=freeSession();s.transport.running=true;for(const slot of s.queue.slots)spec(slot,'beats',1);const before=s.queue.view();const plan=s.boundary({bar:0,first:true,start:0});plan.onStart();if(consumed)plan.transitions[0].onStart();s.stop();assert.equal(s.queue.slots[0].uid,before.slots[consumed].uid);assert.equal(s.queue.slots[1].uid,before.slots[consumed+1].uid);const restart=s.boundary({bar:0,first:true,start:2});assert.equal(restart.timeline[0].uid,before.slots[consumed].uid);}
});
test('transport cancellation invalidates every queued within-bar onset callback',async()=>{
 const a=audio(),callbacks=[],cleared=[];let onsets=0;const transport=new Transport({audio:a,boundary:()=>({events:[],beats:4,duration:2,onStart:()=>onsets++,transitions:[{time:.5,onStart:()=>onsets++},{time:1,onStart:()=>onsets++}]}),setTimer:f=>(callbacks.push(f),callbacks.length),clearTimer:id=>cleared.push(id)});
 await transport.start();const stale=[...callbacks];transport.stop();for(const callback of stale)callback();assert.equal(onsets,0);assert.ok(cleared.includes(1)&&cleared.includes(2)&&cleared.includes(3));
});
test('Free/Every-bar retiming preserves chord identities; Hold suppresses every internal transition',()=>{
 const {s}=freeSession();spec(s.queue.slots[0],'bars',2);const p=s.boundary({bar:0,first:true,start:0});complete(p);const ids=s.queue.slots.map(c=>c.uid);s.setParam('changeMode','bar');const next=s.boundary({bar:1,first:false,start:4*60/92});assert.equal(next.timeline.length,1);assert.equal(next.timeline[0].uid,ids[1]);assert.equal(next.timeline[0].durationBeats,4);assert.equal(s.queue.slots[0].uid,ids[0]);complete(next);
 s.setParam('mode','hold');s.setParam('changeMode','free');const held=s.queue.slots[0].uid;for(let bar=2;bar<5;bar++){const hold=s.boundary({bar,first:false,start:bar*4*60/92});assert.equal(hold.timeline.length,1);assert.equal(hold.timeline[0].uid,held);complete(hold);}s.setParam('mode','auto');const advertised=s.queue.slots[1].uid;const resume=s.boundary({bar:5,first:false,start:20*60/92});assert.equal(resume.timeline[0].uid,advertised);
});
test('editing recomputes its duration and tail while preserving earlier commitments; a newly scheduled edit is rejected',()=>{
 const {s}=freeSession();const before=s.queue.view();assert.ok(s.edit(before.slots[2].uid));assert.ok(s.commitEdit('Dm7'));assert.deepEqual(s.queue.slots[0],before.slots[0]);assert.deepEqual(s.queue.slots[1],before.slots[1]);assert.equal(s.queue.slots[2].id,'Dm7');assert.ok(s.queue.slots[2].evidence);assert.notEqual(s.queue.slots[3].uid,before.slots[3].uid);
 spec(s.queue.slots[0],'beats',1);spec(s.queue.slots[1],'beats',1);const target=s.queue.slots[1].uid;s.edit(target);s.boundary({bar:0,first:true,start:0});assert.equal(s.commitEdit('G7'),false);s.setParam('harmonyT',1.1);assert.ok(s.queue.slots.some(e=>e.uid===target));
});
test('3/4 uses true three-beat bars; bar-unit holds preserve fraction when meter changes',()=>{
 for(const [oldMeter,newMeter]of [[4,3],[3,4]]){const {s}=freeSession(oldMeter);spec(s.queue.slots[0],'bars',2,oldMeter);const uid=s.queue.slots[0].uid;complete(s.boundary({bar:0,first:true,start:0}));s.setParam('rhythm',newMeter===3?'waltz':'quarter');const changed=s.boundary({bar:1,first:false,start:oldMeter*60/92});assert.equal(changed.beats,newMeter);assert.equal(changed.timeline[0].uid,uid);assert.equal(changed.timeline[0].elapsedBeats,newMeter);assert.equal(changed.timeline[0].lengthBeats,newMeter);complete(changed);const next=s.boundary({bar:2,first:false,start:(oldMeter+newMeter)*60/92});assert.notEqual(next.timeline[0].uid,uid);}
 const {s}=freeSession(3);spec(s.queue.slots[0],'beats',1,3);spec(s.queue.slots[1],'beats',2,3);const p=s.boundary({bar:0,first:true,start:0});assert.equal(p.beats,3);assert.deepEqual(p.timeline.map(e=>e.lengthBeats),[1,2]);assert.equal(p.duration,3*60/92);
});
test('manual key changes stay on the real bar and Stop before onset retains the heard queue',()=>{
 const {s}=freeSession();s.transport.running=true;const original=s.queue.view();s.setKey({tonic:7,mode:'minor'});const plan=s.boundary({bar:1,first:false,start:2});assert.equal(s.queue.slots[0].uid,original.slots[0].uid);assert.equal(plan.timeline[0].id,'Gm');assert.equal(s.displayQueue().slots[0].id,original.slots[0].id);s.stop();assert.equal(s.queue.slots[0].uid,original.slots[0].uid);assert.equal(s.state.key.tonic,0);
});
test('internal chord attacks retain bar phase and pedal bass sustains through its segment',()=>{
 const state={...defaults(),...snapshotScene(SCENES[3]),bpm:60};const c={id:'C',key:{tonic:0,mode:'major'}},g={id:'G',key:c.key};const plan=planHarmonyTimeline([{slot:c,nextSlot:g,startBeat:0,lengthBeats:1},{slot:g,nextSlot:c,startBeat:1,lengthBeats:3}],state,0);
 assert.ok(plan.events.some(e=>e.role==='harmony'&&e.time>=1&&e.time<1.04));const bass=plan.events.find(e=>e.role==='bass'&&e.time===1);assert.ok(bass.duration>2.8);assert.ok(plan.events.every(e=>e.time+e.duration<=4));assert.ok(plan.events.filter(e=>e.time<1).every(e=>e.time+e.duration<=1));
});
test('timeline melody keeps one decoder/phrase sequence per true bar and never empties quarter masks',()=>{
 const performer=createTimelineMelodyPerformer({random:seeded(8)}),key={tonic:0,mode:'major'},timeline=[{id:'C',key,chord:[60,64,67],nextChord:[61,64,67,70],startBeat:0,lengthBeats:3},{id:'D♭dim7',key,chord:[61,64,67,70],nextChord:[59,62,65,67],startBeat:3,lengthBeats:1}];let previous=0;
 for(let bar=0;bar<16;bar++){const p=performer.plan([60,64,67],{enabled:true,bar,style:'pop',rhythm:'quarter',temperature:1.5,key,timeline,chordId:'C'});assert.ok(p.contextEvents>=previous);previous=p.contextEvents;assert.equal(p.phrase.bar,bar%8);assert.ok(p.events.every(e=>Number.isFinite(e.midi)&&e.duration>0&&e.time+e.duration<=4*60/92));}
});
test('one-harmony timelines preserve frozen Melody event and context parity',()=>{
 const a=createMelodyPerformer({random:seeded(2026)}),b=createTimelineMelodyPerformer({random:seeded(2026)}),key={tonic:0,mode:'major'};
 for(let bar=0;bar<8;bar++){const options={enabled:true,bar,key,chordId:'C',nextChord:[59,62,67],rhythm:'swing'};const original=a.plan([60,64,67],options),adapted=b.plan([60,64,67],{...options,timeline:[{id:'C',key,chord:[60,64,67],nextChord:options.nextChord,startBeat:0,lengthBeats:4}]});assert.deepEqual(adapted.events,original.events);assert.equal(adapted.contextEvents,original.contextEvents);}
});
test('seeded model runs produce both internal changes and multi-bar holds in both meters',()=>{
 for(const meter of [3,4]){const {s}=freeSession(meter);s.setMelody(true);let internal=0,held=0;for(let bar=0;bar<16;bar++){const plan=s.boundary({bar,first:bar===0,start:bar*meter*60/92});internal+=plan.timeline.length>1;held+=plan.timeline[0].elapsedBeats>0;assert.equal(plan.beats,meter);assert.ok(plan.events.every(e=>Number.isFinite(e.midi)&&e.duration>0&&e.time>=0&&e.time+e.duration<=plan.duration));complete(plan);}assert.ok(internal>0);assert.ok(held>0);}
});
test('fractional meter remaps allow the short duration needed at an eighth/swing boundary',()=>{
 const key={tonic:0,mode:'major'},timeline=[{id:'C',key,chord:[60,64,67],nextChord:[62,65,69],startBeat:0,lengthBeats:.75},{id:'Dm',key,chord:[62,65,69],nextChord:[60,64,67],startBeat:.75,lengthBeats:2.25}];
 for(const rhythm of ['eighth','swing']){const melody=createTimelineMelodyPerformer({random:()=>.5});for(let bar=0;bar<8;bar++){const p=melody.plan([60,64,67],{enabled:true,bar,rhythm,beatsPerBar:3,key,timeline,chordId:'C'});assert.ok(p.events.length);assert.ok(p.events.every(e=>e.duration>0&&e.time+e.duration<=3*60/92));}}
});
test('regeneration during a planned bar still prefetches the tail, so audible onset never runs inference',()=>{
 const {s}=freeSession();for(const slot of s.queue.slots)spec(slot,'beats',1);const plan=s.boundary({bar:0,first:true,start:0});s.setParam('harmonyT',1.1);const original=s.queue.predict;let predictions=0;s.queue.predict=(...args)=>(predictions++,original(...args));complete(plan);assert.equal(predictions,0);assert.equal(s.queue.view().slots.length,4);
});
