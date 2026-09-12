import {Fingerprinter,SAMPLE_RATE,resample,MAX_FRAMES} from './matcher.js';

export async function analyzeAudio(file,onProgress=()=>{},signal){
  if(file.size>180*1024*1024)throw new Error('请使用小于 180 MB 的录音，建议按乐章学习。');
  const context=new AudioContext({sampleRate:SAMPLE_RATE});
  try{
    const decoded=await context.decodeAudioData(await file.arrayBuffer());
    if(decoded.duration>45*60)throw new Error('请使用不超过 45 分钟的参考录音。');
    const mono=new Float32Array(decoded.length);
    for(let c=0;c<decoded.numberOfChannels;c++){const channel=decoded.getChannelData(c);for(let i=0;i<mono.length;i++)mono[i]+=channel[i]/decoded.numberOfChannels;}
    const samples=resample(mono,decoded.sampleRate),fp=new Fingerprinter(),frames=[];
    for(let offset=0;offset<samples.length;offset+=SAMPLE_RATE*3){
      if(signal?.aborted)throw new DOMException('已取消','AbortError');
      frames.push(...fp.push(samples.subarray(offset,offset+SAMPLE_RATE*3)).filter(f=>f.active));
      if(frames.length>MAX_FRAMES)throw new Error('参考演奏太长，请分段学习。');
      onProgress(Math.min(1,(offset+SAMPLE_RATE*3)/samples.length));
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(frames.length<20)throw new Error('没有找到足够的音乐声音，请换一段清楚的录音。');
    return {frames,duration:decoded.duration};
  }finally{await context.close();}
}

export class Microphone {
  async start(onFrame,onEnded=()=>{}){
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('麦克风需要 HTTPS 或 localhost。请在本机打开 localhost，或使用 HTTPS 网站。');
    try{
      this.context=new AudioContext({sampleRate:SAMPLE_RATE});
      await this.context.resume();
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1},video:false});
      // Do not resample each chunk: cross-chunk interpolation must remain
      // continuous. Modern Web Audio honors the requested processing rate.
      if(this.context.sampleRate!==SAMPLE_RATE)throw new Error('浏览器未支持所需音频采样率，请使用最新版 Chrome 或 Edge。');
      await this.context.audioWorklet.addModule(new URL('./capture-worklet.js',import.meta.url));
      this.fp=new Fingerprinter();this.node=new AudioWorkletNode(this.context,'volta-capture');
      this.source=this.context.createMediaStreamSource(this.stream);
      this.silent=this.context.createGain();this.silent.gain.value=0;
      this.source.connect(this.node);this.node.connect(this.silent);this.silent.connect(this.context.destination);
      this.node.port.onmessage=e=>{for(const frame of this.fp.push(e.data))onFrame(frame);};
      this.stream.getTracks().forEach(track=>track.onended=onEnded);
    }catch(error){await this.stop();throw error;}
  }
  async stop(){
    if(this.node){this.node.port.onmessage=null;this.node.disconnect();}
    this.source?.disconnect();this.silent?.disconnect();
    this.stream?.getTracks().forEach(track=>{track.onended=null;track.stop();});
    if(this.context&&this.context.state!=='closed')await this.context.close();
    this.context=null;this.stream=null;this.node=null;
  }
}
