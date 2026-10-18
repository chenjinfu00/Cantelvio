// A bounded SMF reader. Keep channels, controllers, tempo and written rests.
export function parseMidi(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length > 20 * 1024 * 1024) throw Error('MIDI 文件需小于 20 MB / MIDI must be under 20 MB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0, limit = bytes.length;
  const need = n => { if (at + n > limit) throw Error('MIDI 文件不完整 / Truncated MIDI'); };
  const u8 = () => { need(1); return bytes[at++]; };
  const u16 = () => { need(2); const v = view.getUint16(at); at += 2; return v; };
  const u32 = () => { need(4); const v = view.getUint32(at); at += 4; return v; };
  const text = n => { need(n); const v = new TextDecoder().decode(bytes.subarray(at, at + n)); at += n; return v; };
  const variable = () => {
    let n = 0;
    for (let i = 0; i < 4; i++) { const b = u8(); n = n * 128 + (b & 127); if (!(b & 128)) return n; }
    throw Error('MIDI 变长数字无效 / Invalid MIDI integer');
  };
  if (text(4) !== 'MThd') throw Error('请选择标准 MIDI 文件 / Choose a Standard MIDI file');
  const header = u32(); if (header < 6) throw Error('MIDI header');
  need(header); const format = u16(), count = u16(), ppq = u16(); at += header - 6;
  if (format > 1 || !count || count > 256 || !ppq || ppq & 0x8000) throw Error('仅支持按拍计时的 MIDI 0/1 / MIDI format 0/1 with PPQ required');
  const tracks = [], events = [], tempos = [{beat:0, us:500000}], signatures = [{beat:0, numerator:4, denominator:4}];
  let endBeat = 0;
  for (let t = 0; t < count; t++) {
    limit = bytes.length;
    if (text(4) !== 'MTrk') throw Error('MIDI 轨道缺失 / Missing MIDI track');
    const length = u32(); need(length); const end = at + length; limit = end;
    let tick = 0, running = 0, name = '', notes = 0;
    const trackEvents = [], open = new Map(), intervals = [];
    while (at < end) {
      tick += variable(); const beat = tick / ppq; let status = u8();
      if (status < 0x80) { at--; if (!running) throw Error('MIDI running status'); status = running; }
      if (status === 0xff) {
        running = 0; const type = u8(), n = variable(); need(n); const start = at;
        if (type === 3) name = text(n);
        else if (type === 0x51 && n === 3) { const us = u8() * 65536 + u8() * 256 + u8(); if (!us) throw Error('MIDI tempo'); tempos.push({beat,us}); }
        else if (type === 0x58 && n >= 2) { const numerator = u8(), power = u8(); if (!numerator || power > 6) throw Error('MIDI meter'); signatures.push({beat,numerator,denominator:2 ** power}); }
        at = start + n; if (type === 0x2f) { endBeat = Math.max(endBeat, beat); break; }
      } else if (status === 0xf0 || status === 0xf7) { running = 0; const n = variable(); need(n); at += n; }
      else {
        if (status >= 0xf0) throw Error('Unsupported MIDI system event');
        running = status; const command = status >> 4, channel = status & 15;
        const a = u8(), b = command === 12 || command === 13 ? undefined : u8();
        if (a > 127 || b > 127) throw Error('MIDI data byte');
        const event = {beat, track:t, channel, command, a, b, order:events.length};
        events.push(event); trackEvents.push(event);
        if (events.length > 500000) throw Error('MIDI 事件过多 / Too many MIDI events');
        const key = channel * 128 + a;
        if (command === 9 && b) { notes++; const q = open.get(key) || []; q.push({beat,note:a,velocity:b,channel}); open.set(key,q); }
        if (command === 8 || command === 9 && !b) { const start = open.get(key)?.shift(); if (start) intervals.push({...start,end:beat}); }
        endBeat = Math.max(endBeat, beat);
      }
    }
    for (const queue of open.values()) for (const start of queue) intervals.push({...start,end:Math.max(start.beat + .125,tick / ppq)});
    at = end; tracks.push({id:t,name:name || `Track ${t + 1}`,notes,events:trackEvents,intervals});
  }
  events.sort((a,b) => a.beat - b.beat || a.order - b.order);
  if (!events.some(e => e.command === 9 && e.b)) throw Error('MIDI 中没有音符 / No MIDI notes');
  const unique = list => [...new Map(list.sort((a,b) => a.beat-b.beat).map(x => [x.beat,x])).values()];
  const midi = {ppq,format,tracks,events,endBeat,tempos:unique(tempos),signatures:unique(signatures)};
  midi.clock = new TempoMap(midi.tempos); midi.meter = new MeterMap(midi.signatures);
  if (midi.clock.seconds(endBeat) > 3 * 3600) throw Error('请按乐章载入 MIDI / Load one movement at a time');
  return midi;
}

export class TempoMap {
  constructor(tempos) {
    this.points = []; let seconds = 0, lastBeat = 0, us = 500000;
    for (const p of tempos) { seconds += (p.beat-lastBeat)*us/1e6; this.points.push({...p,seconds}); lastBeat=p.beat; us=p.us; }
  }
  point(value, key) { let lo=0,hi=this.points.length; while(lo<hi){const m=(lo+hi)>>1; if(this.points[m][key]<=value)lo=m+1;else hi=m;}return this.points[Math.max(0,lo-1)]; }
  seconds(beat) { const p=this.point(beat,'beat'); return p.seconds+(beat-p.beat)*p.us/1e6; }
  beat(seconds) { const p=this.point(seconds,'seconds'); return p.beat+(seconds-p.seconds)*1e6/p.us; }
  bpm(beat) { return 6e7/this.point(beat,'beat').us; }
}
export class MeterMap {
  constructor(signatures) {
    this.points=[]; let measure=1,lastBeat=0,length=4;
    for(const p of signatures) {measure+=(p.beat-lastBeat)/length; length=p.numerator*4/p.denominator; this.points.push({...p,measure,length});lastBeat=p.beat;}
  }
  atBeat(beat) {const p=this.points.findLast(p=>p.beat<=beat) || this.points[0]; return {measure:Math.floor(p.measure+(beat-p.beat)/p.length+1e-8),beat:1+(beat-p.beat)%p.length};}
  atMeasure(measure) {const p=this.points.findLast(p=>p.measure<=measure) || this.points[0];return p.beat+(measure-p.measure)*p.length;}
}
export function splitScore(midi, soloIds) {
  const ids=new Set(soloIds);
  const orchestra=midi.events.filter(e=>!ids.has(e.track));
  const solo=midi.tracks.filter(t=>ids.has(t.id)).flatMap(t=>t.intervals).sort((a,b)=>a.beat-b.beat);
  const merged=[];
  for(const n of solo) {const last=merged.at(-1); if(last && n.beat<=last.end+.5)last.end=Math.max(last.end,n.end);else merged.push({beat:n.beat,end:n.end});}
  return {orchestra,solo,phrases:merged};
}
export function lowerBound(events,beat) {let lo=0,hi=events.length;while(lo<hi){const m=(lo+hi)>>1;if(events[m].beat<beat)lo=m+1;else hi=m;}return lo;}
