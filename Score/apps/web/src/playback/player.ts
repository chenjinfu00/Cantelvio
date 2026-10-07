/**
 * Playback with Web Audio: the core timeline (tempo map, ties, dynamics) is scheduled in small
 * look-ahead windows. MuseScore General provides General MIDI sounds through SpessaSynth;
 * Salamander piano samples and light synthesis remain available if SoundFont loading fails.
 */
import {
  type PlaybackNote,
  type ScoreDoc,
  type Rational,
  add,
  buildPlayback,
  findEventOfNote,
  measureInfos,
  rat,
  scoreTimeAt,
  secondsAt,
} from '@cantelvio-score/core';
import { getStore } from '../state/store';
import { prepareSoundfont, playSoundfont, stopSoundfont } from './soundfont';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let session = 0;
const active = new Set<AudioScheduledSourceNode>();

interface Sample {
  readonly midi: number;
  readonly buffer: AudioBuffer;
}
let pianoSamples: Sample[] | null = null;
let pianoLoading: Promise<void> | null = null;

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(comp).connect(ctx.destination);
  }
  return ctx;
}

async function loadPiano(): Promise<void> {
  if (pianoSamples || pianoLoading) return pianoLoading ?? undefined;
  const ac = audio();
  pianoLoading = (async () => {
    try {
      const base = new URL('./audio/salamander/', document.baseURI);
      const manifest = (await (await fetch(new URL('manifest.json', base))).json()) as {
        samples: { midi: number; src: string }[];
      };
      const loaded = await Promise.all(
        manifest.samples.map(async (s) => {
          const data = await (await fetch(new URL(s.src, base))).arrayBuffer();
          return { midi: s.midi, buffer: await ac.decodeAudioData(data) };
        }),
      );
      pianoSamples = loaded.sort((a, b) => a.midi - b.midi);
    } catch (e) {
      console.warn('[playback] piano samples unavailable, using synthesis', e);
      pianoSamples = [];
    }
  })();
  return pianoLoading;
}

function playSample(n: PlaybackNote, when: number, gain: number): void {
  const ac = audio();
  const samples = pianoSamples!;
  let best = samples[0]!;
  for (const s of samples) if (Math.abs(s.midi - n.midi) < Math.abs(best.midi - n.midi)) best = s;
  const src = ac.createBufferSource();
  src.buffer = best.buffer;
  src.playbackRate.value = 2 ** ((n.midi - best.midi) / 12);
  const g = ac.createGain();
  const end = when + n.duration;
  g.gain.setValueAtTime(gain, when);
  g.gain.setValueAtTime(gain, end);
  g.gain.exponentialRampToValueAtTime(0.0008, end + 0.35);
  src.connect(g).connect(master!);
  src.start(when);
  src.stop(end + 0.4);
  track(src);
}

interface Preset {
  readonly wave: OscillatorType;
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
  readonly cutoff: number;
  readonly detune?: number;
}

function presetFor(program: number): Preset {
  if (program < 8)
    return {
      wave: 'triangle',
      attack: 0.004,
      decay: 1.2,
      sustain: 0.18,
      release: 0.25,
      cutoff: 5000,
    };
  if (program < 16)
    return { wave: 'sine', attack: 0.002, decay: 0.6, sustain: 0.05, release: 0.3, cutoff: 8000 };
  if (program < 24)
    return { wave: 'square', attack: 0.02, decay: 0.1, sustain: 0.8, release: 0.08, cutoff: 2200 };
  if (program < 32)
    return {
      wave: 'triangle',
      attack: 0.003,
      decay: 0.8,
      sustain: 0.1,
      release: 0.2,
      cutoff: 3500,
    };
  if (program < 40)
    return {
      wave: 'triangle',
      attack: 0.01,
      decay: 0.4,
      sustain: 0.5,
      release: 0.15,
      cutoff: 1500,
    };
  if (program < 52)
    return {
      wave: 'sawtooth',
      attack: 0.07,
      decay: 0.2,
      sustain: 0.75,
      release: 0.2,
      cutoff: 2600,
      detune: 6,
    };
  if (program < 56)
    return {
      wave: 'triangle',
      attack: 0.08,
      decay: 0.2,
      sustain: 0.8,
      release: 0.25,
      cutoff: 2000,
    };
  if (program < 64)
    return {
      wave: 'sawtooth',
      attack: 0.04,
      decay: 0.15,
      sustain: 0.8,
      release: 0.12,
      cutoff: 1800,
    };
  if (program < 72)
    return { wave: 'square', attack: 0.03, decay: 0.1, sustain: 0.75, release: 0.1, cutoff: 2400 };
  return { wave: 'sine', attack: 0.04, decay: 0.1, sustain: 0.85, release: 0.12, cutoff: 6000 };
}

