// A Standard MIDI File, read just far enough to play it back and follow along:
// notes with absolute times in seconds, and the tempo map that produced them.
const text=(view,at,length)=>String.fromCharCode(...new Uint8Array(view.buffer,view.byteOffset+at,length));

export function readVarInt(view,at){
  let value=0,read=0;
  for(;;){
    if(at+read>=view.byteLength)throw new Error('MIDI 文件在读取时意外结束');
    const byte=view.getUint8(at+read++);
    value=(value<<7)|(byte&0x7f);
    if(!(byte&0x80))return {value,read};
    if(read>4)throw new Error('MIDI 变长数字过长');
  }
}
function chunks(view){
  const out=[];let at=0;
  while(at+8<=view.byteLength){
    const type=text(view,at,4),length=view.getUint32(at+4);
    out.push({type,at:at+8,length:Math.min(length,view.byteLength-at-8)});
    at+=8+length;
  }
  return out;
}
// Events of one track, in ticks, with running status resolved.
export function readTrack(view,start,length){
  const events=[];let at=start,tick=0,status=0;
  const end=start+length;
  while(at<end){
    const delta=readVarInt(view,at);at+=delta.read;tick+=delta.value;
    let byte=view.getUint8(at);
    if(byte&0x80){status=byte;at++;}else if(!status)throw new Error('MIDI 事件缺少状态字节');
    const command=status&0xf0,channel=status&0x0f;
    if(status===0xff){
      const type=view.getUint8(at++),size=readVarInt(view,at);at+=size.read;
      if(type===0x51&&size.value===3)events.push({tick,type:'tempo',microseconds:(view.getUint8(at)<<16)|(view.getUint8(at+1)<<8)|view.getUint8(at+2)});
      else if(type===0x2f)events.push({tick,type:'end'});
      at+=size.value;
    }else if(status===0xf0||status===0xf7){
      const size=readVarInt(view,at);at+=size.read+size.value;
    }else if(command===0x90||command===0x80){
      const note=view.getUint8(at++),velocity=view.getUint8(at++);
      events.push({tick,type:command===0x90&&velocity?'on':'off',note,velocity,channel});
    }else if(command===0xb0){
      const controller=view.getUint8(at++),value=view.getUint8(at++);
      if(controller===64)events.push({tick,type:'pedal',value,channel});
    }else at+=command===0xc0||command===0xd0?1:2;
  }
  return events;
}
// Ticks become seconds only through the tempo map, which any track may change.
export function toSeconds(tick,tempos,division){
  let seconds=0,last=0,microseconds=500000;
  for(const tempo of tempos){
    if(tempo.tick>=tick)break;
    seconds+=(tempo.tick-last)*microseconds/1e6/division;
    last=tempo.tick;microseconds=tempo.microseconds;
  }
  return seconds+(tick-last)*microseconds/1e6/division;
}
export function parseMIDI(buffer){
  const view=new DataView(buffer instanceof ArrayBuffer?buffer:buffer.buffer);
  const parts=chunks(view);
  const header=parts.find(part=>part.type==='MThd');
  if(!header)throw new Error('这不是一个 MIDI 文件');
  const division=view.getInt16(header.at+4);
  if(division<=0)throw new Error('暂不支持以帧计时的 MIDI 文件');
  const tracks=parts.filter(part=>part.type==='MTrk').map(part=>readTrack(view,part.at,part.length));
  const tempos=tracks.flat().filter(event=>event.type==='tempo').sort((a,b)=>a.tick-b.tick);
  const notes=[],pedals=[];
  for(const events of tracks){
    const open=new Map();
    for(const event of events){
      const key=event.channel*128+event.note;
      if(event.type==='on')open.set(key,[...(open.get(key)||[]),event]);
      else if(event.type==='off'){
        const started=open.get(key)?.shift();if(!started)continue;
        const time=toSeconds(started.tick,tempos,division);
        notes.push({note:started.note,channel:started.channel,velocity:started.velocity/127,time,duration:Math.max(.02,toSeconds(event.tick,tempos,division)-time)});
      }else if(event.type==='pedal')pedals.push({time:toSeconds(event.tick,tempos,division),down:event.value>=64});
    }
  }
  notes.sort((a,b)=>a.time-b.time||a.note-b.note);
  pedals.sort((a,b)=>a.time-b.time);
  const duration=notes.reduce((end,note)=>Math.max(end,note.time+note.duration),0);
  return {division,tracks:tracks.length,notes,pedals,duration,
    tempos:tempos.map(tempo=>({time:toSeconds(tempo.tick,tempos,division),bpm:6e7/tempo.microseconds}))};
}
