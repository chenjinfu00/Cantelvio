/**
 * Read-only queries over a ScoreDoc. Results that are expensive to compute are cached per
 * immutable sub-object (documents are never mutated in place), so repeated queries during
 * layout or input handling are cheap.
 */
import { type KeySignature } from '../pitch/pitch';
import { type TimeSignature, barLength } from '../time/meter';
import { type Rational, add, cmp, lt, sub, ZERO } from '../time/rational';
import { type ClefType } from './clef';
import type {
  ID,
  Measure,
  NoteEvent,
  Part,
  ScoreDoc,
  Staff,
  StaffMeasure,
  TupletSpan,
  VoiceEvent,
} from './types';

function cached<K extends object, V>(cache: WeakMap<K, V>, key: K, compute: () => V): V {
  let v = cache.get(key);
  if (v === undefined) {
    v = compute();
    cache.set(key, v);
  }
  return v;
}

// ------------------------------------------------------------------------------- measures

export interface MeasureInfo {
  readonly index: number;
  readonly measure: Measure;
  readonly start: Rational;
  readonly length: Rational;
  readonly timeSig: TimeSignature;
  readonly keySig: KeySignature;
  /** Time signature shown at this measure (only where it changes). */
  readonly timeSigChange: boolean;
  readonly keySigChange: boolean;
}

const measureInfoCache = new WeakMap<readonly Measure[], MeasureInfo[]>();

export function measureInfos(doc: ScoreDoc): readonly MeasureInfo[] {
  return cached(measureInfoCache, doc.measures, () => {
    const out: MeasureInfo[] = [];
    let ts: TimeSignature = doc.measures[0]?.timeSig ?? { beats: 4, beatType: 4 };
    let ks: KeySignature = doc.measures[0]?.keySig ?? { fifths: 0 };
    let start = ZERO;
    doc.measures.forEach((m, index) => {
      const tsChange = !!m.timeSig && (index === 0 || !sameTimeSig(m.timeSig, ts));
      const ksChange = !!m.keySig && (index === 0 || m.keySig.fifths !== ks.fifths);
      if (m.timeSig) ts = m.timeSig;
      if (m.keySig) ks = m.keySig;
      const length = m.actualLength ?? barLength(ts);
      out.push({
        index,
        measure: m,
        start,
        length,
        timeSig: ts,
        keySig: ks,
        timeSigChange: tsChange,
        keySigChange: ksChange,
      });
      start = add(start, length);
    });
    return out;
  });
}

function sameTimeSig(a: TimeSignature, b: TimeSignature): boolean {
  return a.beats === b.beats && a.beatType === b.beatType && a.symbol === b.symbol;
}

const measureIndexCache = new WeakMap<readonly Measure[], Map<ID, number>>();

export function measureIndexOf(doc: ScoreDoc, measureId: ID): number {
  const map = cached(
    measureIndexCache,
    doc.measures,
    () => new Map(doc.measures.map((m, i) => [m.id, i])),
  );
  const i = map.get(measureId);
  if (i === undefined) throw new Error(`unknown measure ${measureId}`);
  return i;
}

export function hasMeasure(doc: ScoreDoc, measureId: ID): boolean {
  return cached(
    measureIndexCache,
    doc.measures,
    () => new Map(doc.measures.map((m, i) => [m.id, i])),
  ).has(measureId);
}

export function measureInfo(doc: ScoreDoc, measureId: ID): MeasureInfo {
  return measureInfos(doc)[measureIndexOf(doc, measureId)]!;
}

export function scoreLength(doc: ScoreDoc): Rational {
  const infos = measureInfos(doc);
  const last = infos[infos.length - 1];
  return last ? add(last.start, last.length) : ZERO;
}

export function absoluteTime(doc: ScoreDoc, measureId: ID, offset: Rational): Rational {
  return add(measureInfo(doc, measureId).start, offset);
}

/** Measure containing absolute time t (t at a barline belongs to the following measure). */
export function locate(
  doc: ScoreDoc,
  t: Rational,
): { measureIndex: number; offset: Rational } | null {
  const infos = measureInfos(doc);
  let lo = 0;
  let hi = infos.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const info = infos[mid]!;
    if (lt(t, info.start)) hi = mid - 1;
    else if (cmp(t, add(info.start, info.length)) >= 0) lo = mid + 1;
    else return { measureIndex: mid, offset: sub(t, info.start) };
  }
  return null;
}

// ------------------------------------------------------------------------------- staves

export interface StaffInfo {
  readonly staff: Staff;
  readonly part: Part;
  readonly partIndex: number;
  /** Index of the staff within its part. */
  readonly staffIndex: number;
  /** Index among all staves of the score, top to bottom. */
  readonly globalIndex: number;
}

const staffCache = new WeakMap<readonly Part[], { list: StaffInfo[]; byId: Map<ID, StaffInfo> }>();

function staffTable(doc: ScoreDoc) {
  return cached(staffCache, doc.parts, () => {
    const list: StaffInfo[] = [];
    doc.parts.forEach((part, partIndex) => {
      part.staves.forEach((staff, staffIndex) => {
        list.push({ staff, part, partIndex, staffIndex, globalIndex: list.length });
      });
    });
    return { list, byId: new Map(list.map((s) => [s.staff.id, s])) };
  });
}

export function allStaves(doc: ScoreDoc): readonly StaffInfo[] {
  return staffTable(doc).list;
}

