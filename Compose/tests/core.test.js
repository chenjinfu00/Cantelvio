import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../frontend/src/session.js';
import {loadJointModel} from '../frontend/vendor/lib/joint-model.js';
import {Transport} from '../frontend/src/transport.js';
import {groupGain} from '../frontend/src/audio.js';
import {renderBar} from '../frontend/src/render.js';
import {SCENES,defaults,snapshotScene,normalizeScene} from '../frontend/src/scenes.js';
import {ORCHESTRA_GROUP_IDS} from '../frontend/src/orchestration.js';
import {defaultInstrumentBoard,activeInstrumentIds,routeInstrumentBar,normalizeInstrumentBoard} from '../frontend/src/instrument-board.js';
const fakeAudio=()=>({context:{state:'running',currentTime:0},ensureReady:async()=>{},panic(){this.stopped=true;},setMix(){},setRoleMix(){},setMaster(){},stopGroup(role){this.stoppedRole=role;},play(e,at){this.events.push({...e,at});},events:[]});
const seeded=seed=>()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296;};
function playing(seed=3){const a=fakeAudio(),s=new Session(a,{random:seeded(seed)});s.transport.running=true;return {a,s};}
function play(s,bar,start=bar*3){const plan=s.boundary({bar,first:bar===0,start});s.transport.frame={bar,start,duration:plan.duration,beats:plan.beats};plan.onStart();for(const t of plan.transitions)t.onStart();return plan;}

test('stop during loading and rapid restart cannot schedule old notes',async()=>{let ready;const audio=fakeAudio();audio.ensureReady=()=>new Promise(r=>ready=r);const tasks=[];const transport=new Transport({audio,boundary:()=>({events:[{role:'harmony'}],duration:2,beats:4}),setTimer:f=>(tasks.push(f),tasks.length),clearTimer:()=>{}});const old=transport.start();transport.stop();ready();await old;assert.equal(audio.events.length,0);audio.ensureReady=async()=>{};await transport.start();assert.equal(audio.events.length,1);const stale=tasks.at(-1);transport.stop();await transport.start();stale();assert.equal(audio.events.length,2);});
test('late or suspended clocks stop without accumulated catch-up',async()=>{const audio=fakeAudio(),tasks=[];const transport=new Transport({audio,boundary:()=>({events:[],duration:2,beats:4}),setTimer:f=>(tasks.push(f),1),clearTimer:()=>{}});await transport.start();audio.context.currentTime=10;tasks.at(-1)();assert.equal(transport.running,false);assert.ok(audio.stopped);});
test('moderate scheduler lag and inference overrun never collapse notes into catch-up attacks',async()=>{for(const inferenceOverrun of [false,true]){const a=fakeAudio(),tasks=[];let count=0;const t=new Transport({audio:a,boundary:()=>{if(inferenceOverrun&&count++)a.context.currentTime+=.3;return {duration:1.2,beats:4,events:[{time:0},{time:.15},{time:.3}]};},setTimer:f=>(tasks.push(f),tasks.length),clearTimer:()=>{}});await t.start();a.context.currentTime=inferenceOverrun?1.22:1.6;tasks.at(-1)();assert.equal(t.running,false);assert.equal(a.events.length,3);}});
test('default clock preserves the native global timer receiver',async()=>{const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;let calls=0;try{globalThis.setTimeout=function(){assert.equal(this,globalThis);calls++;return 123;};globalThis.clearTimeout=function(){assert.equal(this,globalThis);};const t=new Transport({audio:fakeAudio(),boundary:()=>({events:[],duration:2,beats:4})});await t.start();assert.equal(t.running,true);assert.equal(calls,2);t.stop();}finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}});

test('model A/B starts a fresh timeline when stopped and refuses a mid-play swap',()=>{
 const s=new Session(fakeAudio(),{random:seeded(19)}),old=s.composer.timeline;
 const candidate={...loadJointModel()};
 assert.equal(s.selectModel(candidate),true);
 assert.equal(s.composer.model,candidate);
 assert.ok(s.composer.timeline>old);
 assert.equal(s.composer.locked,0);
 s.transport.running=true;
 assert.equal(s.selectModel(loadJointModel()),false);
 assert.equal(s.composer.model,candidate);
 s.stop();
});

