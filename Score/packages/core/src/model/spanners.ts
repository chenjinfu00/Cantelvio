/**
 * Spanner queries: anchors <-> absolute time, the octave shift in force at a time, ordering.
 * Time spanners cover [start, end); slurs are anchored to their first and last events.
 */
import { type Rational, add, cmp, eq, le, lt, sub, ZERO } from '../time/rational';
import { allStaves, findEvent, hasMeasure, hasStaff, measureInfo, measureInfos } from './query';
import type { ID, MeasureAnchor, ScoreDoc, Spanner, TimeSpan } from './types';

export function anchorTime(doc: ScoreDoc, a: MeasureAnchor): Rational {
  return add(measureInfo(doc, a.measureId).start, a.offset);
}

/** Anchor of a start position: the measure containing t (a barline belongs to the next bar). */
export function startAnchor(doc: ScoreDoc, t: Rational): MeasureAnchor | null {
  const infos = measureInfos(doc);
  let lo = 0;
  let hi = infos.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const info = infos[mid]!;
    if (lt(t, info.start)) hi = mid - 1;
    else if (cmp(t, add(info.start, info.length)) >= 0) lo = mid + 1;
    else return { measureId: info.measure.id, offset: sub(t, info.start) };
  }
  return null;
}

/** Anchor of an end position: the measure containing the moment just before t. */
export function endAnchor(doc: ScoreDoc, t: Rational): MeasureAnchor | null {
  const infos = measureInfos(doc);
  let lo = 0;
  let hi = infos.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const info = infos[mid]!;
    if (le(t, info.start)) hi = mid - 1;
    else if (cmp(t, add(info.start, info.length)) > 0) lo = mid + 1;
    else return { measureId: info.measure.id, offset: sub(t, info.start) };
  }
  return null;
}

/** An end anchor at a barline is stored in the bar before it (offset = that bar's length). */
export function normalizeEndAnchor(doc: ScoreDoc, a: MeasureAnchor): MeasureAnchor {
  if (a.offset.n !== 0 || !hasMeasure(doc, a.measureId)) return a;
  const info = measureInfo(doc, a.measureId);
  if (info.index === 0) return a;
  const prev = measureInfos(doc)[info.index - 1]!;
  return { measureId: prev.measure.id, offset: prev.length };
}

/** Absolute time range; slurs run from their first event's start to their last event's end. */
export function spannerTimes(
  doc: ScoreDoc,
  s: Spanner,
): { readonly start: Rational; readonly end: Rational } | null {
  if (s.kind === 'slur') {
    const a = findEvent(doc, s.from);
    const b = findEvent(doc, s.to);
    return a && b ? { start: a.start, end: b.end } : null;
  }
  if (!hasMeasure(doc, s.start.measureId) || !hasMeasure(doc, s.end.measureId)) return null;
  return { start: anchorTime(doc, s.start), end: anchorTime(doc, s.end) };
}

export function timeSpansOf(doc: ScoreDoc, staffId: ID, kind?: TimeSpan['kind']): TimeSpan[] {
  return doc.spanners.filter(
    (s): s is TimeSpan => s.kind !== 'slur' && s.staffId === staffId && (!kind || s.kind === kind),
  );
}

export interface OttavaRange {
  readonly start: Rational;
  readonly end: Rational;
  /** 8va = 1, 15ma = 2, 8vb = −1, 15mb = −2. */
  readonly octaves: number;
}

/** Octave lines of a staff as absolute ranges, in time order. */
export function ottavaRanges(doc: ScoreDoc, staffId: ID): OttavaRange[] {
  const out: OttavaRange[] = [];
  for (const s of doc.spanners) {
    if (s.kind !== 'ottava' || s.staffId !== staffId) continue;
    const t = spannerTimes(doc, s);
    if (t) out.push({ ...t, octaves: s.octaves });
  }
  return out.sort((a, b) => cmp(a.start, b.start));
}

/** Octave shift of the octave line covering time t on a staff (0 = none). */
export function ottavaAt(doc: ScoreDoc, staffId: ID, t: Rational): number {
  for (const r of ottavaRanges(doc, staffId)) if (le(r.start, t) && lt(t, r.end)) return r.octaves;
  return 0;
}

