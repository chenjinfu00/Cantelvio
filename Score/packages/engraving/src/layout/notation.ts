/**
 * Logical notation: turns the semantic model of one staff into notated items per measure —
 * written durations, ties across barlines, implicit rests, beam groups, stem directions,
 * accidentals and display (written) pitches. No geometry here.
 */
import {
  type Arpeggio,
  type Articulation,
  type Breath,
  type ClefType,
  type DynamicMark,
  type Interval,
  type KeySignature,
  type LocatedEvent,
  type MeasureInfo,
  type NoteValue,
  type Ornament,
  type Pitch,
  type Rational,
  type ScoreDoc,
  type StaffInfo,
  type TimeSignature,
  type TupletSpan,
  type WrittenDuration,
  NOTE_VALUE_BEAMS,
  add,
  beamBoundaries,
  clefAt,
  cmp,
  diatonicOf,
  eq,
  findInstrument,
  interval,
  invertInterval,
  isUnison,
  le,
  lt,
  max,
  measureInfos,
  midiOf,
  min,
  ottavaRanges,
  staffPosition,
  sub,
  transpose,
  transposeKey,
  voiceTimeline,
  ZERO,
  keyAlter,
} from '@cantelvio-score/core';
import { type Frame, measureFrame, splitNote, splitRest, tupletFrame } from './rhythm';

export type AccidentalKind = 'flat' | 'natural' | 'sharp' | 'doubleSharp' | 'doubleFlat';

export interface NNote {
  readonly noteId: string;
  readonly concert: Pitch;
  /** Pitch as displayed (written pitch for transposing instruments in a transposed score). */
  readonly display: Pitch;
  /** Staff position: 0 = top line, 8 = bottom line of a 5-line staff. */
  readonly position: number;
  accidental: AccidentalKind | null;
  cautionary: boolean;
  /** This piece ties into the next piece of the same note (split or explicit tie). */
  tieToNext: boolean;
  /** This piece continues a tie from the previous piece. */
  tiedFromPrev: boolean;
}

/** A grace note (chord) drawn small before its principal chord. */
export interface NGrace {
  readonly graceId: string;
  readonly slash: boolean;
  readonly value: NoteValue;
  readonly notes: NNote[];
}

export interface NChord {
  readonly kind: 'chord';
  /** Unique within the score: eventId or eventId#piece. */
  readonly key: string;
  readonly eventId: string;
  readonly voice: number;
  readonly offset: Rational;
  readonly length: Rational;
  readonly written: WrittenDuration;
  readonly approx: boolean;
  readonly tuplet: TupletSpan | null;
  readonly notes: NNote[];
  readonly articulations: readonly Articulation[];
  /** Marks of the event: ornaments and arpeggios on its first piece, breath after its last. */
  readonly ornament: Ornament | null;
  readonly tremolo: number;
  readonly arpeggio: Arpeggio | null;
  readonly breath: Breath | null;
  /** Cue-size (small) notes. */
  readonly cue: boolean;
  /** Grace notes before the chord (first piece only), in playing order. */
  readonly graces: readonly NGrace[];
  /** Octave line shift of the displayed notes (8va = 1). */
  readonly ottava: number;
  stem: 'up' | 'down';
  readonly stemForced: boolean;
  /** Beam group id (unique within the measure) or null when unbeamed. */
  beam: number | null;
  readonly ghost: boolean;
  readonly firstPiece: boolean;
}

export interface NRest {
  readonly kind: 'rest';
  readonly key: string;
  readonly voice: number;
  readonly offset: Rational;
  readonly length: Rational;
  readonly written: WrittenDuration;
  readonly approx: boolean;
  readonly tuplet: TupletSpan | null;
  readonly fullMeasure: boolean;
}

export type NItem = NChord | NRest;

export interface NVoice {
  readonly voice: number;
  readonly items: NItem[];
}

export interface NMeasure {
  readonly staffId: string;
  readonly measureId: string;
  readonly index: number;
  readonly start: Rational;
  readonly length: Rational;
  readonly timeSig: TimeSignature;
  readonly key: KeySignature;
  readonly clef: ClefType;
  /** Clef changes inside the measure (offset > 0). */
  readonly clefChanges: readonly { offset: Rational; clef: ClefType }[];
  readonly voices: NVoice[];
  readonly multiVoice: boolean;
  readonly dynamics: readonly DynamicMark[];
  readonly tuplets: readonly TupletSpan[];
}

/** Interval to apply to concert pitch for display on this staff. */
export function displayInterval(staff: StaffInfo, concertPitch: boolean): Interval {
  const t = staff.part.transposition ?? findInstrument(staff.part.instrument)?.transposition;
  if (!t || isUnison(t)) return interval(0, 0);
  const octaveOnly = t.chromatic % 12 === 0 && t.diatonic % 7 === 0;
  if (concertPitch && !octaveOnly) return interval(0, 0);
  // written = sounding - transposition
  return invertInterval(t);
}

