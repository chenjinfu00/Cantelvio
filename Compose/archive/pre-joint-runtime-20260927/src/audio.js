const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
// Measured four-scene fixtures had >13 dB peak headroom: +5 dB before the safety chain.
const MASTER_CALIBRATION=.72*10**(5/20);
// Sustained pad/bass waveforms carry more RMS than decaying samples; trim them 3 dB.
const SUSTAINED_TRIM=10**(-3/20);
const BANKS={piano:Array.from({length:17},(_,i)=>{const midi=36+i*3;return {midi,file:`${['C','Ds','Fs','A'][(midi%12)/3]}${Math.floor(midi/12)-1}.mp3`};}),bass:[[28,'E1'],[31,'G1'],[34,'As1'],[37,'Cs2'],[40,'E2'],[43,'G2'],[46,'As2'],[49,'Cs3'],[52,'E3']].map(([midi,name])=>({midi,file:name+'.mp3'})),guitar:[[54,'Fs3'],[57,'A3'],[60,'C4'],[63,'Ds4'],[66,'Fs4'],[69,'A4'],[72,'C5'],[75,'Ds5'],[78,'Fs5']].map(([midi,name])=>({midi,file:name+'.mp3'}))};
export const groupGain=(mix,mutes,role)=>clamp(Number(mix[role])||0,0,1)*(mutes[role]?0:1);
function ramp(param,value,time,duration=.025){param.cancelScheduledValues(time);param.setTargetAtTime(value,time,duration/3);}
export class AudioEngine {
 constructor({context=null,onState=()=>{}}={}){this.context=context;this.onState=onState;this.banks={piano:[],bass:[],guitar:[]};this.voices=new Set();this.mix={harmony:.75,bass:.64,melody:.66};this.mutes={harmony:false,bass:false,melody:false};this.master=.8;this.readyPromise=null;this.loaded=0;this.failed=0;if(context)this.build();}
 build(){const c=this.context;this.masterNode=c.createGain();this.masterNode.gain.value=this.master*MASTER_CALIBRATION;this.limiter=c.createDynamicsCompressor();this.limiter.threshold.value=-10;this.limiter.knee.value=8;this.limiter.ratio.value=16;this.limiter.attack.value=.003;this.limiter.release.value=.16;this.guard=c.createWaveShaper();const curve=new Float32Array(4097);for(let i=0;i<curve.length;i++){const x=i*2/(curve.length-1)-1;curve[i]=.92*Math.tanh(x/.92);}this.guard.curve=curve;this.guard.oversample='2x';this.masterNode.connect(this.limiter);this.limiter.connect(this.guard);this.guard.connect(c.destination);this.buses={};for(const role of ['harmony','bass','melody']){const gain=c.createGain();gain.gain.value=groupGain(this.mix,this.mutes,role);gain.connect(this.masterNode);this.buses[role]=gain;}if('onstatechange'in c)c.onstatechange=()=>this.onState(c.state);}
 async ensureReady(){// Context creation and resume occur before the first await, inside the Play gesture.
  if(!this.context){this.context=new (globalThis.AudioContext||globalThis.webkitAudioContext)({latencyHint:'interactive'});this.build();}
  const resumed=this.context.resume?this.context.resume():Promise.resolve();
  if(!this.readyPromise)this.readyPromise=this.loadSamples();
  await resumed;await this.readyPromise;
  if(this.context.state!=='running'&&this.context.resume)throw Error('Audio is suspended. Press Play to resume.');
 }
 async loadSamples(){this.failed=0;await Promise.all(Object.entries(BANKS).flatMap(([bank,entries])=>entries.map(async sample=>{if(this.banks[bank].some(s=>s.midi===sample.midi))return;try{const r=await fetch(new URL(`../media/${bank}/${sample.file}`,import.meta.url),{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('Sample unavailable');const buffer=await this.context.decodeAudioData(await r.arrayBuffer());this.banks[bank].push({...sample,buffer});this.loaded++;}catch{this.failed++;}})));this.onState('samples');}
 status(){return {loaded:this.loaded,total:35,failed:this.failed,state:this.context?.state||'locked',activeVoices:this.voices.size};}
 setMix(mix,mutes=this.mutes,at=this.context?.currentTime){this.mix={...mix};this.mutes={...mutes};if(this.buses)for(const role of Object.keys(this.buses))ramp(this.buses[role].gain,groupGain(mix,mutes,role),at);}
 setRoleMix(role,value,muted){this.mix[role]=clamp(value,0,1);this.mutes[role]=!!muted;if(this.buses)ramp(this.buses[role].gain,groupGain(this.mix,this.mutes,role),this.context.currentTime);}
 setMaster(value){this.master=clamp(value,0,1);if(this.masterNode)ramp(this.masterNode.gain,this.master*MASTER_CALIBRATION,this.context.currentTime);}
 play(event,start){const c=this.context;if(!c||!this.buses[event.role]||!Number.isFinite(event.midi))return;const at=Math.max(c.currentTime,start+event.time),duration=clamp(event.duration,.03,12),id=event.instrument,velocity=clamp(event.velocity,.01,1),sources=[];
  const envelope=c.createGain(),filter=c.createBiquadFilter(),pan=c.createStereoPanner();filter.type='lowpass';filter.frequency.value=id==='electric-guitar'?3500:id==='pad'?2200:event.role==='bass'?1500:8500;filter.Q.value=.45;pan.pan.value=event.role==='bass'?0:event.role==='melody'?.1:clamp((event.midi-66)*.012,-.22,.22);envelope.connect(filter);filter.connect(pan);pan.connect(this.buses[event.role]);
  const bank=id==='piano'?'piano':id==='electric-bass'?'bass':id==='electric-guitar'?'guitar':null;
  const samples=bank&&this.banks[bank],sample=samples?.length?samples.reduce((a,b)=>Math.abs(a.midi-event.midi)<=Math.abs(b.midi-event.midi)?a:b):null;
  const attack=id==='pad'||id==='strings'?.13:.008,release=id==='pad'||id==='strings'?.75:id==='bell'?.5:event.role==='bass'?.09:.22;
  const level=velocity*(sample?(bank==='bass'?.48:bank==='guitar'?.6:event.role==='bass'?.39:.78):id==='pad'?.22*SUSTAINED_TRIM:id==='epiano'?.3:id==='synth-bass'?.34*SUSTAINED_TRIM:event.role==='bass'?.34:.23);
  envelope.gain.setValueAtTime(0,at);envelope.gain.linearRampToValueAtTime(level,at+attack);envelope.gain.setTargetAtTime(level*(id==='bell'?.15:sample?.72:.8),at+attack,Math.max(.06,duration*.45));envelope.gain.setTargetAtTime(.00001,at+Math.max(attack,duration),release/4);const end=at+Math.max(attack,duration)+release+.05;
  const hz=440*2**((event.midi-69)/12);
  if(sample){const node=c.createBufferSource();node.buffer=sample.buffer;node.playbackRate.value=2**((event.midi-sample.midi)/12);node.connect(envelope);sources.push(node);}
  else {const partials=id==='epiano'?[[1,1],[2,.32],[3,.09]]:id==='bell'?[[1,1],[2.76,.32],[4.1,.12]]:id==='reed-lead'?[[1,1],[3,.3],[5,.1]]:id==='organ'?[[1,1],[2,.4],[4,.2]]:id==='pad'||id==='strings'?[[.998,1],[1.002,1],[2,.2]]:[[1,1],[2,.2]];const total=partials.reduce((n,p)=>n+p[1],0);for(const [ratio,weight]of partials){const node=c.createOscillator(),gain=c.createGain();node.type=id==='synth-lead'?'triangle':'sine';node.frequency.value=hz*ratio;gain.gain.value=weight/total;node.connect(gain);gain.connect(envelope);sources.push(node);}}
  const voice={role:event.role,envelope,sources,end,at};this.voices.add(voice);let active=sources.length;for(const source of sources){source.onended=()=>{if(--active===0){this.voices.delete(voice);envelope.disconnect();filter.disconnect();pan.disconnect();}};source.start(at);source.stop(end);}return voice;
 }
 stopGroup(role){if(!this.context)return;const now=this.context.currentTime;for(const voice of this.voices){if(role&&voice.role!==role)continue;voice.envelope.gain.cancelScheduledValues(now);voice.envelope.gain.setTargetAtTime(0,now,.004);for(const source of voice.sources)try{source.stop(now+.02);}catch{}}}
 panic(){this.stopGroup();}
}