test('mix groups are independent; Melody Off stops melody notes, mute only changes the mix',()=>{
 const mix={harmony:0,bass:.8,melody:.6},mutes={harmony:false,bass:false,melody:false};
 assert.equal(groupGain(mix,mutes,'bass'),.8);assert.equal(groupGain(mix,mutes,'melody'),.6);mutes.bass=true;assert.equal(groupGain(mix,mutes,'bass'),0);assert.equal(groupGain(mix,mutes,'melody'),.6);
 const {a,s}=playing(5);s.state.style='pop';s.setParam('style','pop');s.setMelody(true);s.mute('melody');
 assert.equal(s.state.melodyOn,true);
 const withMelody=play(s,0).events.filter(e=>e.role==='melody').length;
 s.setMelody(false);assert.equal(a.stoppedRole,'melody');
 const without=play(s,1).events.filter(e=>e.role==='melody').length;
 assert.ok(withMelody>0,'muted melody is still scheduled');assert.equal(without,0);
});

test('orchestral layer is opt-in and preserves the original model events and chord chart',()=>{
 const plain=playing(15),layered=playing(15);
 plain.s.setParam('mode','auto');layered.s.setParam('mode','auto');
 plain.s.composer.ensureBar(2);layered.s.composer.ensureBar(2);
 assert.equal(plain.s.state.orchestra.enabled,false);
 layered.s.setOrchestraEnabled(true);
 assert.equal(layered.s.setOrchestraGroup('woodwinds','off'),true);
 const a=play(plain.s,0),b=play(layered.s,0);
 assert.deepEqual(b.timeline,a.timeline);
 assert.deepEqual(b.events.filter(e=>['harmony','bass','melody'].includes(e.role)),a.events);
 const orchestra=b.events.filter(e=>ORCHESTRA_GROUP_IDS.includes(e.role));
 assert.ok(orchestra.length>0);
 assert.ok(orchestra.every(e=>e.role!=='woodwinds'&&e.time>=0&&e.time<b.duration&&e.duration>0));
 assert.equal(layered.s.setOrchestraGroup('not-a-group','off'),false);
 for(const id of ORCHESTRA_GROUP_IDS.filter(id=>id!=='low_strings'))layered.s.setOrchestraGroup(id,'off');
 assert.equal(layered.s.setOrchestraGroup('low_strings','off'),true,'all groups can be turned off');
 assert.equal(layered.s.state.orchestra.enabled,false);
 layered.s.setOrchestraEnabled(false);
 assert.equal(layered.s.state.orchestra.enabled,false);
});

test('instrument board switches fixed/walk and rotates only participating enabled groups by role',()=>{
 const board=defaultInstrumentBoard();
 assert.deepEqual([...activeInstrumentIds(board,0)].sort(),['bass','harmony']);
 board.walk=true;board.every=2;
 board.lanes.bass.walk=true;board.lanes.woodwinds.enabled=true;board.lanes.woodwinds.walk=true;board.lanes.woodwinds.role='bass';
 board.lanes.melody.enabled=true;board.lanes.melody.walk=true;
 board.lanes.high_strings.enabled=true;board.lanes.high_strings.walk=true;
 assert.equal(activeInstrumentIds(board,0).has('bass'),true);
 assert.equal(activeInstrumentIds(board,1).has('woodwinds'),false);
 assert.equal(activeInstrumentIds(board,2).has('bass'),false);
 assert.equal(activeInstrumentIds(board,2).has('woodwinds'),true);
 assert.equal(activeInstrumentIds(board,0).has('melody'),true);
 assert.equal(activeInstrumentIds(board,2).has('high_strings'),true);
 assert.equal(activeInstrumentIds(board,2).has('harmony'),true,'fixed group remains on');
 board.walk=false;
 assert.equal(activeInstrumentIds(board,2).has('bass'),true,'fixed mode plays every enabled group');
 board.lanes.harmony.role='bass';board.lanes.woodwinds.role='melody';board.lanes.high_strings.enabled=false;
 const score={beats:4,duration:2,stepTime:pos=>pos/8,events:[
  {role:'harmony',midi:64,time:0,duration:.5,velocity:.5},
  {role:'bass',midi:40,time:0,duration:.5,velocity:.7},
  {role:'melody',midi:72,time:.5,duration:.5,velocity:.6}]};
 const routed=routeInstrumentBar(score,board,defaults(),0);
 assert.equal(routed.find(e=>e.role==='harmony').midi,52,'bass source fitted to chord instrument range');
 assert.equal(routed.find(e=>e.role==='woodwinds').midi,72);
 assert.equal(routed.some(e=>e.role==='high_strings'),false);
 assert.equal(routed.find(e=>e.role==='melody').midi,72);
 for(const lane of Object.values(board.lanes))lane.enabled=false;
 assert.deepEqual(routeInstrumentBar(score,board,defaults(),0),[],'all lanes off is allowed');
 assert.equal(normalizeInstrumentBoard({walk:true,every:999,lanes:{bass:{role:'invalid',mode:'bad'}}}).lanes.bass.role,'bass');
 assert.equal(normalizeInstrumentBoard({lanes:{melody:{mode:'auto'}}}).lanes.melody.walk,true,'old Auto config migrates');
});