const ACCIDENTAL_FOR_ALTER: Record<number, AccidentalKind> = {
  [-2]: 'doubleFlat',
  [-1]: 'flat',
  0: 'natural',
  1: 'sharp',
  2: 'doubleSharp',
};

export interface NotationOptions {
  readonly concertPitch: boolean;
  readonly ghostEvents?: ReadonlySet<string>;
}

export function buildStaffNotation(
  doc: ScoreDoc,
  staff: StaffInfo,
  opts: NotationOptions,
): NMeasure[] {
  const infos = measureInfos(doc);
  const staffId = staff.staff.id;
  const disp = displayInterval(staff, opts.concertPitch);
  const shift = (p: Pitch) => (isUnison(disp) ? p : transpose(p, disp));
  // octave lines move the written notes down (8va) or up (8vb)
  const ottavas = ottavaRanges(doc, staffId);
  const ottavaAt = (t: Rational) =>
    ottavas.find((o) => le(o.start, t) && lt(t, o.end))?.octaves ?? 0;
  const timelines = [0, 1, 2, 3].map((v) => voiceTimeline(doc, staffId, v));
  const cursors = [0, 0, 0, 0];
  // Explicit ties waiting for the next event of a voice: midi numbers.
  const pendingTies: Set<number>[] = [new Set(), new Set(), new Set(), new Set()];

  return infos.map((info) => {
    const sm = doc.content[staffId]?.[info.measure.id];
    const clef = clefAt(doc, staffId, info.index, ZERO);
    const clefChanges = (sm?.clefChanges ?? [])
      .filter((c) => c.offset.n > 0)
      .map((c) => ({ offset: c.offset, clef: c.clef }));
    const key = isUnison(disp) ? info.keySig : transposeKey(info.keySig, disp);
    const tuplets = sm?.tuplets ?? [];
    const measureEnd = add(info.start, info.length);
    const voiceEvents: LocatedEvent[][] = [0, 1, 2, 3].map((v) => {
      const list = timelines[v]!;
      // advance past events that ended before this measure
      while (cursors[v]! < list.length && le(list[cursors[v]!]!.end, info.start)) cursors[v]!++;
      const out: LocatedEvent[] = [];
      for (let k = cursors[v]!; k < list.length; k++) {
        const e = list[k]!;
        if (cmp(e.start, measureEnd) >= 0) break;
        if (lt(info.start, e.end)) out.push(e);
      }
      return out;
    });
    const used = voiceEvents.map((evs, v) => evs.length > 0 || tuplets.some((t) => t.voice === v));
    const multiVoice = used.filter(Boolean).length > 1 || used.slice(1).some(Boolean);
    const voices: NVoice[] = [];
    let beamCounter = 0;
    for (let v = 0; v < 4; v++) {
      if (v > 0 && !used[v]) continue;
      const items = buildVoice(
        info,
        v,
        voiceEvents[v]!,
        tuplets.filter((t) => t.voice === v),
        shift,
        ottavaAt,
        clef,
        pendingTies[v]!,
        opts,
        staffId,
      );
      beamCounter = assignBeams(items, info, beamCounter);
      voices.push({ voice: v, items });
    }
    for (const nv of voices) assignStems(nv, multiVoice);
    assignAccidentals(voices, key);
    return {
      staffId,
      measureId: info.measure.id,
      index: info.index,
      start: info.start,
      length: info.length,
      timeSig: info.timeSig,
      key,
      clef,
      clefChanges,
      voices,
      multiVoice,
      dynamics: sm?.dynamics ?? [],
      tuplets,
    };
  });
}

function frameAt(tuplets: readonly TupletSpan[], t: Rational, measureFrameCache: Frame): Frame {
  for (const tu of tuplets) {
    if (le(tu.offset, t) && lt(t, add(tu.offset, tu.length)))
      return tupletFrame(tu.offset, tu.length, tu.actual, tu.normal);
  }
  return measureFrameCache;
}

/** Split [s, e) at tuplet boundaries so each sub-span lies in one frame. */
function frameSpans(
  tuplets: readonly TupletSpan[],
  s: Rational,
  e: Rational,
  mf: Frame,
): { s: Rational; e: Rational; frame: Frame; tuplet: TupletSpan | null }[] {
  const cuts = [s, e];
  for (const t of tuplets) {
    const ts = t.offset;
    const te = add(t.offset, t.length);
    if (lt(s, ts) && lt(ts, e)) cuts.push(ts);
    if (lt(s, te) && lt(te, e)) cuts.push(te);
  }
  cuts.sort(cmp);
  const out: { s: Rational; e: Rational; frame: Frame; tuplet: TupletSpan | null }[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    if (!lt(a, b)) continue;
    const tuplet = tuplets.find((t) => le(t.offset, a) && lt(a, add(t.offset, t.length))) ?? null;
    out.push({ s: a, e: b, frame: frameAt(tuplets, a, mf), tuplet });
  }
  return out;
}