function playSynth(n: PlaybackNote, when: number, gain: number): void {
  const ac = audio();
  const p = presetFor(n.program);
  const osc = ac.createOscillator();
  osc.type = p.wave;
  osc.frequency.value = 440 * 2 ** ((n.midi - 69) / 12);
  if (p.detune) osc.detune.value = (Math.random() - 0.5) * p.detune;
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = p.cutoff;
  const g = ac.createGain();
  const peak = gain * 0.5;
  const end = when + n.duration;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + p.attack);
  g.gain.exponentialRampToValueAtTime(
    Math.max(0.0002, peak * p.sustain),
    when + p.attack + p.decay,
  );
  g.gain.setValueAtTime(Math.max(0.0002, peak * p.sustain), Math.max(end, when + p.attack + 0.01));
  g.gain.exponentialRampToValueAtTime(0.0001, Math.max(end, when + p.attack + 0.01) + p.release);
  osc.connect(filter).connect(g).connect(master!);
  osc.start(when);
  osc.stop(Math.max(end, when + p.attack + 0.01) + p.release + 0.05);
  track(osc);
}

function playDrum(n: PlaybackNote, when: number, gain: number): void {
  const ac = audio();
  const length = Math.floor(ac.sampleRate * 0.25);
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = n.midi <= 36 ? 120 : n.midi >= 49 ? 6000 : 1800;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(master!);
  src.start(when);
  track(src);
}

function track(node: AudioScheduledSourceNode): void {
  active.add(node);
  node.onended = () => active.delete(node);
}

/** Start time of playback: selection, input cursor, or the beginning. */
function startTime(): Rational {
  const s = getStore().getState();
  const doc = s.doc;
  const infos = measureInfos(doc);
  if (s.selection.kind === 'range') return infos[s.selection.measureFrom]!.start;
  if (s.selection.kind === 'notes' && s.selection.noteIds.length) {
    const loc = findEventOfNote(doc, s.selection.noteIds[0]!);
    if (loc) return loc.start;
  }
  if (s.cursor) {
    const m = infos.find((x) => x.measure.id === s.cursor!.measureId);
    if (m) return add(m.start, s.cursor.offset);
  }
  return rat(0);
}

export function stopPlayback(): void {
  session++;
  stopSoundfont();
  for (const n of active) {
    try {
      n.stop();
    } catch {
      /* already stopped */
    }
  }
  active.clear();
  getStore().getState().setPlaying(false, null);
}

export async function togglePlayback(previewDoc?: ScoreDoc): Promise<void> {
  if (getStore().getState().playing) {
    stopPlayback();
    return;
  }
  const id = ++session;
  getStore().getState().setPlaying(true, null);
  const ac = audio();
  await ac.resume();
  const doc = previewDoc ?? getStore().getState().doc;
  const playback = buildPlayback(doc);
  const soundfont = await prepareSoundfont(ac, master!);
  if (!soundfont && playback.notes.some((n) => n.program < 8 && !n.drum)) await loadPiano();
  if (id !== session) return;
  const from = previewDoc ? 0 : secondsAt(playback.tempo, startTime());
  const t0 = ac.currentTime + 0.12;
  const notes = playback.notes.filter(
    (n) => n.start + n.duration > from && n.start >= from - 0.001,
  );
  let index = 0;
  getStore().getState().setPlaying(true, null);
  const scheduleAhead = () => {
    if (id !== session) return;
    const horizon = ac.currentTime - t0 + from + 1.0;
    while (index < notes.length && notes[index]!.start <= horizon) {
      const n = notes[index++]!;
      const when = t0 + (n.start - from);
      const gain = (n.velocity / 127) * 0.9;
      if (playSoundfont(n, when)) continue;
      if (n.drum) playDrum(n, when, gain);
      else if (n.program < 8 && pianoSamples && pianoSamples.length) playSample(n, when, gain);
      else playSynth(n, when, gain);
    }
    const elapsed = ac.currentTime - t0 + from;
    if (elapsed > playback.totalSeconds + 0.5) {
      stopPlayback();
      return;
    }
    setTimeout(scheduleAhead, 120);
  };
  scheduleAhead();
  const tick = () => {
    if (id !== session) return;
    const elapsed = Math.max(from, ac.currentTime - t0 + from);
    getStore().getState().setPlayhead(scoreTimeAt(playback.tempo, elapsed));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Short preview when a note is entered or selected. */
export async function previewMidi(
  midis: readonly number[],
  program = 0,
  drumMidi?: number,
): Promise<void> {
  const ac = audio();
  await ac.resume();
  const id = session;
  const soundfont = await prepareSoundfont(ac, master!);
  if (id !== session) return;
  if (!soundfont && drumMidi === undefined && program < 8) void loadPiano();
  const when = ac.currentTime + 0.01;
  for (const midi of midis) {
    const note: PlaybackNote = {
      partId: '',
      staffId: '',
      eventId: '',
      noteId: '',
      midi: drumMidi ?? midi,
      velocity: 84,
      program,
      drum: drumMidi !== undefined,
      at: rat(0),
      length: rat(1, 4),
      start: 0,
      duration: 0.35,
    };
    if (playSoundfont(note, when)) continue;
    if (note.drum) playDrum(note, when, 0.5);
    else if (program < 8 && pianoSamples && pianoSamples.length) playSample(note, when, 0.55);
    else playSynth(note, when, 0.5);
  }
}
