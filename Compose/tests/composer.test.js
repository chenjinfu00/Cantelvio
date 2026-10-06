import test from 'node:test';
import assert from 'node:assert/strict';
import {Composer,sampleLogits,sampleFactored,BASS_RANGE,MELODY_RANGE,mod12} from '../frontend/src/composer.js';
import {CONTEXT_STEPS} from '../frontend/vendor/lib/joint-model.js';

const seeded=seed=>()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296;};
const COND={domain:1,styleId:3,style:'lieder',harmonyT:.8,melodyT:.8,density:.5,mode:'auto',changeMode:'free',beats:4,scene:'warm'};
function composer({seed=11,cond={},plan=null}={}){
 const c=new Composer({random:seeded(seed),planBar:plan||((index,prev)=>({cond:{...COND,...cond},key:prev?prev.key:{tonic:0,mode:'major'},keyAge:0}))});
 c.reset({key:{tonic:0,mode:'major'},chord:{root:0,q:0}});
 return c;
}
const changesIn=(c,b)=>c.barSteps(b).filter(s=>s.change).map(s=>s.pos);

test('temperature changes which event is chosen, not how often events happen',()=>{
 const logits=new Float32Array([0,0,2.2,1.2,0.6,0.3,-0.2,-1]),allowed=i=>i>=2,isEvent=i=>i>=4;
 const rate=T=>{const r=seeded(3);let events=0;for(let i=0;i<6000;i++)if(sampleFactored(logits,allowed,isEvent,{temperature:T,random:r})>=4)events++;return events/6000;};
 const cold=rate(.3),hot=rate(1.6);
 assert.ok(Math.abs(cold-hot)<.03,`${cold} vs ${hot}`);
 const r=seeded(4);const picks=new Set();for(let i=0;i<400;i++)picks.add(sampleLogits(logits,i=>i>=4,{temperature:.05,topP:.95,random:r}));
 assert.deepEqual([...picks],[4]);
 assert.equal(sampleLogits(logits,()=>false,{random:r}),-1);
});

test('same seed, same timeline; Every bar writes one new chord on each downbeat',()=>{
 const a=composer({seed:5,cond:{changeMode:'bar'}}),b=composer({seed:5,cond:{changeMode:'bar'}});
 a.ensureBar(9);b.ensureBar(9);
 assert.deepEqual(a.steps.map(s=>[s.R,s.chord.root,s.chord.q,s.bass,s.mel]),b.steps.map(s=>[s.R,s.chord.root,s.chord.q,s.bass,s.mel]));
 for(let bar=1;bar<10;bar++)assert.deepEqual(changesIn(a,bar),[0],`bar ${bar+1}`);
});

test('Hold keeps the chord while rhythm, bass and melody continue',()=>{
 const c=composer({seed:8,cond:{mode:'hold',style:'pop',domain:0,styleId:0}});
 c.ensureBar(7);
 assert.ok(c.steps.slice(1).every(s=>!s.change&&s.chord.root===0&&s.chord.q===0));
 assert.ok(c.steps.filter(s=>s.bassOn).length>4,'bass keeps playing');
 assert.ok(c.steps.filter(s=>s.melOn).length>4,'melody keeps playing');
 assert.ok(c.steps.filter(s=>s.R>=4).length>4,'accompaniment keeps playing');
});

test('Free changes chords only on beats and never holds one longer than two bars',()=>{
 for(const seed of [1,2,3]){
  const c=composer({seed});c.ensureBar(19);
  let last=0;
  for(const s of c.steps.slice(1)){if(s.change){assert.equal(s.pos%4,0,`step ${s.g}`);assert.ok(s.g-last<=32,`chord held ${s.g-last} steps`);last=s.g;}}
  assert.ok(c.steps.length-last<=32+16);
 }
});

test('window restarts keep encodings valid over long generation',()=>{
 const c=composer({seed:21,cond:{domain:0,styleId:1,style:'jazz'}});
 c.ensureBar(29);
 assert.ok(c.stats.rebuilds>=3,`rebuilds ${c.stats.rebuilds}`);
 assert.ok(c.decoder.length<=(CONTEXT_STEPS-1)*4);
 for(const s of c.steps.slice(1)){
  if(s.bass>=0)assert.ok(s.bass>=BASS_RANGE[0]&&s.bass<=BASS_RANGE[1],`bass ${s.bass}`);
  if(s.mel>=0)assert.ok(s.mel>=MELODY_RANGE[0]&&s.mel<=MELODY_RANGE[1],`melody ${s.mel}`);
  assert.ok([2,3,4,5].includes(s.R));
  assert.ok(s.chord.q>=0&&s.chord.q<40&&s.chord.root>=0&&s.chord.root<12);
 }
});

test('editing a future chord keeps every earlier step and regenerates the suffix',()=>{
 const c=composer({seed:13,cond:{changeMode:'bar'}});c.ensureBar(7);
 const g=c.bars[4].start,before=structuredClone(c.steps.slice(0,g)),revision=c.revision;
 assert.equal(c.edit(g,{root:1,q:11},5),true);
 assert.ok(c.revision>revision);assert.equal(c.steps.length,g);
 c.ensureBar(7);
 assert.deepEqual(c.steps.slice(0,g),before);
 const s=c.steps[g];
 assert.deepEqual(s.chord,{root:1,q:11});assert.equal(s.change,true);assert.equal(mod12(s.bass),5,'requested bass / inversion');
 assert.equal(c.edit(0,{root:2,q:0}),false,'the opening chord is not editable');
});

