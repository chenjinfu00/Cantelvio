export const MAX_VOLUME=500;
export function clampGain(value) {
  const gain=Number(value);
  return Number.isFinite(gain)?Math.max(0,Math.min(MAX_VOLUME/100,gain)):.45;
}

// Unity gain preserves quiet passages. Compression acts only near full scale;
// the final curve bounds transient overshoot without adding a playback buffer.
export class OrchestraOutput {
  constructor(context,gain=.45) {
    this.context=context;
    this.input=context.createGain();this.input.gain.value=clampGain(gain);
    this.limiter=context.createDynamicsCompressor();
    this.limiter.threshold.value=-1;
    this.limiter.knee.value=0;this.limiter.ratio.value=20;
    this.limiter.attack.value=.003;this.limiter.release.value=.1;
    this.ceiling=context.createWaveShaper();
    const curve=new Float32Array(4097);
    for(let i=0;i<curve.length;i++)curve[i]=Math.max(-.98,Math.min(.98,2*i/(curve.length-1)-1));
    this.ceiling.curve=curve;
    this.input.connect(this.limiter).connect(this.ceiling).connect(context.destination);
  }
  volume(value) {this.input.gain.setTargetAtTime(clampGain(value),this.context.currentTime,.03);}
  disconnect() {this.input.disconnect();this.limiter.disconnect();this.ceiling.disconnect();}
}
