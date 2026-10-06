import test from 'node:test';
import assert from 'node:assert/strict';
import {Composer,METERS} from '../frontend/src/composer.js';
import {renderBar,exactNotes,performanceNotes} from '../frontend/src/render.js';
import {defaultInstrumentBoard,normalizeInstrumentBoard,routeInstrumentBar} from '../frontend/src/instrument-board.js';
import {defaults} from '../frontend/src/scenes.js';
import {loadJointModel} from '../frontend/vendor/lib/joint-model.js';
import {loadExpression} from '../frontend/vendor/lib/joint-expression.js';
import {loadArranger} from '../frontend/vendor/lib/joint-arranger.js';
import {QUALITIES} from '../frontend/vendor/lib/chord-vocabulary.js';
import {Session} from '../frontend/src/session.js';

const base=loadJointModel(),expression=loadExpression(base),arranger=loadArranger();
function rng(){let state=20260929;return ()=>((state=Math.imul(state,1664525)+1013904223|0)>>>0)/4294967296;}
function composerFor(meter){
 const composer=new Composer({model:base,expression,random:rng(),planBar:()=>({
  cond:{domain:1,styleId:3,beats:meter,harmonyT:.8,melodyT:.8,density:.5,mode:'auto',changeMode:'bar'},
  key:{tonic:0,mode:'major'}})});
 composer.reset({key:{tonic:0,mode:'major'},chord:{root:0,q:0},melody:67});
 composer.ensureBar(1);
 return composer;
}

test('all exposed meters reach the trained meter embedding and exact playback clock',()=>{
 const state=defaults();
 for(const [choice,meter] of Object.entries(METERS)){
  const composer=composerFor(Number(choice)),bar=composer.bars[1];
  assert.equal(bar.meterId,meter.id);
  assert.equal(bar.beatlen,meter.beatlen);
  assert.equal(bar.barlen,meter.barlen);
  assert.equal(bar.signature,meter.signature);
  const plan=renderBar({composer,index:1,state,bpm:92});
  assert.ok(Math.abs(plan.duration-meter.beats*60/92)<1e-9);
  const notes=performanceNotes(composer,1),byKey=new Map(plan.events.map(event=>[event.sourceKey,event]));
  for(const note of notes){
   const event=byKey.get(note.key);
   assert.ok(event,`missing exact note ${note.key} in ${meter.signature}`);
   assert.ok(Math.abs(event.time-note.onsetQuarter*60/92)<1e-8);
   assert.ok(Number.isFinite(event.duration)&&event.duration>0);
  }
 }
});

test('the backbone supplies audible pitches while expression supplies timing and dynamics',()=>{
 const composer=composerFor(4);
 assert.equal(composer.expressionFeedback,false);
 for(let bar=0;bar<2;bar++)for(const note of performanceNotes(composer,bar)){
  const step=composer.barSteps(bar)[Math.floor(note.onsetQuarter*4)];
  if(note.role===0){
   const tones=QUALITIES[step.chord.q].intervals.map(interval=>(step.chord.root+interval)%12);
   assert.ok(tones.includes(note.pitch%12));
  }else assert.equal(note.pitch,step[note.role===1?'bass':'mel']);
 }
 assert.ok(exactNotes(composer,1).length>0,'raw sidecar predictions remain inspectable');
});

test('learned six-group logits are applied only to user-enabled, role-compatible groups',()=>{
 const composer=composerFor(6),bar=composer.bars[1],notes=performanceNotes(composer,1);
 assert.ok(notes.length>0);
 const logits=arranger.classify(notes,bar.signature,bar.beats);
 assert.equal(logits.length,Math.min(notes.length,64));
 const map=new Map(notes.slice(0,64).map((note,i)=>[note.key,logits[i]]));
 const state=defaults(),board=defaultInstrumentBoard();
 board.lanes.woodwinds.enabled=true;
 board.lanes.woodwinds.role='harmony';
 board.lanes.keys.enabled=true;
 board.lanes.keys.role='harmony';
 const plan=renderBar({composer,index:1,state,bpm:92});
 for(const event of plan.events)event.groupLogits=map.get(event.sourceKey);
 plan.learnedArrangement=true;
 const routed=routeInstrumentBar(plan,board,state,1);
 assert.ok(routed.length>0);
 assert.ok(routed.every(event=>['harmony','bass','woodwinds','keys'].includes(event.role)));
 const learned=routed.filter(event=>['woodwinds','keys'].includes(event.role));
 assert.ok(learned.every(event=>plan.events.some(source=>source.sourceKey===event.sourceKey&&source.role==='harmony')));
 const manual=routeInstrumentBar({...plan,learnedArrangement:false},board,state,1);
 assert.ok(manual.filter(event=>event.role==='woodwinds').length>=learned.filter(event=>event.role==='woodwinds').length);
 assert.ok(manual.filter(event=>event.role==='keys').length>=learned.filter(event=>event.role==='keys').length);
 assert.deepEqual(normalizeInstrumentBoard({...board,learnedArrangement:false}).learnedArrangement,false);
});

test('six-group model switch bypasses classification work when off',async()=>{
 let calls=0;
 const arranger={classify(notes){calls++;return notes.map(()=>[1,0,0,0,0,0]);}};
 const audio={context:{state:'running',currentTime:0},setOrchestra(){},stopGroup(){},panic(){}};
 const session=new Session(audio,{random:rng(),composerOptions:{model:base,expression},arranger});
 session.composer.ensureBar(1);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(calls,0,'all six groups are off by default');
 session.setInstrumentEnabled('woodwinds',true);
 session.setLearnedArrangement(false);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(calls,0,'turning the switch off cancels pending work');
 session.setLearnedArrangement(true);
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok(calls>0,'switching on prepares complete, unscheduled bars');
 session.setLearnedArrangement(false);
 assert.equal(session.arranged.size,0);
 session.stop();
});
