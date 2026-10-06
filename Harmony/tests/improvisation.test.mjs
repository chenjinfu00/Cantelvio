import test from 'node:test';
import assert from 'node:assert/strict';
import {arrangementTransition,createRandomArranger} from '../public/tonnetz/arrangement-random.js';
import {buildMelodyBar,SOLO_STYLES,SOLO_INSTRUMENTS,SOLO_PATTERNS} from '../public/tonnetz/improvisation.js';
import {walkingBass,bassLanding} from '../public/tonnetz/walking-bass.js';
import {KEYS} from '../public/tonnetz/lib/tonality.js';
import {CHORD_VOCAB} from '../public/tonnetz/lib/chord-vocabulary.js';
import {voiceChord} from '../public/tonnetz/lib/harmony-models.js';
import {STYLES,RHYTHMS,PATTERNS,INSTRUMENTS,BASS_INSTRUMENTS,BASS_LINES} from '../public/tonnetz/accompaniment.js';
const pc=n=>((n%12)+12)%12;
function rng(seed=19){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
test('Markov arrangement rows are normalized with controllable mean dwell time and no absorbing styles',()=>{
 for(const style of STYLES)for(const every of [1,2,8,32])for(const wild of [false,true]){
  const row=arrangementTransition(style.id,every,wild);
  assert.ok(Math.abs(row.reduce((n,e)=>n+e.probability,0)-1)<1e-12);
  assert.equal(row.find(e=>e.id===style.id).probability,1-1/every);
  assert.ok(row.filter(e=>e.id!==style.id).every(e=>e.probability>0));
 }
 const a=createRandomArranger({random:rng()});a.configure({enabled:true,every:8});let changes=0;
 for(let n=0;n<16000;n++)if(a.tick())changes++;
 assert.ok(changes>1800&&changes<2200,`expected about 2000 transitions; got ${changes}`);
});
test('random arrangements stay valid and never alter user key, volume or solo-enable state',()=>{
 const a=createRandomArranger({random:rng()});assert.equal(a.tick(),null);
 a.configure({enabled:true,every:1,wild:true,tempo:true,bpm:100});const seen=new Set();
 for(let i=0;i<120;i++){
  const patch=a.tick();assert.ok(patch);seen.add(patch.accompaniment.style);
  for(const [field,entries] of Object.entries({style:STYLES,rhythm:RHYTHMS,pattern:PATTERNS,instrument:INSTRUMENTS,bassInstrument:BASS_INSTRUMENTS,bassLine:BASS_LINES}))assert.ok(entries.some(e=>e.id===patch.accompaniment[field]),field);
  assert.ok(patch.accompaniment.bpm>=88&&patch.accompaniment.bpm<=112);
  assert.ok(SOLO_STYLES.some(e=>e.id===patch.solo.style));assert.ok(SOLO_INSTRUMENTS.some(e=>e.id===patch.solo.instrument));
  for(const field of ['key','keyWalk','temperature','volume','soloEnabled'])assert.ok(!(field in patch.accompaniment));
  assert.ok(!('enabled' in patch.solo));
 }
 assert.equal(seen.size,4);const last=a.getState();a.configure({enabled:false});assert.equal(a.tick(),null);assert.equal(a.getState().style,last.style);
});
test('walking bass plans consonant strong beats and approaches the exact next landing in all keys/inversions',()=>{
 for(const key of KEYS)for(const chord of CHORD_VOCAB.filter((_,i)=>i%43===0))for(const beats of [3,4]){
  const current=voiceChord(chord.id),next=voiceChord(key.mode==='minor'?'Fm/C':'G7/B');
  const line=walkingBass(current,next,{key,beats,bar:key.tonic});
  assert.equal(line.length,beats);assert.equal(line[0].midi,bassLanding(current[0]));
  assert.equal(Math.abs(line.at(-1).midi-bassLanding(next[0])),1);
  for(const [i,note] of line.entries()){
   assert.ok(note.midi>=36&&note.midi<=55);
   if(i===0||i===2&&beats===4)assert.ok(chord.pcs.includes(pc(note.midi)));
   if(i)assert.ok(Math.abs(note.midi-line[i-1].midi)<=7);
  }
 }
});
test('solo stays silent by default, covers all styles and prepares then resolves strong-beat tensions',()=>{
 assert.deepEqual(buildMelodyBar([60,64,67]).events,[]);
 for(const style of SOLO_STYLES)for(const pattern of SOLO_PATTERNS)for(const key of KEYS)for(const beatsPerBar of [3,4]){
  const chord=[53,56,60,63],options={enabled:true,style:style.id,pattern:pattern.id,key,beatsPerBar,bar:key.tonic,previousMidi:76,nextChord:[55,59,62],density:.8};
  const {events}=buildMelodyBar(chord,options);
  assert.ok(events.length>0);
  for(const [i,e] of events.entries()){
   assert.ok(e.midi>=60&&e.midi<=83);assert.ok(e.velocity>0&&e.velocity<1);
   assert.ok(e.time>=0&&e.time+e.duration<e.barDuration);
   if(Number.isInteger(e.beat)&&e.beat%2===0&&!chord.map(pc).includes(pc(e.midi))){
    assert.ok(i>0?Math.abs(e.midi-events[i-1].midi)<=2:Math.abs(e.midi-76)<=2);
   }
   if(i&& !chord.map(pc).includes(pc(events[i-1].midi))) {
    assert.ok(chord.map(pc).includes(pc(e.midi)));
    const tonicOffset=key.tonic>6?key.tonic-12:key.tonic,base=60+tonicOffset;
    const playable=Array.from({length:24},(_,n)=>base+n).filter(n=>n>=60&&n<=83&&chord.map(pc).includes(pc(n)));
    const closest=Math.min(...playable.map(n=>Math.abs(n-events[i-1].midi)));
    assert.ok(Math.abs(e.midi-events[i-1].midi)<=Math.max(2,closest));
   }
   if(i)assert.ok(Math.abs(e.midi-events[i-1].midi)<=12);
  }
 }
});
test('solo style, rhythm, contour, density and register materially change the phrase',()=>{
 const base={enabled:true,density:1,bar:2,nextChord:[55,59,62]};
 const signature=o=>buildMelodyBar([60,64,67,71],{...base,...o}).events.map(e=>`${e.beat}:${e.midi}:${e.duration}`).join('|');
 assert.equal(new Set(SOLO_STYLES.map(s=>signature({style:s.id}))).size,5);
 assert.ok(new Set(SOLO_PATTERNS.map(p=>signature({pattern:p.id}))).size>=3);
 assert.notEqual(signature({rhythm:'eighth'}),signature({rhythm:'swing'}));
 assert.notEqual(signature({density:.15}),signature({density:1}));
 assert.ok(buildMelodyBar([60,64,67],{...base,register:'high'}).events.every(e=>e.midi>=72&&e.midi<=91));
});
