import {Piano,nearestSample} from './piano.js';
import {Fingerprinter,SAMPLE_RATE,MAX_FRAMES} from './matcher.js';

export function wavHeader(samples,rate=SAMPLE_RATE){
  const bytes=new ArrayBuffer(44),v=new DataView(bytes);
  const word=(at,s)=>Array.from(s).forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));
  word(0,'RIFF');v.setUint32(4,36+samples*2,true);word(8,'WAVE');word(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);
  v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);word(36,'data');v.setUint32(40,samples*2,true);
  return bytes;
}

// Render the actual piano samples in bounded chunks, using the same fingerprint
// extractor as microphone and recordings. No whole-concerto float audio buffer.
export async function analyzeMIDI(midi,onProgress=()=>{},signal){
  if(!midi.notes.length||!Number.isFinite(midi.duration)||midi.duration<3)throw new Error('MIDI 至少需要 3 秒音乐。');
  if(midi.duration>45*60)throw new Error('请按乐章导入不超过 45 分钟的 MIDI。');
  const check=()=>{if(signal?.aborted)throw new DOMException('已取消','AbortError');};
  const decoder=new OfflineAudioContext(1,1,SAMPLE_RATE),piano=new Piano({context:decoder});
  await piano.load((done,total)=>onProgress(.08*done/total));check();
  const fp=new Fingerprinter(),frames=[],pcm=[],duration=midi.duration+.5;
  const total=Math.ceil(duration*SAMPLE_RATE),chunkSize=20*SAMPLE_RATE;
  let index=0,active=[];
  for(let offset=0;offset<total;offset+=chunkSize){
    check();const count=Math.min(chunkSize,total-offset),start=offset/SAMPLE_RATE,end=(offset+count)/SAMPLE_RATE;
    const context=new OfflineAudioContext(1,count,SAMPLE_RATE),output=context.createGain();
    output.gain.value=.22;output.connect(context.destination);
    active=active.filter(n=>n.time+n.duration+.4>start);
    while(index<midi.notes.length&&midi.notes[index].time<end)active.push(midi.notes[index++]);
    for(const note of active){
      const sample=nearestSample(note.note),buffer=piano.buffers.get(sample.name),elapsed=Math.max(0,start-note.time);
      if(elapsed*sample.rate>=buffer.duration)continue;
      const source=context.createBufferSource(),gain=context.createGain(),at=Math.max(0,note.time-start);
      source.buffer=buffer;source.playbackRate.value=sample.rate;
      const peak=Math.max(.02,note.velocity)**1.4,release=.35,hold=Math.max(.05,note.duration),tail=hold+release;
      if(elapsed>=tail)continue;
      const level=elapsed>hold?peak*(.0001/peak)**((elapsed-hold)/release):peak;
      gain.gain.setValueAtTime(elapsed?level:0,at);
      if(!elapsed)gain.gain.linearRampToValueAtTime(peak,at+.006);
      if(elapsed<hold)gain.gain.setValueAtTime(peak,at+Math.max(.007,hold-elapsed));
      gain.gain.exponentialRampToValueAtTime(.0001,at+tail-elapsed);
      source.connect(gain).connect(output);source.start(at,elapsed*sample.rate);source.stop(at+tail-elapsed);
    }
    const rendered=await context.startRendering();check();const samples=rendered.getChannelData(0);
    frames.push(...fp.push(samples).filter(f=>f.active));
    if(frames.length>MAX_FRAMES)throw new Error('参考演奏太长，请分段学习。');
    const data=new ArrayBuffer(count*2),view=new DataView(data);
    for(let i=0;i<count;i++)view.setInt16(i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);
    pcm.push(data);onProgress(.08+.92*(offset+count)/total);
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(frames.length<20)throw new Error('MIDI 中没有足够的音乐声音。');
  return {frames,duration,blob:new Blob([wavHeader(total),...pcm],{type:'audio/wav'})};
}