function buildVoice(
  info: MeasureInfo,
  voice: number,
  events: readonly LocatedEvent[],
  tuplets: readonly TupletSpan[],
  shift: (p: Pitch) => Pitch,
  ottavaAt: (t: Rational) => number,
  clef: ClefType,
  pendingTies: Set<number>,
  opts: NotationOptions,
  staffId: string,
): NItem[] {
  const mf = measureFrame(info.timeSig, info.length);
  const items: NItem[] = [];
  const restKey = (offset: Rational) =>
    `rest:${staffId}:${info.measure.id}:${voice}:${offset.n}/${offset.d}`;
  if (events.length === 0 && voice === 0 && tuplets.length === 0) {
    items.push({
      kind: 'rest',
      key: restKey(ZERO),
      voice,
      offset: ZERO,
      length: info.length,
      written: { value: 'whole', dots: 0 },
      approx: false,
      tuplet: null,
      fullMeasure: true,
    });
    return items;
  }
  const fillRests = (from: Rational, to: Rational) => {
    for (const span of frameSpans(tuplets, from, to, mf)) {
      for (const p of splitRest(span.frame, span.s, span.e)) {
        items.push({
          kind: 'rest',
          key: restKey(p.start),
          voice,
          offset: p.start,
          length: sub(p.end, p.start),
          written: p.written,
          approx: p.approx,
          tuplet: span.tuplet,
          fullMeasure: false,
        });
      }
    }
  };
  let cursor = ZERO;
  for (const e of events) {
    const s = max(sub(e.start, info.start), ZERO);
    const end = min(sub(e.end, info.start), info.length);
    if (lt(cursor, s)) fillRests(cursor, s);
    const startsHere = !lt(e.start, info.start);
    const endsHere = le(e.end, add(info.start, info.length));
    const tiedIn = startsHere
      ? new Set([...pendingTies].filter((m) => e.event.notes.some((n) => midiOf(n.pitch) === m)))
      : null;
    const spans = frameSpans(tuplets, s, end, mf);
    const pieces = spans.flatMap((span) =>
      splitNote(span.frame, span.s, span.e).map((p) => ({ ...p, tuplet: span.tuplet })),
    );
    const octaves = ottavaAt(e.start);
    const displayOf = (p: Pitch) => {
      const d = shift(p);
      return octaves ? { ...d, octave: d.octave - octaves } : d;
    };
    const graces: NGrace[] = (startsHere ? (e.event.graces ?? []) : []).map((g) => ({
      graceId: g.id,
      slash: !!g.slash,
      value: g.value,
      notes: g.notes.map((n) => {
        const display = displayOf(n.pitch);
        return {
          noteId: n.id,
          concert: n.pitch,
          display,
          position: staffPosition(display, clef),
          accidental: null,
          cautionary: false,
          tieToNext: false,
          tiedFromPrev: false,
        };
      }),
    }));
    pieces.forEach((p, k) => {
      const first = k === 0;
      const last = k === pieces.length - 1;
      const notes: NNote[] = e.event.notes.map((n) => {
        const display = displayOf(n.pitch);
        const midi = midiOf(n.pitch);
        return {
          noteId: n.id,
          concert: n.pitch,
          display,
          position: staffPosition(display, clef),
          accidental: null,
          cautionary: false,
          tieToNext: !last || !endsHere || (!!n.tieForward && endsHere),
          tiedFromPrev: !first || !startsHere || (first && startsHere && !!tiedIn?.has(midi)),
        };
      });
      const head = first && startsHere;
      items.push({
        kind: 'chord',
        key: pieces.length === 1 && startsHere ? e.event.id : `${e.event.id}#${info.index}.${k}`,
        eventId: e.event.id,
        voice,
        offset: p.start,
        length: sub(p.end, p.start),
        written: p.written,
        approx: p.approx,
        tuplet: p.tuplet,
        notes,
        articulations: head ? (e.event.articulations ?? []) : [],
        ornament: head ? (e.event.ornament ?? null) : null,
        tremolo: e.event.tremolo ?? 0,
        arpeggio: head ? (e.event.arpeggio ?? null) : null,
        breath: last && endsHere ? (e.event.breath ?? null) : null,
        cue: !!e.event.cue,
        graces: head ? graces : [],
        ottava: octaves,
        stem: e.event.stem ?? 'up',
        stemForced: !!e.event.stem,
        beam: null,
        ghost:
          !!opts.ghostEvents?.has(e.event.id) ||
          (e.event.source?.kind === 'ai' && !e.event.source.accepted),
        firstPiece: first && startsHere,
      });
    });
    if (endsHere) {
      pendingTies.clear();
      for (const n of e.event.notes) if (n.tieForward) pendingTies.add(midiOf(n.pitch));
    }
    cursor = end;
  }
  if (lt(cursor, info.length)) fillRests(cursor, info.length);
  return items;
}

