/**
 * Playback timeline: turns the score into timed MIDI-like notes (seconds), honouring tempo marks,
 * explicit ties, dynamics and basic articulations. Pure; audio scheduling lives in the app.
 */
import { findInstrument } from '../instruments/catalog';
import { allStaves, measureInfos, scoreLength } from '../model/query';
import type { DynamicValue, ID, ScoreDoc } from '../model/types';
import { midiOf } from '../pitch/pitch';
import { type Rational, add, cmp, eq, lt, sub, toNumber } from '../time/rational';

export interface TempoPoint {
  /** Absolute score time (whole notes). */
  readonly at: Rational;
  /** Quarter notes per minute. */
  readonly qpm: number;
  /** Seconds elapsed at `at`. */
  readonly seconds: number;
}

export interface PlaybackNote {
  readonly partId: ID;
  readonly staffId: ID;
  readonly eventId: ID;
  readonly noteId: ID;
  readonly midi: number;
  readonly velocity: number;
  readonly program: number;
  readonly drum: boolean;
  /** Absolute score time and length in whole notes. */
  readonly at: Rational;
  readonly length: Rational;
  readonly start: number;
  readonly duration: number;
}

export interface Playback {
  readonly notes: readonly PlaybackNote[];
  readonly tempo: readonly TempoPoint[];
  readonly totalSeconds: number;
}

// prettier-ignore
export const DYNAMIC_VELOCITY: Readonly<Record<DynamicValue, number>> = {
  pppp: 20, ppp: 30, pp: 42, p: 56, mp: 70, mf: 84, f: 98, ff: 110, fff: 120, ffff: 127,
  sf: 108, sfz: 112, sffz: 118, fz: 108, fp: 98, sfp: 108, rf: 104, rfz: 108,
};

export function tempoMap(doc: ScoreDoc): TempoPoint[] {
  const marks: { at: Rational; qpm: number }[] = [];
  for (const info of measureInfos(doc)) {
    for (const t of info.measure.tempo ?? []) {
      const beat = t.beatUnit ? toNumber(t.beatUnit) : 0.25;
      marks.push({ at: add(info.start, t.offset), qpm: t.bpm * (beat / 0.25) });
    }
  }
  marks.sort((a, b) => cmp(a.at, b.at));
  const points: TempoPoint[] = [];
  let seconds = 0;
  let prev: { at: Rational; qpm: number } = { at: { n: 0, d: 1 }, qpm: doc.settings.defaultTempo };
  if (marks[0] && eq(marks[0].at, prev.at)) prev = marks.shift()!;
  points.push({ at: prev.at, qpm: prev.qpm, seconds: 0 });
  for (const m of marks) {
    seconds += wholeNotesToSeconds(sub(m.at, prev.at), prev.qpm);
    points.push({ at: m.at, qpm: m.qpm, seconds });
    prev = m;
  }
  return points;
}

function wholeNotesToSeconds(length: Rational, qpm: number): number {
  return (toNumber(length) * 4 * 60) / qpm;
}

export function secondsAt(map: readonly TempoPoint[], t: Rational): number {
  let p = map[0]!;
  for (const q of map) {
    if (cmp(q.at, t) <= 0) p = q;
    else break;
  }
  return p.seconds + wholeNotesToSeconds(sub(t, p.at), p.qpm);
}

/** Inverse of secondsAt, as a float in whole notes (for the playhead). */
export function scoreTimeAt(map: readonly TempoPoint[], seconds: number): number {
  let p = map[0]!;
  for (const q of map) {
    if (q.seconds <= seconds) p = q;
    else break;
  }
  return toNumber(p.at) + ((seconds - p.seconds) * p.qpm) / (4 * 60);
}

export function buildPlayback(doc: ScoreDoc): Playback {
  const tempo = tempoMap(doc);
  const infos = measureInfos(doc);
  const notes: PlaybackNote[] = [];
  for (const s of allStaves(doc)) {
    const def = findInstrument(s.part.instrument);
    const program = s.part.midiProgram ?? def?.gmProgram ?? 0;
    const drum = !!def?.unpitched;
    // Dynamics in force per staff (latest mark at or before a time).
    const dyn: { at: Rational; value: DynamicValue }[] = [];
    for (const info of infos) {
      for (const d of doc.content[s.staff.id]?.[info.measure.id]?.dynamics ?? [])
        dyn.push({ at: add(info.start, d.offset), value: d.value });
    }
    const velocityAt = (t: Rational) => {
      let v = 84;
      for (const d of dyn) if (cmp(d.at, t) <= 0) v = DYNAMIC_VELOCITY[d.value];
      return v;
    };
    for (let voice = 0; voice < 4; voice++) {
      // Open ties: midi -> index into `notes` of the note being extended.
      let open = new Map<number, number>();
      for (const info of infos) {
        const events = doc.content[s.staff.id]?.[info.measure.id]?.voices[voice] ?? [];
        for (const e of events) {
          const at = add(info.start, e.offset);
          const next = new Map<number, number>();
          const arts = new Set(e.articulations ?? []);
          const factor = arts.has('staccatissimo')
            ? 0.3
            : arts.has('staccato')
              ? 0.5
              : arts.has('tenuto')
                ? 1
                : 0.95;
          for (const n of e.notes) {
            const midi = drum ? (def?.range[0] ?? 38) : midiOf(n.pitch);
            const tiedFrom = open.get(midi);
            if (
              tiedFrom !== undefined &&
              eq(add(notes[tiedFrom]!.at, notes[tiedFrom]!.length), at)
            ) {
              const prev = notes[tiedFrom]!;
              const length = add(prev.length, e.duration);
              notes[tiedFrom] = {
                ...prev,
                length,
                duration: secondsAt(tempo, add(prev.at, length)) - prev.start,
              };
              if (n.tieForward) next.set(midi, tiedFrom);
              continue;
            }
            let velocity = n.velocity ?? velocityAt(at);
            if (arts.has('accent') || arts.has('marcato')) velocity = Math.min(127, velocity + 16);
            const start = secondsAt(tempo, at);
            const end = secondsAt(tempo, add(at, e.duration));
            notes.push({
              partId: s.part.id,
              staffId: s.staff.id,
              eventId: e.id,
              noteId: n.id,
              midi,
              velocity,
              program,
              drum,
              at,
              length: e.duration,
              start,
              duration: Math.max(0.03, (end - start) * (n.tieForward ? 1 : factor)),
            });
            if (n.tieForward) next.set(midi, notes.length - 1);
          }
          open = next;
        }
      }
    }
  }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  const totalSeconds = secondsAt(tempo, scoreLength(doc));
  return { notes, tempo, totalSeconds };
}

/** Notes sounding or starting in [from, to) seconds (for chunked scheduling). */
export function notesBetween(p: Playback, from: number, to: number): PlaybackNote[] {
  return p.notes.filter((n) => n.start >= from && n.start < to);
}

export const isBefore = (a: Rational, b: Rational): boolean => lt(a, b);
