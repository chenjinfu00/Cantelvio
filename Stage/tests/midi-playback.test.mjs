import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {noteNumber,noteName,nearestSample,SAMPLES} from '../docs/piano.js';
import {notesWithin,MIDIPlayer,LOOKAHEAD} from '../docs/midi-player.js';
import {clock} from '../docs/midi-ui.js';
import {indexSources,sourceKind} from '../scripts/index-sources.mjs';

test('every sample name reads as the note it is, and any note finds its nearest one',()=>{
  assert.equal(noteNumber('C4'),60);assert.equal(noteNumber('A0'),21);assert.equal(noteNumber('Ds4'),63);
  assert.equal(noteNumber('C#4'),61);assert.equal(noteNumber('nonsense'),null);
  assert.equal(noteName(60),'C4');assert.equal(noteName(21),'A0');
  for(const name of SAMPLES)assert.ok(noteNumber(name)!==null,name);
  const exact=nearestSample(60);
  assert.equal(exact.name,'C4');assert.equal(exact.rate,1,'a sampled note is never pitched');
  const between=nearestSample(61);
  assert.equal(between.name,'C4');assert.ok(Math.abs(between.rate-2**(1/12))<1e-12);
  for(let note=21;note<=108;note++)assert.ok(nearestSample(note).distance<=2,'no note is pitched more than a whole tone');
});

test('only the notes due in the window are scheduled, and none twice',()=>{
  const notes=[0,.1,.2,1,2].map(time=>({time,note:60,duration:.2,velocity:.5}));
  const first=notesWithin(notes,0,.25);
  assert.equal(first.due.length,3);assert.equal(first.index,3);
  const second=notesWithin(notes,.25,1.5,first.index);
  assert.deepEqual(second.due.map(note=>note.time),[1]);
  assert.deepEqual(notesWithin(notes,5,6,0).due,[],'past the end nothing is due');
  assert.deepEqual(notesWithin([],0,1).due,[]);
});

test('a player schedules ahead, pauses where it stood and resumes from there',()=>{
  const played=[];let now=0,timer=null;
  const piano={context:{get currentTime(){return now;}},play:(note,options)=>played.push({note,at:options.at}),silence(){}};
  const player=new MIDIPlayer({piano,setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{timer=null;}});
  player.load({duration:3,notes:[{time:0,note:60,duration:.5,velocity:.5},{time:1,note:64,duration:.5,velocity:.5},{time:2.5,note:67,duration:.5,velocity:.5}]});
  player.play();
  assert.deepEqual(played.map(p=>p.note),[60],'only what is due within the lookahead');
  assert.ok(LOOKAHEAD>0&&LOOKAHEAD<1);
  now=1;timer();
  assert.deepEqual(played.map(p=>p.note),[60,64]);
  player.pause();
  assert.equal(player.playing,false);assert.equal(Math.round(player.position),1);
  assert.equal(timer,null,'a paused player stops asking for more notes');
  now=5;player.play();now=5.4;timer();
  assert.deepEqual(played.map(p=>p.note),[60,64],'resuming does not replay what already sounded');
  player.seek(2.4);now=6;player.play();timer();
  assert.deepEqual(played.map(p=>p.note),[60,64,67],'seeking picks the notes up from there');
});

test('a work offers its own sources, and the times read as times',()=>{
  const items=[{id:'a',title:'甲'},{id:'b',title:'乙'},{id:'c',title:'丙'}];
  const files={a:'曲谱/x/作品一/版本一 · a.pdf',b:'曲谱/x/作品一/版本二 · b.pdf',c:'曲谱/x/作品二/丙 · c.pdf'};
  const folders=new Map([['曲谱/x/作品一',['版本一 · a.pdf','版本二 · b.pdf','曲.mid','曲.sib','封面.jpg']],['曲谱/x/作品二',['丙 · c.pdf']]]);
  const changed=indexSources(items,files,folders);
  assert.deepEqual(changed.find(change=>change.id==='a').sources,[{name:'曲.mid',kind:'midi'},{name:'曲.sib',kind:'engraving'}]);
  assert.deepEqual(changed.find(change=>change.id==='b').sources.map(s=>s.name),['曲.mid','曲.sib'],'both versions of a work answer the same');
  assert.equal(changed.some(change=>change.id==='c'),false,'a work with no sources is left alone');
  assert.equal(sourceKind('a.MIDI'),'midi');assert.equal(sourceKind('a.sib'),'engraving');
  assert.equal(clock(0),'0:00');assert.equal(clock(61.6),'1:02');assert.equal(clock(-5),'0:00');
});

test('the reader can reach a source, offline and online alike',async()=>{
  const manifest=JSON.parse(await fs.readFile(new URL('../docs/cache-manifest.json',import.meta.url),'utf8'));
  for(const path of ['./midi-file.js','./piano.js','./midi-player.js','./midi-ui.js','./vendor/piano/C4.mp3'])
    assert.ok(manifest.includes(path),path+' is saved for offline use');
  const local=await fs.readFile(new URL('../docs/local-library.js',import.meta.url),'utf8');
  assert.match(local,/sourceURL:\(id,name\)/,'a MIDI file is read from the folder that holds its score');
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  assert.match(app,/local\.sourceURL/);
  assert.match(app,/if\(local\)return local\.sourceURL\(state\.score\.id,name\)/,'local mode never falls back to a server MIDI URL');
});