/** Group beamable chords; returns the next free beam id. */
function assignBeams(items: NItem[], info: MeasureInfo, nextId: number): number {
  const eighthBounds = beamBoundaries(info.timeSig, 1, info.length);
  const sixteenthBounds = beamBoundaries(info.timeSig, 2, info.length);
  const crossesAny = (bounds: Rational[], a: Rational, b: Rational) =>
    bounds.some((x) => lt(a, x) && le(x, b));
  let run: NChord[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const has16 = run.some((c) => NOTE_VALUE_BEAMS[c.written.value] >= 2);
      if (has16 && !run[0]!.tuplet) {
        // split the run at sixteenth-level boundaries
        let sub: NChord[] = [];
        for (const c of run) {
          if (sub.length && crossesAny(sixteenthBounds, sub[sub.length - 1]!.offset, c.offset)) {
            if (sub.length >= 2) {
              for (const x of sub) x.beam = nextId;
              nextId++;
            }
            sub = [];
          }
          sub.push(c);
        }
        if (sub.length >= 2) {
          for (const x of sub) x.beam = nextId;
          nextId++;
        }
      } else {
        for (const c of run) c.beam = nextId;
        nextId++;
      }
    }
    run = [];
  };
  for (const item of items) {
    const beamable = item.kind === 'chord' && NOTE_VALUE_BEAMS[item.written.value] >= 1;
    if (!beamable) {
      flush();
      continue;
    }
    const prev = run[run.length - 1];
    if (prev) {
      const sameTuplet = (prev.tuplet?.id ?? null) === (item.tuplet?.id ?? null);
      const contiguous = eq(add(prev.offset, prev.length), item.offset);
      if (
        !sameTuplet ||
        !contiguous ||
        (!item.tuplet && crossesAny(eighthBounds, prev.offset, item.offset))
      )
        flush();
    }
    run.push(item);
  }
  flush();
  return nextId;
}

function assignStems(voice: NVoice, multiVoice: boolean): void {
  const chords = voice.items.filter((i): i is NChord => i.kind === 'chord');
  if (multiVoice) {
    const dir = voice.voice % 2 === 0 ? 'up' : 'down';
    for (const c of chords) if (!c.stemForced) c.stem = dir;
    return;
  }
  const groups = new Map<number, NChord[]>();
  for (const c of chords) {
    if (c.beam === null) {
      if (!c.stemForced) c.stem = directionFor([c]);
    } else {
      const g = groups.get(c.beam) ?? [];
      g.push(c);
      groups.set(c.beam, g);
    }
  }
  for (const g of groups.values()) {
    const forced = g.find((c) => c.stemForced);
    const dir = forced ? forced.stem : directionFor(g);
    for (const c of g) c.stem = dir;
  }
}

function directionFor(chords: readonly NChord[]): 'up' | 'down' {
  let above = 0; // how far the highest note is above the middle line
  let below = 0;
  for (const c of chords) {
    for (const n of c.notes) {
      above = Math.max(above, 4 - n.position);
      below = Math.max(below, n.position - 4);
    }
  }
  return below > above ? 'up' : 'down';
}

function assignAccidentals(voices: NVoice[], key: KeySignature): void {
  // grace notes come before the notes at the same offset (order: graces in playing order)
  const entries: { offset: Rational; order: number; voice: number; note: NNote }[] = [];
  for (const v of voices) {
    for (const item of v.items) {
      if (item.kind !== 'chord') continue;
      item.graces.forEach((g, k) => {
        for (const note of g.notes)
          entries.push({ offset: item.offset, order: k, voice: v.voice, note });
      });
      for (const note of item.notes)
        entries.push({ offset: item.offset, order: 1000, voice: v.voice, note });
    }
  }
  entries.sort((a, b) => cmp(a.offset, b.offset) || a.order - b.order || a.voice - b.voice);
  const state = new Map<number, number>();
  const current = (p: Pitch) => state.get(diatonicOf(p)) ?? keyAlter(key.fifths, p.step);
  for (const { note } of entries) {
    const p = note.display;
    if (note.tiedFromPrev) continue;
    if (current(p) !== p.alter) {
      note.accidental = ACCIDENTAL_FOR_ALTER[p.alter] ?? null;
      state.set(diatonicOf(p), p.alter);
    }
  }
}