/** Canonical order of `doc.spanners`: score order of the staff, then start time, then id. */
export function compareSpanners(doc: ScoreDoc): (a: Spanner, b: Spanner) => number {
  const staffOrder = new Map(allStaves(doc).map((s, i) => [s.staff.id, i]));
  const startOf = (s: Spanner): Rational | null => spannerTimes(doc, s)?.start ?? null;
  return (a, b) => {
    const sa = staffOrder.get(a.staffId) ?? Infinity;
    const sb = staffOrder.get(b.staffId) ?? Infinity;
    if (sa !== sb) return sa - sb;
    const ta = startOf(a);
    const tb = startOf(b);
    if (ta && tb && !eq(ta, tb)) return cmp(ta, tb);
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** A measure anchor with a well-formed time (hand-edited files and AI patches may lack one). */
function isAnchor(a: unknown): a is MeasureAnchor {
  const x = a as Partial<MeasureAnchor> | null | undefined;
  const o = x?.offset as Partial<Rational> | undefined;
  return (
    typeof x?.measureId === 'string' &&
    Number.isSafeInteger(o?.n) &&
    Number.isSafeInteger(o?.d) &&
    o!.d! > 0
  );
}

/**
 * Why a spanner is not valid in this document, or null. Commands refuse invalid spanners;
 * `validateScore` reports them in files.
 */
export function spannerProblem(doc: ScoreDoc, s: Spanner): string | null {
  if (!['slur', 'hairpin', 'ottava', 'pedal', 'trill'].includes(s.kind))
    return `unknown spanner kind ${String((s as { kind?: unknown }).kind)}`;
  if (!hasStaff(doc, s.staffId)) return `unknown staff ${s.staffId}`;
  if (s.kind === 'slur') {
    const a = findEvent(doc, s.from);
    const b = findEvent(doc, s.to);
    if (!a || !b) return 'slur endpoint is not an event';
    if (a.staffId !== s.staffId || b.staffId !== s.staffId)
      return 'slur endpoints are on another staff';
    if (a.voice !== b.voice) return 'slur endpoints are in different voices';
    if (!lt(a.start, b.start)) return 'a slur must end on a later event';
    if (s.placement !== undefined && s.placement !== 'above' && s.placement !== 'below')
      return 'invalid slur placement';
    return null;
  }
  for (const [name, a] of [
    ['start', s.start],
    ['end', s.end],
  ] as const) {
    if (!isAnchor(a)) return `${name}: missing or malformed anchor`;
    if (!hasMeasure(doc, a.measureId)) return `${name}: unknown measure ${a.measureId}`;
    const len = measureInfo(doc, a.measureId).length;
    if (lt(a.offset, ZERO) || cmp(a.offset, len) > 0) return `${name}: offset outside the measure`;
  }
  if (cmp(s.start.offset, measureInfo(doc, s.start.measureId).length) >= 0)
    return 'start: offset at the end of the measure';
  if (!lt(anchorTime(doc, s.start), anchorTime(doc, s.end))) return 'end must be after start';
  if (s.kind === 'hairpin' && s.direction !== 'crescendo' && s.direction !== 'diminuendo')
    return 'invalid hairpin direction';
  if (s.kind === 'ottava' && ![-2, -1, 1, 2].includes(s.octaves)) return 'octaves must be ±1 or ±2';
  if (s.kind === 'pedal' && s.style !== undefined && s.style !== 'line')
    return 'invalid pedal style';
  return null;
}

/** Octave lines of the staff that overlap the given one (by time). */
export function overlappingOttavas(doc: ScoreDoc, s: Spanner): Spanner[] {
  if (s.kind !== 'ottava') return [];
  const t = spannerTimes(doc, s);
  if (!t) return [];
  return doc.spanners.filter((o) => {
    if (o.kind !== 'ottava' || o.staffId !== s.staffId || o.id === s.id) return false;
    const ot = spannerTimes(doc, o);
    return !!ot && lt(ot.start, t.end) && lt(t.start, ot.end);
  });
}