test('every scene renders finite events inside the audio buses, for unusual chords too',()=>{
 for(const scene of SCENES){
  const {s}=playing(9);s.selectScene(scene.id);s.transport.running=false;s.applyScene(scene.id);s.transport.running=true;s.setMelody(true);
  for(let bar=0;bar<3;bar++){const plan=play(s,bar);assert.ok(plan.events.length>0,`${scene.id} bar ${bar}`);
   for(const e of plan.events){assert.ok(['harmony','bass','melody'].includes(e.role));assert.ok(Number.isFinite(e.midi)&&e.duration>0&&e.time>=0&&e.time<plan.duration,JSON.stringify(e));assert.ok(e.velocity>0&&e.velocity<=1);}}
 }
});

test('scene changes queue for the next available bar and never alter scheduled bars',()=>{
 const {s}=playing(4);s.setParam('mode','auto');
 const first=play(s,0).timeline;s.selectScene('velvet');
 assert.equal(s.state.scene,'warm');assert.equal(s.pendingScene,'velvet');
 s.selectScene('velvet');assert.equal(s.pendingScene,null);s.selectScene('air');
 s.composer.ensureBar(1);const bar1=s.composer.bars[1];assert.equal(bar1.sceneSwitch,'air');assert.equal(bar1.cond.style,'ambient');
 play(s,1);assert.equal(s.state.scene,'air');assert.equal(s.soundingScene,'air');assert.equal(s.pendingScene,null);
 assert.deepEqual(s.barSpans(0).map(x=>x.label),first.map(x=>x.label));assert.equal(s.state.bpm,92);
});

test('Hold never changes key or chord; Auto regenerates from the next available bar',()=>{
 const {s}=playing(6);s.setParam('keyWalk',true);s.setParam('keyEvery',4);
 const chord=s.lastHeard.chord;for(let bar=0;bar<6;bar++)play(s,bar);
 assert.deepEqual(s.lastHeard.chord,chord);assert.deepEqual(s.state.key,{tonic:0,mode:'major'});
 assert.ok(s.composer.steps.slice(0,s.composer.locked).every(x=>!x.change||x.g===0));
 s.setParam('mode','auto');assert.equal(s.composer.bars[6]?.cond.mode??'auto','auto');
 for(let bar=6;bar<12;bar++)play(s,bar);
 assert.ok(s.composer.steps.slice(96,s.composer.locked).some(x=>x.change),'Auto moves on');
});

test('advertised chart bars are exactly what plays; scheduled bars cannot be edited',()=>{
 const {s}=playing(7);s.setParam('mode','auto');s.setParam('changeMode','free');
 for(let bar=0;bar<10;bar++){
  s.composer.ensureBar(bar+1);
  const advertised=s.chartView().rows.find(r=>r.bar===bar).segments.map(x=>[x.uid,x.label,x.startBeat,x.lengthBeats]);
  const plan=play(s,bar);
  assert.deepEqual(plan.timeline.map(x=>[x.uid,x.label,x.startBeat,x.lengthBeats]),advertised,`bar ${bar+1}`);
  assert.equal(s.edit(plan.timeline[0].uid),null,'scheduled chord is locked');
  const view=s.chartView();assert.equal(view.baseBar,Math.floor(bar/4)*4);assert.equal(view.rows.length,8);
 }
});

