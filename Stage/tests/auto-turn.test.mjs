import test from 'node:test';
import assert from 'node:assert/strict';
import {TurnCue} from '../docs/turn-cue.js';
import {TurnController} from '../docs/matcher.js';
import {pageTurnMap,validatePageTurnMap} from '../docs/page-turn-map.js';
import {wavHeader} from '../docs/midi-reference.js';
const frames=Array.from({length:401},(_,i)=>({time:i/10}));
const anchors=[{page:17,time:0},{page:18,time:10},{page:19,time:20}];
const match=index=>({index,active:true,stable:true});
test('three-second cue counts down with music, pauses in silence and resets on a manual correction',()=>{
 const cue=new TurnCue(anchors,frames,{lead:0});
 assert.equal(cue.observe(match(60),6,0),null);
 assert.equal(cue.observe(match(70),7,0).remaining,3);
 assert.equal(cue.observe(match(80),8,0).remaining,2);
 const paused=cue.observe({index:80,active:false,stable:false},12,0);
 assert.equal(paused.remaining,2);assert.equal(paused.paused,true);
 assert.equal(cue.observe(match(81),12.1,0).paused,false);
 cue.reset();assert.equal(cue.observe(match(20),13,0),null);
 assert.equal(cue.observe(match(210),21,2),null);
});
test('cue estimates performance seconds from faster and slower playing',()=>{
 for(const rate of [.5,2]){
  const cue=new TurnCue(anchors,frames,{lead:0});let value;
  for(let t=0;t<=8/rate;t+=.1)value=cue.observe(match(Math.round(t*rate*10)),t,0);
  if(rate===.5)assert.equal(value,null,'two reference seconds take four live seconds');
  else assert.ok(value.remaining>.9&&value.remaining<1.2);
 }
});
test('a held musical position cannot drain a cue or turn pages',()=>{
 const cue=new TurnCue(anchors,frames,{lead:0}),turner=new TurnController(anchors,frames,{lead:0});
 cue.observe(match(80),8,0);
 for(let i=0;i<50;i++){const value=cue.observe(match(80),8+i/10,0);assert.equal(value.remaining,2);assert.equal(turner.observe(match(100)),null);}
 assert.equal(cue.cue.paused,true);
});
test('page turns require progressing stable matches, never silence or uncertain sound',()=>{
 const turner=new TurnController(anchors,frames,{lead:0});
 for(let i=98;i<103;i++)assert.equal(turner.observe({...match(i),stable:false}),null);
 assert.equal(turner.observe(match(100)),null);assert.equal(turner.observe({...match(101),active:false}),null);
 assert.equal(turner.observe(match(101)),null);assert.equal(turner.observe(match(102)),null);
 assert.deepEqual(turner.observe(match(103)),anchors[1]);
 assert.equal(turner.observe(match(104)),null);
});
test('portable page points are bound to both the exact PDF and reference file',()=>{
 const ref={sourceId:'midi-sha',sourceName:'test.mid',anchors,rests:[]};
 const map=pageTurnMap('pdf-sha',ref),options={scoreId:'pdf-sha',sourceId:'midi-sha',pageCount:110,duration:40};
 assert.deepEqual(validatePageTurnMap(map,options).anchors,anchors);assert.equal('frames' in map,false);
 assert.throws(()=>validatePageTurnMap(map,{...options,scoreId:'different-edition'}),/PDF/);
 assert.throws(()=>validatePageTurnMap(map,{...options,sourceId:'different-performance'}),/参考文件/);
 assert.throws(()=>validatePageTurnMap({...map,anchors:[anchors[0],{page:18,time:-1}]},options),/无效/);
 assert.throws(()=>validatePageTurnMap({...map,anchors:[anchors[0],{page:111,time:12}]},options),/无效/);
});
test('generated MIDI audition is a valid mono PCM WAV header',()=>{
 const v=new DataView(wavHeader(22050));assert.equal(v.getUint32(40,true),44100);assert.equal(v.getUint32(24,true),22050);assert.equal(v.getUint16(22,true),1);
});
