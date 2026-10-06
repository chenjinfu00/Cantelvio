import { configurePlaybackSession, resumePlaybackContext } from "./audio-session.js";

const SAMPLE_ROOT = new URL("../media/karaoke/piano/", import.meta.url);

export const PIANO_SAMPLES = Array.from({ length: 17 }, (_, index) => {
  const midi = 36 + index * 3;
  return { midi, file: `${["C", "Ds", "Fs", "A"][(midi % 12) / 3]}${Math.floor(midi / 12) - 1}.mp3` };
});

export function nearestPianoSample(midi) {
  return PIANO_SAMPLES.reduce((best, sample) => Math.abs(sample.midi - midi) < Math.abs(best.midi - midi) ? sample : best);
}

/** Small same-origin sample player; the caller owns run cancellation and completion. */
export class PianoSampler {
  constructor({ fetcher = (...args) => fetch(...args), contextFactory = null } = {}) {
    this.fetcher = fetcher;
    this.contextFactory = contextFactory;
    this.context = null;
    this.encoded = new Map();
    this.buffers = new Map();
    this.voices = new Set();
    this.loadPromise = null;
    this.decodePromise = null;
    this.ready = false;
  }

  load() {
    if (!this.loadPromise) {
      this.loadPromise = Promise.all(PIANO_SAMPLES.map(async sample => {
        if (this.encoded.has(sample.midi)) return;
        const response = await this.fetcher(new URL(sample.file, SAMPLE_ROOT));
        if (!response.ok) throw new Error(`Piano sample: HTTP ${response.status}`);
        this.encoded.set(sample.midi, await response.arrayBuffer());
      })).catch(error => { this.loadPromise = null; throw error; });
    }
    return this.loadPromise;
  }

  async prepareContext() {
    configurePlaybackSession();
    if (!this.context || this.context.state === "closed") {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!this.contextFactory && !Context) throw new Error("Web Audio is unavailable");
      this.context = this.contextFactory ? this.contextFactory() : new Context({ latencyHint: "interactive" });
      const master = this.context.createGain();
      master.gain.value = .55;
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.knee.value = 8;
      compressor.ratio.value = 5;
      compressor.attack.value = .006;
      compressor.release.value = .12;
      master.connect(compressor).connect(this.context.destination);
      this.output = master;
    }
    // Resume during the click, before fetching or decoding any samples.
    return resumePlaybackContext(this.context);
  }

  async prepare() {
    await this.prepareContext();
    await this.load();
    if (!this.decodePromise) {
      this.decodePromise = (async () => {
        for (const sample of PIANO_SAMPLES) {
          if (!this.buffers.has(sample.midi)) {
            const buffer = await this.context.decodeAudioData(this.encoded.get(sample.midi).slice(0));
            this.buffers.set(sample.midi, buffer);
          }
        }
      })().catch(error => { this.decodePromise = null; throw error; });
    }
    await this.decodePromise;
    if (this.context.state !== "running") throw new Error("Audio output is paused");
    this.ready = true;
    return true;
  }

  playMidi(midi, durationMs = 900, velocity = .8) {
    if (!this.ready || this.context.state !== "running" || !Number.isFinite(midi)) return false;
    const sample = nearestPianoSample(midi);
    const buffer = this.buffers.get(sample.midi);
    if (!buffer) return false;
    const now = this.context.currentTime;
    const duration = Math.max(.04, durationMs / 1000);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(2 ** ((midi - sample.midi) / 12), now);
    const gain = this.context.createGain();
    const level = .48 * Math.max(.05, Math.min(1, velocity));
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + .004);
    gain.gain.setValueAtTime(level, now + duration);
    gain.gain.exponentialRampToValueAtTime(.0001, now + duration + .22);
    source.connect(gain).connect(this.output);
    const voice = { source, gain };
    this.voices.add(voice);
    source.addEventListener("ended", () => {
      this.voices.delete(voice);
      source.disconnect();
      gain.disconnect();
    }, { once: true });
    source.start(now);
    source.stop(now + duration + .24);
    return true;
  }

  stopAll() {
    const now = this.context?.currentTime || 0;
    this.voices.forEach(({ source, gain }) => {
      try {
        if (gain.gain.cancelAndHoldAtTime) gain.gain.cancelAndHoldAtTime(now);
        else {
          const held = Math.max(.0001, gain.gain.value);
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(held, now);
        }
        gain.gain.linearRampToValueAtTime(.0001, now + .012);
        source.stop(now + .015);
      } catch { /* An ended voice may be awaiting its callback. */ }
    });
    this.voices.clear();
  }
}
