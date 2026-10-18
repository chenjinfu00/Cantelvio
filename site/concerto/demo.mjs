// Original eight-bar test phrase, not an excerpt of the listed repertoire.
const variable=n=>{const out=[n&127];while(n>>=7)out.unshift((n&127)|128);return out;};
const word=n=>[n>>24&255,n>>16&255,n>>8&255,n&255];
export function demoMidi() {
  const ppq=480,encoder=new TextEncoder();
  const track=(name,channel,program,notes)=>{
    const text=Array.from(encoder.encode(name));const events=[{tick:0,data:[0xff,3,...variable(text.length),...text]},{tick:0,data:[0xc0+channel,program]}];
    for(const [beat,note,duration,velocity] of notes)events.push({tick:Math.round(beat*ppq),data:[0x90+channel,note,velocity]},{tick:Math.round((beat+duration)*ppq),data:[0x80+channel,note,0]});
    events.sort((a,b)=>a.tick-b.tick);const bytes=[];let tick=0;
    for(const e of events){bytes.push(...variable(e.tick-tick),...e.data);tick=e.tick;}
    bytes.push(...variable(32*ppq-tick),0xff,0x2f,0);return [...encoder.encode('MTrk'),...word(bytes.length),...bytes];
  };
  const strings=[],flute=[],solo=[];const chords=[[48,55,60,64],[45,52,57,60],[41,48,53,57],[43,50,55,59]];
  for(let bar=0;bar<8;bar++)for(const note of chords[bar%4])strings.push([bar*4,note,3.7,48]);
  for(let bar=0;bar<8;bar++)flute.push([bar*4+2,72+bar%3*2,1.5,48]);
  for(let beat=8;beat<28;beat++)solo.push([beat,[72,76,79,76,74,77,81,77][(beat-8)%8],.7,80]);
  return new Uint8Array([...encoder.encode('MThd'),...word(6),0,1,0,3,ppq>>8,ppq&255,...track('Strings',0,48,strings),...track('Flute',1,73,flute),...track('Solo piano',2,0,solo)]);
}
