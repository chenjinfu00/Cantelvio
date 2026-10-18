// No media leaves this page. Microphone samples are analysed and discarded.
import {Fingerprinter,SAMPLE_RATE} from '../stage/matcher.js';
export class OrchestraSynth {
  async init(gain=.45) {
    this.cancelled=false;
    const context=this.context=new AudioContext({latencyHint:'interactive'});
    await context.resume();
    const [{WorkletSynthesizer},response]=await Promise.all([import('./vendor/synth.js'),fetch('../score/audio/soundfonts/MuseScore_General.sf3')]);
    if(!response.ok)throw Error('乐队音色载入失败 / SoundFont download failed');
    const bank=await response.arrayBuffer();
    if(this.cancelled)return;
    await context.audioWorklet.addModule('./vendor/processor.js');
    if(this.cancelled)return;
    const synth=this.synth=new WorkletSynthesizer(context);synth.setLogLevel(false,true,false);
    await synth.soundBankManager.addSoundBank(bank,'MuseScore_General');await synth.isReady;
    if(this.cancelled){synth.destroy();return;}
    this.output=context.createGain();this.output.gain.value=gain;this.output.connect(context.destination);synth.connect(this.output);this.channels=new Map();
  }
  channel(e) {
    const key=`${e.track}:${e.channel}`;
    if(!this.channels.has(key)) {
      const channel=this.channels.size;while(this.synth.channelCount<=channel)this.synth.addNewChannel();
      this.synth.midiChannels[channel].setDrums(e.channel===9);this.channels.set(key,channel);
    }
    return this.channels.get(key);
  }
  send(e,at) {
    if(this.cancelled || !this.synth)return;
    const ch=this.channel(e),opts={time:at};
    if(e.command===8 || e.command===9 && !e.b)this.synth.noteOff(ch,e.a,opts);
    else if(e.command===9)this.synth.noteOn(ch,e.a,e.b,opts);
    else if(e.command===11)this.synth.controllerChange(ch,e.a,e.b,opts);
    else if(e.command===12)this.synth.programChange(ch,e.a,opts);
    else if(e.command===14)this.synth.pitchWheel(ch,e.a+128*e.b,opts);
    else if(e.command===13)this.synth.channelPressure(ch,e.a,opts);
    else if(e.command===10)this.synth.polyPressure(ch,e.a,e.b,opts);
  }
  volume(value) {this.output?.gain.setTargetAtTime(value,this.context.currentTime,.03);}
  async stop() {this.cancelled=true;this.synth?.disconnect();this.synth?.destroy();this.synth=null;this.output?.disconnect();if(this.context && this.context.state!=='closed')await this.context.close();}
}
export class LiveMic {
  async start({deviceId,speaker,onFrame,onEnded}) {
    this.cancelled=false;
    this.context=new AudioContext({sampleRate:SAMPLE_RATE});await this.context.resume();
    const request=navigator.mediaDevices.getUserMedia({audio:{deviceId:deviceId?{exact:deviceId}:undefined,echoCancellation:speaker,noiseSuppression:false,autoGainControl:false,channelCount:1},video:false});
    request.then(stream=>{if(this.cancelled)stream.getTracks().forEach(track=>track.stop());},()=>{});
    let timeout;
    try {this.stream=await Promise.race([request,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('麦克风授权未完成，请允许权限或用 Chrome / Edge 打开 / Microphone permission timed out')),30000);})]);}
    finally {clearTimeout(timeout);}
    if(this.cancelled){await this.stop();return;}
    if(this.context.sampleRate!==SAMPLE_RATE)throw Error('请使用支持 22050 Hz 音频的 Chrome / Edge');
    await this.context.audioWorklet.addModule('../stage/capture-worklet.js');
    if(this.cancelled)return;
    this.fp=new Fingerprinter();this.node=new AudioWorkletNode(this.context,'volta-capture');
    this.source=this.context.createMediaStreamSource(this.stream);this.mute=this.context.createGain();this.mute.gain.value=0;
    this.source.connect(this.node);this.node.connect(this.mute).connect(this.context.destination);
    this.node.port.onmessage=e=>{for(const frame of this.fp.push(e.data))onFrame(frame);};
    for(const track of this.stream.getTracks())track.onended=onEnded;
  }
  async stop() {this.cancelled=true;if(this.node){this.node.port.onmessage=null;this.node.disconnect();}this.source?.disconnect();this.mute?.disconnect();this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});if(this.context && this.context.state!=='closed')await this.context.close();}
}
