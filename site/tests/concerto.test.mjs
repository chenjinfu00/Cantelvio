import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {parseMidi,TempoMap,MeterMap,splitScore} from '../concerto/midi.mjs';
import {Transport,restoreState} from '../concerto/transport.mjs';
import {BrowserFollower,pitchVector} from '../concerto/follower.mjs';
import {demoMidi} from '../concerto/demo.mjs';

test('original example includes opening rest, separate solo and a complete 8-bar orchestra',()=>{
  const midi=parseMidi(demoMidi()),split=splitScore(midi,[2]);
  assert.equal(midi.endBeat,32);assert.equal(midi.tracks.length,3);assert.equal(split.solo[0].beat,8);
  assert.equal(split.orchestra.filter(e=>e.command===9&&e.b).length,40);assert.ok(!split.orchestra.some(e=>e.track===2));
});
for(const [label,buffer] of [['empty',new Uint8Array()],['truncated',demoMidi().slice(0,30)],['too large',new Uint8Array(20*1024*1024+1)]])test(`rejects ${label} MIDI`,()=>assert.throws(()=>parseMidi(buffer)));
test('rejects unsupported SMPTE and format 2',()=>{for(const [index,value] of [[12,0x80],[9,2]]){const b=demoMidi();b[index]=value;assert.throws(()=>parseMidi(b));}});
test('tempo conversion integrates changes rather than multiplying by the last tempo',()=>{
  const clock=new TempoMap([{beat:0,us:500000},{beat:4,us:1000000},{beat:8,us:250000}]);
  assert.equal(clock.seconds(8),6);assert.equal(clock.seconds(12),7);assert.equal(clock.bpm(4),60);
  for(const beat of [0,1,3.5,4,7,8,9,100])assert.ok(Math.abs(clock.beat(clock.seconds(beat))-beat)<1e-10);
});
test('bar mapping honours time signatures',()=>{const meter=new MeterMap([{beat:0,numerator:4,denominator:4},{beat:8,numerator:3,denominator:4}]);assert.equal(meter.atMeasure(4),11);assert.deepEqual(meter.atBeat(12),{measure:4,beat:2});});
test('virtual full scheduler sends every event exactly once through rests and tail',()=>{
  const midi=parseMidi(demoMidi()),{orchestra}=splitScore(midi,[2]),sent=[];let now=0,ended=false;
  const player=new Transport({midi,events:orchestra,clock:()=>now,send:e=>sent.push(e),onEnd:()=>ended=true});
  player.start(0,.935);for(let i=0;i<5000&&player.playing;i++){now+=.025;player.tick();}
  assert.ok(ended);assert.deepEqual(sent,orchestra);
});
test('entry gating emits no note at or after the entry before release',()=>{
  const midi=parseMidi(demoMidi()),{orchestra}=splitScore(midi,[2]),sent=[];let now=0;
  const player=new Transport({midi,events:orchestra,clock:()=>now,send:e=>sent.push(e)});player.start();
  for(let i=0;i<400;i++){now+=.025;player.tick(1,8);}assert.equal(player.beat,8);assert.ok(sent.every(e=>e.beat<8));
  for(let i=0;i<50;i++){now+=.025;player.tick(1,8);}const held=sent.length;
  for(let i=0;i<10;i++){now+=.025;player.tick(1,8);}assert.equal(sent.length,held);
  for(let i=0;i<1000&&player.playing;i++){now+=.025;player.tick(1);}assert.deepEqual(sent,orchestra);
});
test('suspended foreground timer stops without a catch-up avalanche',()=>{
  const midi=parseMidi(demoMidi());let now=0,errors=0,sent=0;
  const p=new Transport({midi,events:midi.events,clock:()=>now,send:()=>sent++,onError:()=>errors++});p.start();now=5;p.tick();assert.equal(errors,1);assert.equal(sent,0);assert.equal(p.playing,false);
});
test('seeking restores instrument/controller state and held notes, not old released notes',()=>{
  const events=[{beat:0,track:1,channel:0,command:12,a:48},{beat:0,track:1,channel:0,command:11,a:7,b:90},{beat:0,track:1,channel:0,command:9,a:60,b:80},{beat:1,track:1,channel:0,command:8,a:60,b:0},{beat:2,track:1,channel:0,command:9,a:64,b:80}];
  const sent=[];restoreState(events,3,e=>sent.push(e),0);assert.equal(sent.length,3);assert.deepEqual(sent.map(e=>e.a),[48,7,64]);
});
test('browser follower waits for active solo but allows prelude, written rests and final tail',()=>{
  const midi=parseMidi(demoMidi()),score=splitScore(midi,[2]),f=new BrowserFollower({...score,orchestra:[],clock:midi.clock,speaker:false});
  assert.equal(f.control(0,0).label,'rest');assert.equal(f.control(8,1).scale,0);
  for(let i=0;i<10;i++)f.observe({active:false,db:-80,v:Array(24).fill(0)},8,i/10);assert.equal(f.locked,false);
  const v=pitchVector(score.solo.filter(n=>n.beat===8));for(let i=0;i<5;i++)f.observe({active:true,db:-20,v:[...v,...Array(12).fill(0)]},8,2+i/10);
  assert.equal(f.locked,true);assert.equal(f.control(8,2.5).label,'following');assert.equal(f.control(8,5).label,'lost');
  f.release();assert.equal(f.control(8,5).label,'manual');assert.equal(f.control(31,6).label,'rest');
});
test('speaker mode refuses a reference indistinguishable from orchestra bleed',()=>{
  const midi=parseMidi(demoMidi()),score=splitScore(midi,[2]),f=new BrowserFollower({...score,orchestra:score.solo,clock:midi.clock,speaker:true});f.control(8,1);
  const v=pitchVector(score.solo.filter(n=>n.beat===8));for(let i=0;i<20;i++)f.observe({active:true,db:-15,v:[...v,...Array(12).fill(0)]},8,2+i/10);assert.equal(f.locked,false);
});
const source=new URL('../concerto/assets/chopin-op21-mvt1.mid',import.meta.url);
test('published complete Chopin source: all 7,871 orchestra note-ons and 16,825 channel events survive', ()=>{
  const midi=parseMidi(fs.readFileSync(source)),solo=midi.tracks.filter(t=>t.name==='Pianoforte').map(t=>t.id),score=splitScore(midi,solo);
  assert.equal(score.orchestra.length,16825);assert.equal(score.orchestra.filter(e=>e.command===9&&e.b).length,7871);assert.equal(score.solo.length,5811);assert.equal(score.solo[0].beat,259.3);
  let now=0;const sent=[];const p=new Transport({midi,events:score.orchestra,clock:()=>now,send:e=>sent.push(e)});p.start();
  for(let i=0;i<100000&&p.playing;i++){now+=.025;p.tick();}assert.equal(p.playing,false);assert.deepEqual(sent,score.orchestra);
});