export function staffInfo(doc: ScoreDoc, staffId: ID): StaffInfo {
  const s = staffTable(doc).byId.get(staffId);
  if (!s) throw new Error(`unknown staff ${staffId}`);
  return s;
}

export function hasStaff(doc: ScoreDoc, staffId: ID): boolean {
  return staffTable(doc).byId.has(staffId);
}

export function partOfStaff(doc: ScoreDoc, staffId: ID): Part {
  return staffInfo(doc, staffId).part;
}

// ------------------------------------------------------------------------------- content

const EMPTY_MEASURE: StaffMeasure = { voices: [] };

export function staffMeasure(doc: ScoreDoc, staffId: ID, measureId: ID): StaffMeasure {
  return doc.content[staffId]?.[measureId] ?? EMPTY_MEASURE;
}

export function voiceEvents(
  doc: ScoreDoc,
  staffId: ID,
  measureId: ID,
  voice: number,
): readonly VoiceEvent[] {
  return staffMeasure(doc, staffId, measureId).voices[voice] ?? [];
}

export function tupletsIn(
  doc: ScoreDoc,
  staffId: ID,
  measureId: ID,
  voice: number,
): readonly TupletSpan[] {
  return (staffMeasure(doc, staffId, measureId).tuplets ?? []).filter((t) => t.voice === voice);
}

/** Clef in effect at (measure index, offset) on a staff. */
export function clefAt(
  doc: ScoreDoc,
  staffId: ID,
  measureIndex: number,
  offset: Rational,
): ClefType {
  const staff = staffInfo(doc, staffId).staff;
  for (let i = measureIndex; i >= 0; i--) {
    const m = doc.measures[i]!;
    const changes = doc.content[staffId]?.[m.id]?.clefChanges ?? [];
    let best: ClefType | null = null;
    let bestOffset: Rational | null = null;
    for (const c of changes) {
      if (i === measureIndex && cmp(c.offset, offset) > 0) continue;
      if (!bestOffset || cmp(c.offset, bestOffset) >= 0) {
        best = c.clef;
        bestOffset = c.offset;
      }
    }
    if (best) return best;
  }
  return staff.clef;
}

export interface LocatedEvent {
  readonly staffId: ID;
  readonly measureId: ID;
  readonly measureIndex: number;
  readonly voice: number;
  readonly index: number;
  readonly event: NoteEvent;
  readonly start: Rational;
  readonly end: Rational;
}

/**
 * Events of one voice that overlap [from, to) in absolute time, in time order.
 * Looks back across measures for long events that started earlier.
 */
export function eventsOverlapping(
  doc: ScoreDoc,
  staffId: ID,
  voice: number,
  from: Rational,
  to: Rational,
): LocatedEvent[] {
  const infos = measureInfos(doc);
  const out: LocatedEvent[] = [];
  for (const info of infos) {
    if (cmp(info.start, to) >= 0) break;
    const events = doc.content[staffId]?.[info.measure.id]?.voices[voice];
    if (!events) continue;
    events.forEach((event, index) => {
      const start = add(info.start, event.offset);
      const end = add(start, event.duration);
      if (lt(start, to) && lt(from, end)) {
        out.push({
          staffId,
          measureId: info.measure.id,
          measureIndex: info.index,
          voice,
          index,
          event,
          start,
          end,
        });
      }
    });
  }
  return out;
}

/** All events of a voice in time order (across the whole score). */
export function voiceTimeline(doc: ScoreDoc, staffId: ID, voice: number): LocatedEvent[] {
  return eventsOverlapping(doc, staffId, voice, ZERO, add(scoreLength(doc), { n: 1, d: 1 }));
}

interface EventIndexEntry {
  readonly staffId: ID;
  readonly measureId: ID;
  readonly voice: number;
}

const eventIndexCache = new WeakMap<
  object,
  { events: Map<ID, EventIndexEntry>; notes: Map<ID, ID> }
>();

function eventIndex(doc: ScoreDoc) {
  return cached(eventIndexCache, doc.content, () => {
    const events = new Map<ID, EventIndexEntry>();
    const notes = new Map<ID, ID>();
    for (const [staffId, measures] of Object.entries(doc.content)) {
      for (const [measureId, sm] of Object.entries(measures)) {
        sm.voices.forEach((list, voice) => {
          for (const e of list) {
            events.set(e.id, { staffId, measureId, voice });
            for (const n of e.notes) notes.set(n.id, e.id);
          }
        });
      }
    }
    return { events, notes };
  });
}

export function findEvent(doc: ScoreDoc, eventId: ID): LocatedEvent | null {
  const entry = eventIndex(doc).events.get(eventId);
  if (!entry) return null;
  const events = voiceEvents(doc, entry.staffId, entry.measureId, entry.voice);
  const index = events.findIndex((e) => e.id === eventId);
  if (index < 0) return null;
  const event = events[index]!;
  const info = measureInfo(doc, entry.measureId);
  const start = add(info.start, event.offset);
  return {
    ...entry,
    measureIndex: info.index,
    index,
    event,
    start,
    end: add(start, event.duration),
  };
}

export function findEventOfNote(doc: ScoreDoc, noteId: ID): LocatedEvent | null {
  const eventId = eventIndex(doc).notes.get(noteId);
  return eventId ? findEvent(doc, eventId) : null;
}

/** Concert key at a measure. */
export function keyAt(doc: ScoreDoc, measureIndex: number): KeySignature {
  return measureInfos(doc)[measureIndex]?.keySig ?? { fifths: 0 };
}
