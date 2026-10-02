/**
 * Playback timeline: turns the score into timed MIDI-like notes (seconds), honouring tempo marks,
 * explicit ties, dynamics and hairpins, articulations and slurs, ornaments and trill lines,
 * tremolos, rolled chords, grace notes and the sustain pedal. Pure; audio scheduling lives in the
 * app.
 */
import { findInstrument } from '../instruments/catalog';
import { allStaves, findEvent, measureInfos, scoreLength } from '../model/query';
import { spannerTimes } from '../model/spanners';
import type { DynamicValue, ID, NoteEvent, Ornament, ScoreDoc } from '../model/types';
import {
  type KeySignature,
  type Pitch,
  diatonicOf,
  keyAlter,
  midiOf,
  pitchFromDiatonic,
} from '../pitch/pitch';
import { NOTE_VALUE_LENGTH } from '../time/duration';
import {
  type Rational,
  ZERO,
  add,
  cmp,
  div,
  divInt,
  eq,
  le,
  lt,
  min,
  mul,
  mulInt,
  rat,
  sub,
  toNumber,
} from '../time/rational';

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

/** Ornament notes are 32nds (shorter on short notes). */
const ORNAMENT_UNIT = rat(1, 32);
/** Delay between the notes of a rolled chord. */
const ROLL_STEP = rat(1, 64);
/** An acciaccatura sounds this long; an appoggiatura takes its written value. */
const ACCIACCATURA = rat(1, 32);
/** Change of velocity over a hairpin that does not end on a dynamic. */
const HAIRPIN_STEP = 20;

interface Piece {
  /** Offset from the event start and length, whole notes. */
  readonly at: Rational;
  readonly length: Rational;
  readonly pitch: Pitch;
}

/** The diatonic neighbour in the key (the "upper/lower note" of an ornament). */
function neighbour(p: Pitch, dir: 1 | -1, key: KeySignature): Pitch {
  const q = pitchFromDiatonic(diatonicOf(p) + dir);
  return { ...q, alter: keyAlter(key.fifths, q.step) };
}

/** Notes played for an ornament on a note of the given length. */
export function ornamentPieces(
  ornament: Ornament,
  pitch: Pitch,
  key: KeySignature,
  length: Rational,
): Piece[] {
  const up = neighbour(pitch, 1, key);
  const down = neighbour(pitch, -1, key);
  const unit = min(ORNAMENT_UNIT, divInt(length, 4));
  const run = (pitches: Pitch[]): Piece[] => {
    const out: Piece[] = pitches.map((p, k) => ({ at: mulInt(unit, k), length: unit, pitch: p }));
    const used = mulInt(unit, pitches.length);
    out.push({ at: used, length: sub(length, used), pitch });
    return out;
  };
  switch (ornament) {
    case 'shortTrill':
      return run([pitch, up]);
    case 'mordent':
      return run([pitch, down]);
    case 'turn':
      return run([up, pitch, down]);
    case 'invertedTurn':
      return run([down, pitch, up]);
    case 'trill': {
      const n = Math.max(2, Math.floor(toNumber(div(length, unit))));
      const out: Piece[] = [];
      for (let k = 0; k < n - 1; k++)
        out.push({ at: mulInt(unit, k), length: unit, pitch: k % 2 === 0 ? pitch : up });
      const last = mulInt(unit, n - 1);
      out.push({ at: last, length: sub(length, last), pitch: (n - 1) % 2 === 0 ? pitch : up });
      return out;
    }
  }
}

/** Grace note timing: on the beat, taking time from the principal (at most half of it). */
function graceSchedule(e: NoteEvent): { lengths: Rational[]; total: Rational } {
  const graces = e.graces ?? [];
  if (!graces.length) return { lengths: [], total: ZERO };
  let lengths = graces.map((g) => (g.slash ? ACCIACCATURA : NOTE_VALUE_LENGTH[g.value]));
  let total = lengths.reduce(add, ZERO);
  const cap = divInt(e.duration, 2);
  if (lt(cap, total)) {
    lengths = lengths.map((l) => mul(l, div(cap, total)));
    total = cap;
  }
  return { lengths, total };
}

interface StaffMarks {
  readonly dynamics: { at: Rational; value: DynamicValue }[];
  readonly hairpins: { start: Rational; end: Rational; up: boolean }[];
  readonly trills: { start: Rational; end: Rational }[];
  /** Per voice: slurred time ranges [first note start, last note start). */
  readonly slurs: Map<number, { start: Rational; end: Rational }[]>;
}