test('scheduled bars are frozen and notes crossing the barline stay consistent',()=>{
 const c=composer({seed:17,cond:{style:'pop',domain:0,styleId:0}});c.ensureBar(5);
 for(let bar=0;bar<3;bar++)c.lock(bar);
 const end=c.bars[2].start+c.bars[2].barlen,snapshot=structuredClone(c.steps.slice(0,end));
 assert.equal(c.edit(end-4,{root:5,q:0}),false,'a scheduled bar cannot be edited');
 c.truncate(0);
 assert.equal(c.steps.length,end,'truncation stops at the scheduled horizon');
 for(let k=0;k<4;k++){c.truncate(end);c.ensureBar(5);}
 assert.deepEqual(c.steps.slice(0,end),snapshot);
 for(const h of c.holds){
  const pitch=h.stream==='B'?'bass':'mel',on=h.stream==='B'?'bassOn':'melOn';
  for(let t=h.from;t<h.until;t++)assert.ok(c.steps[t][pitch]===c.steps[end-1][pitch]&&!c.steps[t][on],`held ${h.stream} at ${t}`);
  if(c.steps[h.until])assert.ok(c.steps[h.until][pitch]!==c.steps[end-1][pitch]||c.steps[h.until][on],'released where scheduled');
 }
});

test('a key change starts on the new tonic and moves the local key',()=>{
 const plan=(index,prev)=>({cond:COND,key:index>=3?{tonic:7,mode:'major'}:{tonic:0,mode:'major'},keyAge:0,forceTonic:index===3});
 const c=composer({seed:4,plan});c.ensureBar(5);
 const s=c.steps[c.bars[3].start];
 assert.deepEqual(s.chord,{root:7,q:0});assert.equal(mod12(s.bass),7);assert.deepEqual(s.key,{tonic:7,mode:'major'});
});

test('asynchronous prefetch resolves, and a new timeline cancels stale waits',async()=>{
 const keep=setInterval(()=>{},1000);
 try{
  const c=composer({seed:2});
  assert.equal(await c.prefetch(3),true);assert.ok(c.completeBars()>=3);
  const stale=c.prefetch(12);c.reset({key:{tonic:2,mode:'minor'},chord:{root:2,q:1}});
  assert.equal(await stale,false);assert.equal(c.steps.length,1);
 }finally{clearInterval(keep);}
});

test('a melody note tied over the barline is held to its scheduled release after regeneration',()=>{
 const c=composer({seed:19,cond:{style:'pop',domain:0,styleId:0}});c.ensureBar(5);
 const end=c.bars[3].start;
 Object.assign(c.steps[end-1],{mel:67,melOn:true});
 for(let t=end;t<end+5;t++)Object.assign(c.steps[t],{mel:67,melOn:false});
 Object.assign(c.steps[end+5],{mel:69,melOn:true});
 for(let bar=0;bar<3;bar++)c.lock(bar);
 assert.deepEqual(c.holds.find(h=>h.stream==='M'),{stream:'M',from:end,until:end+5});
 for(const seed of [1,2,3]){
  c.random=seeded(seed);c.truncate(end);c.ensureBar(5);
  for(let t=end;t<end+5;t++)assert.ok(c.steps[t].mel===67&&!c.steps[t].melOn,`held at ${t}`);
  assert.ok(c.steps[end+5].mel!==67||c.steps[end+5].melOn,'released at the scheduled step');
 }
});

test('long sessions release old steps without touching the context or the visible bars',()=>{
 const c=composer({seed:23,cond:{domain:0,styleId:0,style:'pop'}});
 for(let bar=0;bar<40;bar++){c.ensureBar(bar+2);c.lock(bar);}
 assert.ok(c.pruned>0&&c.steps[0]===null);
 assert.ok(c.pruned<=c.win.start&&c.pruned<=c.bars[40-12].start);
 for(let b=28;b<42;b++)assert.ok(c.chordSpans(b),`bar ${b+1} still available`);
 c.ensureBar(45);assert.ok(c.barComplete(45));
});

test('every note inside the playable ranges stays encodable after the window moves to another key',()=>{
 const G={tonic:7,mode:'major'},C={tonic:0,mode:'major'};
 const c=composer({seed:3,plan:(i)=>({cond:{...COND,domain:0,styleId:0,style:'pop'},key:i>=2?C:G,keyAge:0})});
 c.reset({key:G,chord:{root:7,q:0}});c.ensureBar(6);
 Object.assign(c.steps[40],{mel:MELODY_RANGE[0],melOn:true});Object.assign(c.steps[70],{mel:MELODY_RANGE[1],melOn:true});
 Object.assign(c.steps[44],{bass:BASS_RANGE[0],bassOn:true});Object.assign(c.steps[76],{bass:BASS_RANGE[1],bassOn:true});
 c.win=null;c.truncate(c.bars[6].start);
 const dec=c.decoder,orig=dec.position.bind(dec);let bad=0;
 dec.position=(input,want)=>{if(input.s>=2&&input.token>=(input.s===2?52:40))bad++;const out=orig(input,want);if(out&&out.some(Number.isNaN))bad++;return out;};
 c.ensureBar(9);
 assert.equal(c.win.refTonic,0);assert.equal(bad,0);
 assert.ok(MELODY_RANGE[1]-MELODY_RANGE[0]<=24&&BASS_RANGE[1]-BASS_RANGE[0]<=36,'ranges fit 36 / 48 pitch tokens from any base');
});
