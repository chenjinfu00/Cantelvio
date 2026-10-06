import test from 'node:test';
import assert from 'node:assert/strict';
import {MELODY_WEIGHTS as W} from '../public/tonnetz/lib/melody-transformer-weights.js';
import {melodyForward,createMelodyDecoder} from '../public/tonnetz/lib/melody-model.js';
import {createMelodyPerformer,SOLO_STYLES} from '../public/tonnetz/improvisation.js';
import {predictNext,voiceChord} from '../public/tonnetz/lib/harmony-models.js';
const delta=(a,b)=>{const af=a.flat(Infinity),bf=b.flat(Infinity);return Math.max(...af.map((n,i)=>Math.abs(n-bf[i])));};
const rng=(seed=87)=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
test('melody is a trained 4-layer 8-head model with disjoint held-out phrase validation',()=>{
 assert.equal(W.architecture.layers,4);assert.equal(W.architecture.heads,8);assert.equal(W.training.trained,true);
 assert.ok(W.training.parameterCount>150000);assert.ok(W.training.validation.pitchCE<W.training.unigramPitchCE);
 assert.ok(W.training.validation.pitchCE<W.training.initial.pitchCE*.5);
 assert.ok(W.training.validation.durationCE<W.training.initial.durationCE*.5);
 assert.equal(W.training.styles.length,5);assert.match(W.training.corpus,/Original/);
});
test('browser melody decoder matches independently exported PyTorch logits and all 32 attention heads',()=>{
 for(const p of W.parityProbes){const result=melodyForward(p.features,p.nextChord);for(const name of ['pitch','duration','affinity','attention'])assert.ok(delta(result[name],p[name])<1e-5,name);}
});
test('melody attention is causal and upcoming harmony only conditions melodic output, never leaks into feedback',()=>{
 const p=W.parityProbes[0],features=p.features.map(r=>[...r]);
 const original=melodyForward(features,p.nextChord);features.at(-1)[0]=(features.at(-1)[0]+5)%24;
 const altered=melodyForward(features,p.nextChord);
 assert.ok(delta(original.pitch.slice(0,-1),altered.pitch.slice(0,-1))<1e-10);
 assert.ok(delta(original.pitch.at(-1),altered.pitch.at(-1))>.05);
 assert.ok(delta(original.affinity.at(-1),altered.affinity.at(-1))>.005,'melodic history changes learned harmonic feedback');
 const future=p.nextChord.map(row=>row.map((_,i)=>[1,5,8].includes(i)?1:0));const differentNext=melodyForward(p.features,future);
 assert.ok(delta(original.pitch,differentNext.pitch)>.05);
 assert.equal(delta(original.affinity,differentNext.affinity),0);
 assert.equal(delta(original.duration,differentNext.duration),0);
 for(const layer of original.attention)for(const head of layer)for(const [t,row] of head.entries()){
  assert.ok(Math.abs(row.reduce((a,b)=>a+b,0)-1)<1e-10);assert.ok(row.slice(t+1).every(v=>v===0));
 }
});
test('streaming melody cache remains bounded after a long performance and reset clears learned context',()=>{
 const d=createMelodyDecoder(),p=W.parityProbes[0];let result;
 for(let i=0;i<220;i++)result=d.step(p.features[i%p.features.length],p.nextChord[i%p.nextChord.length]);
 assert.equal(d.size,W.architecture.contextLength);assert.ok(result.pitchLogits.every(Number.isFinite));d.reset();assert.equal(d.size,0);
});
test('learned melody feedback changes harmony probabilities while preserving the must-change constraint',()=>{
 const player=createMelodyPerformer({random:rng()});let phrase;
 for(let bar=0;bar<4;bar++)phrase=player.plan(voiceChord('G7'),{enabled:true,chordId:'G7',style:'jazz',bar,nextChord:voiceChord('C')});
 const plain=predictNext(['C','Dm7','G7'],{palette:'jazz'});
 const coupled=predictNext(['C','Dm7','G7'],{palette:'jazz',melodyFeedback:{...phrase.feedback,strength:.6}});
 const baseline=new Map(plain.distribution.map(x=>[x.id,x.probability]));
 assert.ok(coupled.distribution.reduce((s,x)=>s+Math.abs(x.probability-baseline.get(x.id)),0)>.01);
 assert.equal(coupled.distribution.find(x=>x.id==='G7').probability,0);
 assert.equal(coupled.distribution.find(x=>x.id==='G7/B').probability,0);
 assert.ok(Math.abs(coupled.distribution.reduce((s,x)=>s+x.probability,0)-1)<1e-10);
 const off=predictNext(['C','Dm7','G7'],{palette:'jazz',melodyFeedback:{...phrase.feedback,strength:0}});
 assert.deepEqual(off.distribution,plain.distribution);
});
test('all five learned styles form bounded phrases with rests and varied note lengths across 24 keys',()=>{
 const styleLengths=new Map(SOLO_STYLES.map(style=>[style.id,new Set()]));
 for(const style of SOLO_STYLES)for(const mode of ['major','minor'])for(let tonic=0;tonic<12;tonic++){
  const player=createMelodyPerformer({random:rng(71+tonic)}),key={tonic,mode};let count=0,gaps=0;const pitches=new Set(),lengths=new Set();let previous;
  for(let bar=0;bar<8;bar++){
   const ids=['C','G7','Am','F','Dm7','G7','C','C'],id=ids[bar],result=player.plan(voiceChord(id),{enabled:true,chordId:id,nextChord:voiceChord(ids[(bar+1)%8]),style:style.id,bar,key});
   let end=0;for(const e of result.events){count++;pitches.add(e.midi);lengths.add(Math.round(e.duration*20));if(e.time-end>.12)gaps++;end=e.time+e.duration;if(previous!==undefined&&bar>0)assert.ok(Math.abs(e.midi-previous)<=12);previous=e.midi;assert.ok(e.time>=0&&end<=e.barDuration&&e.duration>0);}
   if(end<4*60/92-.15)gaps++;
  }
  assert.ok(count>=8&&count<=100,`${style.id}: ${count}`);assert.ok(pitches.size>=3);assert.ok(gaps>0);for(const n of lengths)styleLengths.get(style.id).add(n);
 }
 for(const [style,lengths] of styleLengths)assert.ok(lengths.size>1,style);
});
test('real score provenance and validation are reported separately with disjoint works',()=>{
 assert.equal(W.training.realCorpus.license,'CC0-1.0');
 assert.ok(W.training.realCorpus.worksUsed.train>=100);assert.ok(W.training.realCorpus.worksUsed.validation>=10);
 assert.ok(W.training.realValidation.pitchCE<W.training.realInitial.pitchCE);
 assert.ok(W.training.realValidation.durationCE<W.training.realInitial.durationCE);
 assert.ok(W.training.realCorpus.excerpts.train>500);
 assert.equal(W.featureNames.at(-2),'motifPitch');assert.equal(W.featureNames.at(-1),'motifDuration');
});
test('explicit remembered motif changes the learned melodic distribution',()=>{
 const p=W.parityProbes[0],features=p.features.map(r=>[...r]);
 const base=melodyForward(features,p.nextChord);
 features.at(-1)[13]=features.at(-1)[13]===12?16:12;features.at(-1)[14]=2;
 const altered=melodyForward(features,p.nextChord);
 assert.ok(delta(base.pitch.at(-1),altered.pitch.at(-1))>.1);
 assert.ok(delta(base.duration.at(-1),altered.duration.at(-1))>.1);
});
test('phrase memory survives harmony edits but resets on musical mode changes and solo disable',()=>{
 const player=createMelodyPerformer({random:rng(199)}),options={enabled:true,chordId:'C',bar:0};
 let r=player.plan(voiceChord('C'),options);assert.equal(r.phrase.role,'statement');
 const first=r.phrase.motifEvents;r=player.plan(voiceChord('G7'),{...options,chordId:'G7',bar:1});assert.ok(r.phrase.motifEvents>first);
 const theme=r.phrase.motifEvents;r=player.plan(voiceChord('Db7'),{...options,chordId:'Db7',bar:2});assert.equal(r.phrase.role,'answer');assert.equal(r.phrase.motifEvents,theme);
 r=player.plan(voiceChord('Db7'),{...options,chordId:'Db7',bar:3,style:'ambient'});assert.ok(r.phrase.motifEvents>0);assert.equal(r.phrase.role,'statement');assert.equal(r.phrase.bar,0);
 player.plan(voiceChord('C'),{enabled:false});assert.equal(player.getFeedback(),null);
 r=player.plan(voiceChord('C'),{...options,bar:6});assert.ok(r.phrase.motifEvents>0);assert.equal(r.phrase.bar,0);
 assert.ok(r.events.length>0);
});
test('opening rests and cadential breathing remain available in call and response',()=>{
 let openings=0,breaths=0;
 for(let seed=1;seed<=12;seed++){
  const player=createMelodyPerformer({random:rng(seed)});
  for(let bar=0;bar<8;bar++){
   const r=player.plan(voiceChord('C'),{enabled:true,chordId:'C',bar,pattern:'answer',style:'pop',feel:0});
   if(r.events[0]?.beat>0)openings++;
   if([3,7].includes(bar)&&r.events.at(-1)?.time+r.events.at(-1)?.duration<2.2)breaths++;
  }
 }
 assert.ok(openings>0,'learned opening rests must not be masked');assert.ok(breaths>12,'phrase endings should breathe');
});
test('cadences and motif returns do not become five or more stuck repeated attacks',()=>{
 for(const style of SOLO_STYLES){
  const player=createMelodyPerformer({random:rng(31)});let last=null,run=0;
  const ids=['C','G','Am','F','Dm7','G7','C/E','C'];
  for(let bar=0;bar<16;bar++)for(const e of player.plan(voiceChord(ids[bar%8]),{enabled:true,style:style.id,bar,chordId:ids[bar%8],nextChord:voiceChord(ids[(bar+1)%8]),feel:0}).events){
   run=e.midi===last?run+1:1;last=e.midi;assert.ok(run<=4,`${style.id} stuck on ${last}`);
  }
 }
});
test('cadence breathing never empties legal durations under quarter rhythm in 3/4',()=>{
 for(const style of SOLO_STYLES){
  const player=createMelodyPerformer({random:rng(893)});
  for(let bar=0;bar<24;bar++){
   const r=player.plan(voiceChord(bar%2?'G7':'C'),{enabled:true,style:style.id,bar,rhythm:'quarter',beatsPerBar:3,register:'high',temperature:1.5,density:.55});
   assert.ok(r.events.length>0);assert.ok(r.events.every(e=>Number.isFinite(e.duration)&&e.duration>0&&e.time+e.duration<=e.barDuration));
  }
 }
});