function staffMarks(doc: ScoreDoc, staffId: ID): StaffMarks {
  const dynamics: StaffMarks['dynamics'] = [];
  for (const info of measureInfos(doc)) {
    for (const d of doc.content[staffId]?.[info.measure.id]?.dynamics ?? [])
      dynamics.push({ at: add(info.start, d.offset), value: d.value });
  }
  dynamics.sort((a, b) => cmp(a.at, b.at));
  const hairpins: StaffMarks['hairpins'] = [];
  const trills: StaffMarks['trills'] = [];
  const slurs = new Map<number, { start: Rational; end: Rational }[]>();
  for (const s of doc.spanners) {
    if (s.staffId !== staffId) continue;
    if (s.kind === 'slur') {
      const a = findEvent(doc, s.from);
      const b = findEvent(doc, s.to);
      if (!a || !b) continue;
      const list = slurs.get(a.voice) ?? [];
      list.push({ start: a.start, end: b.start });
      slurs.set(a.voice, list);
      continue;
    }
    const t = spannerTimes(doc, s);
    if (!t) continue;
    if (s.kind === 'hairpin') hairpins.push({ ...t, up: s.direction === 'crescendo' });
    else if (s.kind === 'trill') trills.push(t);
  }
  hairpins.sort((a, b) => cmp(a.start, b.start));
  return { dynamics, hairpins, trills, slurs };
}

/** Velocity at time t from dynamics, ramped through hairpins. */
function velocityAt(m: StaffMarks, t: Rational): number {
  let v = 84;
  let since = ZERO;
  for (const d of m.dynamics) {
    if (cmp(d.at, t) > 0) break;
    v = DYNAMIC_VELOCITY[d.value];
    since = d.at;
  }
  for (const h of m.hairpins) {
    if (lt(h.start, since)) continue;
    if (cmp(h.start, t) > 0) break;
    // the hairpin leads to a dynamic at (or just after) its end, else changes by a step
    const target = m.dynamics.find((d) => le(h.end, d.at) && le(d.at, add(h.end, rat(1, 8))));
    const goal = target
      ? DYNAMIC_VELOCITY[target.value]
      : Math.max(20, Math.min(127, v + (h.up ? HAIRPIN_STEP : -HAIRPIN_STEP)));
    if (lt(t, h.end)) {
      const frac = toNumber(sub(t, h.start)) / Math.max(1e-9, toNumber(sub(h.end, h.start)));
      return Math.round(v + (goal - v) * frac);
    }
    v = goal;
    since = h.end;
  }
  return v;
}

