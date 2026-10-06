import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parseMIDI,readVarInt,toSeconds} from '../docs/midi-file.js';

const bytes=(...values)=>values.flat();
const varInt=value=>{const out=[value&0x7f];value>>=7;while(value){out.unshift((value&0x7f)|0x80);value>>=7;}return out;};
const chunk=(type,body)=>bytes([...type].map(c=>c.charCodeAt(0)),[body.length>>24&255,body.length>>16&255,body.length>>8&255,body.length&255],body);
const file=(division,tracks)=>new Uint8Array(bytes(chunk('MThd',[0,1,0,tracks.length,division>>8,division&255]),...tracks.map(events=>chunk('MTrk',events)))).buffer;

test('a note becomes a start time and a length in seconds',()=>{
  // 480 ticks per quarter, 120 bpm by default: one quarter note is half a second.
  const midi=parseMIDI(file(480,[bytes(varInt(0),[0x90,60,100],varInt(480),[0x80,60,0],varInt(0),[0xff,0x2f,0])]));
  assert.equal(midi.notes.length,1);
  const [note]=midi.notes;
  assert.equal(note.note,60);assert.equal(note.time,0);
  assert.ok(Math.abs(note.duration-0.5)<1e-9);
  assert.ok(Math.abs(note.velocity-100/127)<1e-9);
  assert.ok(Math.abs(midi.duration-0.5)<1e-9);
});

test('a tempo change moves every later note',()=>{
  const track=bytes(varInt(0),[0xff,0x51,3,0x07,0xa1,0x20],   // 500000 µs = 120 bpm
    varInt(480),[0xff,0x51,3,0x03,0xd0,0x90],                  // 250000 µs = 240 bpm
    varInt(0),[0x90,72,80],varInt(480),[0x80,72,0],varInt(0),[0xff,0x2f,0]);
  const midi=parseMIDI(file(480,[track]));
  assert.equal(midi.tempos.map(tempo=>Math.round(tempo.bpm)).join(','),'120,240');
  const [note]=midi.notes;
  assert.ok(Math.abs(note.time-0.5)<1e-9,'the first quarter still took half a second');
  assert.ok(Math.abs(note.duration-0.25)<1e-9,'the note itself is played twice as fast');
});

test('running status, a zero-velocity note on, and several tracks all read correctly',()=>{
  const melody=bytes(varInt(0),[0x90,60,100],varInt(240),[64,100],varInt(240),[60,0],varInt(0),[64,0],varInt(0),[0xff,0x2f,0]);
  const pedal=bytes(varInt(0),[0xb0,64,127],varInt(480),[0xb0,64,0],varInt(0),[0xff,0x2f,0]);
  const midi=parseMIDI(file(480,[melody,pedal]));
  assert.equal(midi.tracks,2);
  assert.deepEqual(midi.notes.map(note=>note.note),[60,64],'a note on with velocity 0 ends the note');
  assert.deepEqual(midi.pedals.map(p=>p.down),[true,false]);
  assert.ok(Math.abs(midi.notes[1].time-0.25)<1e-9,'running status kept the second note on the beat');
});

test('a broken file says so instead of playing nonsense',()=>{
  assert.throws(()=>parseMIDI(new Uint8Array([1,2,3]).buffer),/不是一个 MIDI 文件/);
  assert.throws(()=>parseMIDI(file(-25,[bytes(varInt(0),[0xff,0x2f,0])])),/帧计时/);
  const view=new DataView(new Uint8Array([0x80,0x80,0x80,0x80,0x80]).buffer);
  assert.throws(()=>readVarInt(view,0),/过长/);
  assert.equal(toSeconds(480,[],480),0.5,'no tempo event means 120 bpm');
});

test('the real MIDI files in the collection parse',async()=>{
  const library=new URL('../../本地曲谱/曲谱/',import.meta.url);
  let found=[];
  const walk=async folder=>{
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){
      const next=new URL(entry.name+(entry.isDirectory()?'/':''),folder);
      if(entry.isDirectory())await walk(next);else if(entry.name.endsWith('.mid'))found.push(next);
    }
  };
  try{await walk(library);}catch{return;}   // the collection is not part of the repository
  assert.ok(found.length>50,'the collection has MIDI beside its scores');
  for(const url of found.slice(0,25)){
    const midi=parseMIDI((await fs.readFile(url)).buffer);
    assert.ok(midi.notes.length>0,url.pathname);
    assert.ok(midi.duration>1&&midi.duration<3600,url.pathname);
  }
});