test('editing a future chord from the chart keeps earlier bars and plays the edit',()=>{
 const {s}=playing(8);s.setParam('mode','auto');s.setParam('changeMode','bar');
 play(s,0);s.composer.ensureBar(5);
 const target=s.chartView().rows.find(r=>r.bar===3).segments[0],before=s.composer.steps.slice(0,target.step).map(x=>[x.R,x.chord.root,x.bass,x.mel]);
 const intent=s.edit(target.uid);assert.ok(intent);assert.ok(s.editContext(target.uid).candidates.length>0);
 assert.equal(s.commitEdit('D♭maj7'),true);assert.equal(s.commitEdit('C'),false,'intent is consumed');
 s.composer.ensureBar(5);
 assert.deepEqual(s.composer.steps.slice(0,target.step).map(x=>[x.R,x.chord.root,x.bass,x.mel]),before);
 for(let bar=1;bar<4;bar++)play(s,bar);
 assert.equal(s.barSpans(3)[0].label,'D♭maj7');
 const stale=s.edit(s.chartView().rows.find(r=>r.bar===5).segments[0].uid);s.setParam('harmonyT',1.1);assert.equal(s.commitEdit('E'),false,'regeneration invalidates open edits');assert.ok(stale);
});

test('Stop restarts from the last heard chord with a fresh chart',()=>{
 const {s}=playing(10);s.setParam('mode','auto');for(let bar=0;bar<5;bar++)play(s,bar);
 const heard=s.lastHeard,timeline=s.composer.timeline;s.stop();
 assert.ok(s.composer.timeline>timeline);assert.deepEqual(s.composer.steps[0].chord,heard.chord);assert.equal(s.chartView().baseBar,0);assert.equal(s.composer.lockedBars,0);
});

test('a manual voice edit does not cancel other voices pending scene automation',()=>{const a=fakeAudio(),edits=[];a.setRoleMix=(...args)=>edits.push(args);const s=new Session(a);s.transport.running=true;s.selectScene('velvet');s.boundary({bar:0,first:true,start:2});s.mute('melody');assert.deepEqual(edits,[['melody',s.state.mix.melody,true]]);});

test('saved scenes from the earlier console are kept and completed',()=>{
 const legacy={harmonyStyle:'jazz',rhythm:'waltz',texture:'alberti',chordInstrument:'organ',bassInstrument:'off',melodyInstrument:'bell',harmonyT:1.2,mix:{harmony:.5}};
 const scene=normalizeScene(legacy,'warm');
 assert.equal(scene.style,'jazz');assert.equal(scene.meter,3);assert.equal(scene.chordInstrument,'organ');assert.equal(scene.bassInstrument,'piano');assert.equal(scene.harmonyT,1.2);assert.equal(scene.mix.harmony,.5);assert.ok(scene.mix.bass>0);
 const {s}=playing(2);s.saved.warm=legacy;s.transport.running=false;s.applyScene('warm');assert.equal(s.state.meter,3);assert.equal(s.composer.bars[0].beats,3);
 assert.deepEqual(Object.keys(snapshotScene(defaults())).sort(),Object.keys(normalizeScene({},'air')).sort());
});

test('long Hold sessions and Stop after many bars stay usable (old steps released)',()=>{
 const {s}=playing(5);
 for(let bar=0;bar<30;bar++){s.composer.ensureBar(bar+2);play(s,bar,bar*3);s.chartView();}
 assert.ok(s.composer.pruned>0);
 s.stop();assert.equal(s.composer.lockedBars,0);assert.equal(s.chartView().rows.length,8);
});

test('a change close to the next bar starts one bar later, sized by measured generation speed',()=>{
 const {a,s}=playing(6);s.setParam('mode','auto');
 for(let bar=0;bar<14;bar++){s.composer.ensureBar(bar+8);play(s,bar,bar*3);}
 a.context.currentTime=100;s.composer.stats.msPerPosition=1;
 s.transport.nextAt=102.5;assert.equal(s.firstEditableBar(),s.composer.lockedBars);
 s.transport.nextAt=100.4;assert.equal(s.firstEditableBar(),s.composer.lockedBars+1);
 s.composer.stats.msPerPosition=8;s.transport.nextAt=102.5;assert.ok(s.firstEditableBar()>s.composer.lockedBars,'slow devices lock earlier');
});
