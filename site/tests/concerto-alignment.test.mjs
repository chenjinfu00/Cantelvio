import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {ScoreMap,SCORE_BASIS,scoreStart,loadScoreMap} from '../concerto/alignment.mjs';
import {settings,snapshot,WORK_ID} from '../concerto/session.mjs';
import {parseMidi,splitScore} from '../concerto/midi.mjs';
import {Transport,restoreState} from '../concerto/transport.mjs';
const bytes=fs.readFileSync(new URL('../concerto/assets/chopin-op21-mvt1.mid',import.meta.url));
const sha=createHash('sha256').update(bytes).digest('hex');
const data=JSON.parse(fs.readFileSync(new URL('../concerto/assets/chopin-op21-alignment.json',import.meta.url),'utf8'));
const map=new ScoreMap(data,sha),midi=parseMidi(bytes);
const close=(a,b)=>assert.ok(Math.abs(a-b)<2e-7,`${a} != ${b}`);
test('printed pickup keeps all three notes before the first complete bar',()=>{
  for(const [raw,beat] of [[.975,3.75],[1.2083333333333333,4],[1.8416666666666666,4.75]]){
    const p=map.atBeat(raw);assert.equal(p.measure,0);assert.equal(p.pickup,true);assert.equal(p.preparing,false);close(p.beat,beat);
  }
  assert.equal(map.atBeat(0).preparing,true);assert.equal(map.atMeasure(0),0);
  close(map.atMeasure(1),2.05);assert.equal(map.atBeat(2.05).measure,1);close(map.atBeat(2.05).beat,1);
  close(map.atMeasure(2),5.666666666666667);
});
test('all 348 bars and every quarter beat round-trip through the expressive MIDI clock',()=>{
  let previous=-Infinity;
  for(let bar=1;bar<=348;bar++)for(let beat=1;beat<=4;beat++){
    const q=(bar-1)*4+beat-1,raw=map.midiAt(q),p=map.atBeat(raw);
    assert.ok(raw>previous);previous=raw;assert.equal(p.measure,bar);close(p.beat,beat);close(map.quarterAt(raw),q);
  }
  assert.throws(()=>map.atMeasure(349));assert.throws(()=>map.atMeasure(-1));assert.throws(()=>map.atMeasure(1.5));
});
test('piano entrance is printed bar 71, not raw MIDI-grid bar 65',()=>{
  close(map.atMeasure(71),259.3);const p=map.atBeat(midi.tracks[13].intervals.sort((a,b)=>a.beat-b.beat)[0].beat);
  assert.equal(p.measure,71);close(p.beat,1);assert.equal(midi.meter.atBeat(259.3).measure,65);
});
test('bar 214 downbeat precedes the solo quarter rest; tail and last chord stay in their printed bars',()=>{
  const start=map.atMeasure(214),next=map.midiAt(213*4+1),solo=midi.tracks[13].intervals.filter(n=>n.beat>=start && n.beat<next+.15);
  assert.ok(solo.length);assert.ok(solo.every(n=>n.beat>start+.5));
  close(map.atMeasure(337),1486.5083333333334);close(map.atMeasure(348),1530.2583333333334);
  assert.equal(map.atBeat(midi.endBeat).measure,348);assert.equal(map.atBeat(midi.endBeat).complete,true);
});
test('fermata and free cadenza use explicit attack anchors and do not advance phantom bars',()=>{
  close(map.midiAt(590.5),622.4916666666667);close(map.midiAt(591.525),624.4);
  assert.equal(map.atBeat(625).measure,148);assert.equal(map.atBeat(625).freeTime,true);
  close(map.atMeasure(149),630.725);assert.equal(map.atBeat(630.725).freeTime,false);
});
test('legacy saved start migrates to score numbering while preserving volume 100 and the score page',()=>{
  const old=snapshot({version:1,workId:WORK_ID,midi:{name:'prepared.mid',blob:new Blob([bytes])},settings:{measure:1,volume:100,rate:94},page:13});
  const upgraded=scoreStart(old.settings,map,midi.meter);assert.equal(upgraded.measure,0);assert.equal(upgraded.volume,100);assert.equal(upgraded.rate,94);assert.equal(upgraded.positionBasis,SCORE_BASIS);
  const saved=snapshot({...old,settings:upgraded});assert.equal(saved.page,13);assert.equal(saved.settings.measure,0);
  assert.deepEqual(scoreStart(saved.settings,map,midi.meter),saved.settings);
  assert.equal(scoreStart(settings({measure:65}),map,midi.meter).measure,map.atBeat(256).measure);
  assert.equal(scoreStart(saved.settings,null,midi.meter).measure,1);
});
test('mismatched, incomplete, nonfinite and nonmonotone maps are rejected',()=>{
  assert.throws(()=>new ScoreMap(data,'wrong-file'));
  for(const mutate of [d=>d.knots.splice(10,1),d=>d.knots[10][1]=d.knots[9][1],d=>d.knots[10][0]=NaN,d=>d.measureCount=347,d=>d.freeRanges=[[600,590]]]){
    const altered=structuredClone(data);mutate(altered);assert.throws(()=>new ScoreMap(altered,sha));
  }
});
test('score alignment download errors are surfaced before a validated map is cached',async()=>{
  await assert.rejects(loadScoreMap(sha,{fetcher:async()=>new Response('',{status:404})}),/download failed/);
  await assert.rejects(loadScoreMap(sha,{fetcher:async()=>new Response('{}')}),/does not match/);
  const loaded=await loadScoreMap(sha,{fetcher:async url=>{assert.ok(url.pathname.endsWith('/concerto/assets/chopin-op21-alignment.json'));return new Response(JSON.stringify(data));}});
  close(loaded.atMeasure(71),259.3);
});
test('mapped starts retain all original events from the requested printed bar, including rests and tail',()=>{
  const {orchestra}=splitScore(midi,[13]);
  for(const bar of [0,1,71,148,149,214,337,348]){
    let now=0;const sent=[],beat=map.atMeasure(bar),p=new Transport({midi,events:orchestra,clock:()=>now,send:e=>sent.push(e)});
    p.start(beat,.94);for(let i=0;i<100000&&p.playing;i++){now+=.025;p.tick();}
    assert.equal(p.playing,false);assert.deepEqual(sent,orchestra.filter(e=>e.beat>=beat));
    const restored=[];restoreState(orchestra,beat,e=>restored.push(e),0);assert.ok(restored.every(e=>e.beat<beat));
  }
});
