const GROUPS = ['woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings'];
const PATCHES = {
  woodwinds: {wave: 'sine', gain: .23, attack: .055, release: .17, cutoff: 3600, pan: -.53},
  brass: {wave: 'sawtooth', gain: .105, attack: .065, release: .22, cutoff: 1950, pan: .43},
  percussion: {wave: 'triangle', gain: .18, attack: .004, release: .25, cutoff: 4300, pan: .08},
  keys: {wave: 'triangle', gain: .18, attack: .007, release: .34, cutoff: 4700, pan: -.18},
  high_strings: {wave: 'sawtooth', gain: .105, attack: .11, release: .28, cutoff: 2700, pan: -.36},
  low_strings: {wave: 'sawtooth', gain: .13, attack: .12, release: .33, cutoff: 1550, pan: .32},
};

export function quarterToSeconds(quarter, sample) {
  const bars = sample.barEvents;
  let seconds = 0;
  for (let i = 0; i < bars.length; i++) {
    const start = bars[i].quarter;
    const end = i + 1 < bars.length ? bars[i + 1].quarter : sample.totalQuarters;
    if (quarter <= start) break;
    seconds += (Math.min(quarter, end) - start) * 60 / bars[i].bpm;
    if (quarter <= end) break;
  }
  if (bars.length && quarter > sample.totalQuarters) {
    seconds += (quarter - sample.totalQuarters) * 60 / bars.at(-1).bpm;
  }
  return seconds;
}

function makeEnvelope(context, at, duration, patch, velocity, destination, short = false) {
  const level = patch.gain * Math.max(.18, velocity / 127);
  const attack = Math.min(patch.attack, duration * .36);
  const release = short ? .09 : patch.release;
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, at);
  envelope.gain.linearRampToValueAtTime(level, at + Math.max(.003, attack));
  envelope.gain.setValueAtTime(level * (short ? .58 : .78), at + Math.max(attack + .008, duration * .45));
  envelope.gain.exponentialRampToValueAtTime(.0001, at + duration + release);
  envelope.connect(destination);
  return {envelope, end: at + duration + release + .02};
}

function addPitched(context, note, at, duration, bus, mode) {
  const patch = mode === 'piano' ? PATCHES.keys : PATCHES[note.group] ?? PATCHES.keys;
  const short = mode === 'piano' || note.group === 'keys' || note.group === 'percussion';
  const envelope = makeEnvelope(context, at, duration, patch, note.velocity, bus, short);
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = patch.cutoff;
  filter.Q.value = .4;
  filter.connect(envelope.envelope);
  const oscillator = context.createOscillator();
  oscillator.type = patch.wave;
  oscillator.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12);
  oscillator.connect(filter);
  oscillator.start(at);
  oscillator.stop(envelope.end);
  if (mode !== 'piano' && (note.group === 'high_strings' || note.group === 'low_strings')) {
    const ensemble = context.createOscillator();
    const trim = context.createGain();
    trim.gain.value = .27;
    ensemble.type = 'triangle';
    ensemble.frequency.value = oscillator.frequency.value;
    ensemble.detune.value = 7;
    ensemble.connect(trim); trim.connect(filter);
    ensemble.start(at); ensemble.stop(envelope.end);
  }
}

function noiseBuffer(context, seed) {
  const buffer = context.createBuffer(1, Math.round(context.sampleRate * .45), context.sampleRate);
  const samples = buffer.getChannelData(0);
  let state = (seed || 1) >>> 0;
  for (let i = 0; i < samples.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    samples[i] = (state / 4294967296) * 2;
  }
  return buffer;
}

function addDrum(context, note, at, bus, noise) {
  const kick = note.pitch === 35 || note.pitch === 36;
  const duration = kick ? .3 : .18;
  const envelope = makeEnvelope(context, at, duration, {gain: kick ? .22 : .12, attack: .003, release: .05},
    note.velocity, bus, true);
  if (kick) {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(126, at);
    oscillator.frequency.exponentialRampToValueAtTime(48, at + .22);
    oscillator.connect(envelope.envelope);
    oscillator.start(at); oscillator.stop(envelope.end);
  } else {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    filter.type = note.pitch === 38 || note.pitch === 40 ? 'bandpass' : 'highpass';
    filter.frequency.value = note.pitch === 38 || note.pitch === 40 ? 1850 : 4600;
    source.buffer = noise;
    source.connect(filter); filter.connect(envelope.envelope);
    source.start(at); source.stop(Math.min(envelope.end, at + .4));
  }
}

function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const data = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(data);
  const tag = (at, value) => [...value].forEach((letter, index) => view.setUint8(at + index, letter.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); tag(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  const values = Array.from({length: channels}, (_, i) => buffer.getChannelData(i));
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++, offset += 2) {
    const value = Math.max(-1, Math.min(1, values[channel][frame]));
    view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
  }
  return new Blob([data], {type: 'audio/wav'});
}

export async function renderAudio(sample, mode = 'ensemble', {preserveTails = false} = {}) {
  const musicEnd = quarterToSeconds(sample.totalQuarters, sample);
  const duration = Math.min(95, musicEnd + (preserveTails ? 4.1 : 1.3));
  const sampleRate = 32000;
  const context = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const master = context.createGain(); master.gain.value = .62;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -15; compressor.ratio.value = 5; compressor.attack.value = .004;
  master.connect(compressor); compressor.connect(context.destination);
  const buses = Object.fromEntries(GROUPS.map(group => {
    const pan = context.createStereoPanner();
    pan.pan.value = mode === 'piano' ? 0 : PATCHES[group].pan;
    pan.connect(master);
    return [group, pan];
  }));
  const noise = noiseBuffer(context, sample.seed);
  for (const note of sample.notes) {
    const at = quarterToSeconds(note.quarter, sample);
    if (at >= duration - .1) continue;
    const end = quarterToSeconds(preserveTails ? note.quarter + note.duration :
      Math.min(sample.totalQuarters, note.quarter + note.duration), sample);
    const length = Math.max(.055, Math.min(3.5, end - at, duration - at - .1));
    if (note.drum) addDrum(context, note, at, buses[note.group], noise);
    else addPitched(context, note, at, length, buses[note.group], mode);
  }
  return {blob: encodeWav(await context.startRendering()), duration: musicEnd};
}