export function buildPlayback(doc: ScoreDoc): Playback {
  const tempo = tempoMap(doc);
  const infos = measureInfos(doc);
  const notes: PlaybackNote[] = [];
  const seconds = (t: Rational) => secondsAt(tempo, t);
  for (const s of allStaves(doc)) {
    const def = findInstrument(s.part.instrument);
    const program = s.part.midiProgram ?? def?.gmProgram ?? 0;
    const drum = !!def?.unpitched;
    const marks = staffMarks(doc, s.staff.id);
    const inTrill = (t: Rational) => marks.trills.some((r) => le(r.start, t) && lt(t, r.end));
    for (let voice = 0; voice < 4; voice++) {
      const slurred = marks.slurs.get(voice) ?? [];
      // Open ties: midi -> index into `notes` of the note being extended.
      let open = new Map<number, number>();
      for (const info of infos) {
        const events = doc.content[s.staff.id]?.[info.measure.id]?.voices[voice] ?? [];
        for (const e of events) {
          const eventStart = add(info.start, e.offset);
          const next = new Map<number, number>();
          const arts = new Set(e.articulations ?? []);
          const legato = slurred.some((r) => le(r.start, eventStart) && lt(eventStart, r.end));
          let factor = arts.has('staccatissimo')
            ? 0.3
            : arts.has('staccato')
              ? 0.5
              : arts.has('tenuto') || legato
                ? 1
                : 0.95;
          if (e.breath) factor = Math.min(factor, e.breath === 'caesura' ? 0.7 : 0.85);
          const push = (
            noteId: ID,
            midi: number,
            velocity: number,
            at: Rational,
            length: Rational,
            gate: number,
          ) => {
            const start = seconds(at);
            const end = seconds(add(at, length));
            notes.push({
              partId: s.part.id,
              staffId: s.staff.id,
              eventId: e.id,
              noteId,
              midi,
              velocity,
              program,
              drum,
              at,
              length,
              start,
              duration: Math.max(0.03, (end - start) * gate),
            });
          };
          const midiFor = (p: Pitch) => (drum ? (def?.range[0] ?? 38) : midiOf(p));
          const key = infos[info.index]!.keySig;
          // grace notes, on the beat
          const graces = graceSchedule(e);
          let gt = eventStart;
          (e.graces ?? []).forEach((g, k) => {
            const len = graces.lengths[k]!;
            for (const n of g.notes)
              push(n.id, midiFor(n.pitch), n.velocity ?? velocityAt(marks, gt), gt, len, 0.95);
            gt = add(gt, len);
          });
          const at = add(eventStart, graces.total);
          const duration = sub(e.duration, graces.total);
          const ornament = e.ornament ?? (inTrill(eventStart) ? 'trill' : undefined);
          const top = e.notes[e.notes.length - 1]!;
          e.notes.forEach((n, k) => {
            const midi = midiFor(n.pitch);
            const tiedFrom = open.get(midi);
            if (
              tiedFrom !== undefined &&
              !graces.total.n &&
              eq(add(notes[tiedFrom]!.at, notes[tiedFrom]!.length), at)
            ) {
              const prev = notes[tiedFrom]!;
              const length = add(prev.length, duration);
              notes[tiedFrom] = {
                ...prev,
                length,
                duration: seconds(add(prev.at, length)) - prev.start,
              };
              if (n.tieForward) next.set(midi, tiedFrom);
              return;
            }
            let velocity = n.velocity ?? velocityAt(marks, at);
            if (arts.has('accent') || arts.has('marcato')) velocity = Math.min(127, velocity + 16);
            // rolled chord: later notes start later and end together
            const order = e.arpeggio === 'down' ? e.notes.length - 1 - k : k;
            const delay = e.arpeggio ? min(mulInt(ROLL_STEP, order), divInt(duration, 2)) : ZERO;
            const nAt = add(at, delay);
            const nLen = sub(duration, delay);
            const gate = n.tieForward ? 1 : factor;
            if (ornament && !drum && n === top) {
              for (const piece of ornamentPieces(ornament, n.pitch, key, nLen))
                push(n.id, midiOf(piece.pitch), velocity, add(nAt, piece.at), piece.length, 0.95);
              return;
            }
            if (e.tremolo) {
              const unit = rat(1, 2 ** (e.tremolo + 2));
              let x = ZERO;
              while (lt(x, nLen)) {
                const len = min(unit, sub(nLen, x));
                push(n.id, midi, velocity, add(nAt, x), len, 0.9);
                x = add(x, len);
              }
              return;
            }
            push(n.id, midi, velocity, nAt, nLen, gate);
            if (n.tieForward) next.set(midi, notes.length - 1);
          });
          open = next;
        }
      }
    }
  }
  sustain(doc, notes, seconds);
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  const totalSeconds = secondsAt(tempo, scoreLength(doc));
  return { notes, tempo, totalSeconds };
}

/** Sustain pedal: notes sounding while the pedal is down ring until it is released. */
function sustain(doc: ScoreDoc, notes: PlaybackNote[], seconds: (t: Rational) => number): void {
  const staffPart = new Map(allStaves(doc).map((s) => [s.staff.id, s.part.id]));
  const pedals = new Map<ID, { down: number; up: number }[]>();
  for (const sp of doc.spanners) {
    if (sp.kind !== 'pedal') continue;
    const t = spannerTimes(doc, sp);
    const part = staffPart.get(sp.staffId);
    if (!t || !part) continue;
    const list = pedals.get(part) ?? [];
    list.push({ down: seconds(t.start), up: seconds(t.end) });
    pedals.set(part, list);
  }
  if (!pedals.size) return;
  const eps = 1e-6;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]!;
    if (n.drum) continue;
    // caught when the key is still down at some moment while the pedal is down
    const keyOff = n.start + n.duration;
    let off = keyOff;
    for (const p of pedals.get(n.partId) ?? [])
      if (n.start < p.up - eps && keyOff > p.down + eps) off = Math.max(off, p.up);
    if (off > keyOff) notes[i] = { ...n, duration: off - n.start };
  }
}

/** Notes sounding or starting in [from, to) seconds (for chunked scheduling). */
export function notesBetween(p: Playback, from: number, to: number): PlaybackNote[] {
  return p.notes.filter((n) => n.start >= from && n.start < to);
}

export const isBefore = (a: Rational, b: Rational): boolean => lt(a, b);
