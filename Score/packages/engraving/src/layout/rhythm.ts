/**
 * Splitting durations into notated values according to the metric hierarchy.
 *
 * Notes: one written value is kept when it is notatable (dyadic, up to two dots) and either starts
 * on a beat or does not cross a "major" boundary (the half bar in 4/4, every beat in compound
 * meters). Otherwise the span is split at the strongest boundary inside it, recursively.
 * Rests are stricter: a single rest must fill exactly one span of some metric level.
 */
import {
  type Rational,
  type TimeSignature,
  type WrittenDuration,
  add,
  beatGroups,
  cmp,
  div,
  eq,
  isMetricSpan,
  longestValueWithin,
  metricLevels,
  metricStrength,
  mul,
  rat,
  strongestBoundaryInside,
  sub,
  writtenFromLength,
  ZERO,
} from '@cantelvio-score/core';

/** A metric frame: a bar, or a tuplet span inside a bar. Positions are relative to `start`. */
export interface Frame {
  /** Offset of the frame within the measure (actual time). */
  readonly start: Rational;
  readonly end: Rational;
  /** Written length per actual length (actual/normal for tuplets, 1 otherwise). */
  readonly scale: Rational;
  /** Metric levels in WRITTEN time relative to the frame start. */
  readonly levels: Rational[][];
  readonly beatLevel: number;
  readonly majorLevel: number;
}

export function measureFrame(ts: TimeSignature, length: Rational): Frame {
  const levels = metricLevels(ts, length);
  const groups = beatGroups(ts);
  let beatLevel = 0;
  let majorLevel = 0;
  // Find the level whose boundaries are the beat-group boundaries.
  let pos = ZERO;
  const beatBounds = [ZERO, ...groups.map((g) => (pos = add(pos, g)))];
  levels.forEach((level, i) => {
    if (level.length === beatBounds.length && level.every((b, k) => eq(b, beatBounds[k]!)))
      beatLevel = i;
  });
  if (beatLevel === 0 && levels.length > 1) beatLevel = 1;
  const compound = ts.beats % 3 === 0 && ts.beats > 3 && ts.beatType >= 4;
  const hasHalfBar = levels.length > 2 && levels[1]!.length === 3 && beatLevel === 2;
  if (hasHalfBar) majorLevel = 1;
  else if (compound || ts.groups || (ts.beatType >= 8 && ts.beats % 2 === 1 && ts.beats > 3))
    majorLevel = beatLevel;
  return { start: ZERO, end: length, scale: rat(1), levels, beatLevel, majorLevel };
}

export function tupletFrame(
  offset: Rational,
  length: Rational,
  actual: number,
  normal: number,
): Frame {
  const scale = rat(actual, normal);
  const written = mul(length, scale);
  const unit = div(written, rat(actual));
  const pulses: Rational[] = [];
  for (let k = 0; k <= actual; k++) pulses.push(mul(unit, rat(k)));
  const levels: Rational[][] = [[ZERO, written], pulses];
  let current = pulses;
  for (let i = 0; i < 6; i++) {
    const next: Rational[] = [current[0]!];
    for (let k = 0; k + 1 < current.length; k++) {
      const a = current[k]!;
      const b = current[k + 1]!;
      next.push(add(a, div(sub(b, a), rat(2))), b);
    }
    levels.push(next);
    current = next;
  }
  return { start: offset, end: add(offset, length), scale, levels, beatLevel: 1, majorLevel: 0 };
}

export interface Piece {
  /** Actual offsets within the measure. */
  readonly start: Rational;
  readonly end: Rational;
  readonly written: WrittenDuration;
  /** True when the length could not be written exactly and was approximated. */
  readonly approx: boolean;
}

function toWritten(frame: Frame, t: Rational): Rational {
  return mul(sub(t, frame.start), frame.scale);
}

function toActual(frame: Frame, w: Rational): Rational {
  return add(frame.start, div(w, frame.scale));
}

function approximate(length: Rational): WrittenDuration {
  const value = longestValueWithin(length) ?? '128th';
  return { value, dots: 0 };
}

export function splitNote(frame: Frame, s: Rational, e: Rational): Piece[] {
  return split(frame, toWritten(frame, s), toWritten(frame, e), 'note').map((p) => ({
    ...p,
    start: toActual(frame, p.start),
    end: toActual(frame, p.end),
  }));
}

export function splitRest(frame: Frame, s: Rational, e: Rational): Piece[] {
  return split(frame, toWritten(frame, s), toWritten(frame, e), 'rest').map((p) => ({
    ...p,
    start: toActual(frame, p.start),
    end: toActual(frame, p.end),
  }));
}

function split(frame: Frame, s: Rational, e: Rational, kind: 'note' | 'rest', depth = 0): Piece[] {
  const length = sub(e, s);
  if (length.n <= 0) return [];
  const written = writtenFromLength(length, kind === 'rest' ? 1 : 2);
  const single =
    written !== null &&
    (kind === 'note' ? noteAllowed(frame, s, e, written) : restAllowed(frame, s, e, written));
  if (single) return [{ start: s, end: e, written: written!, approx: false }];
  const b = depth < 24 ? strongestBoundaryInside(frame.levels, s, e) : null;
  if (!b) {
    return [
      { start: s, end: e, written: written ?? approximate(length), approx: written === null },
    ];
  }
  return [...split(frame, s, b, kind, depth + 1), ...split(frame, b, e, kind, depth + 1)];
}

function crosses(frame: Frame, maxLevel: number, s: Rational, e: Rational): boolean {
  for (let i = 0; i <= maxLevel && i < frame.levels.length; i++) {
    for (const b of frame.levels[i]!) if (cmp(b, s) > 0 && cmp(b, e) < 0) return true;
  }
  return false;
}

/** The span of `level` that contains position s. */
function spanAt(frame: Frame, level: number, s: Rational): Rational {
  const bounds = frame.levels[level] ?? frame.levels[0]!;
  for (let i = 0; i + 1 < bounds.length; i++) {
    if (cmp(bounds[i]!, s) <= 0 && cmp(s, bounds[i + 1]!) < 0)
      return sub(bounds[i + 1]!, bounds[i]!);
  }
  return sub(bounds[bounds.length - 1]!, bounds[0]!);
}

function noteAllowed(frame: Frame, s: Rational, e: Rational, written: WrittenDuration): boolean {
  if (!crosses(frame, frame.majorLevel, s, e)) return true;
  const strength = metricStrength(frame.levels, s);
  if (strength <= frame.majorLevel) return true;
  // A weak beat may start a syncopated note of at most one major span (half note on beat 2 of 4/4).
  if (strength <= frame.beatLevel)
    return written.dots === 0 && cmp(sub(e, s), spanAt(frame, frame.majorLevel, s)) <= 0;
  return false;
}

function restAllowed(frame: Frame, s: Rational, e: Rational, written: WrittenDuration): boolean {
  if (isMetricSpan(frame.levels, s, e)) return true;
  // An undotted rest starting on a beat and staying inside that beat (quarter rest in 6/8).
  return (
    written.dots === 0 &&
    metricStrength(frame.levels, s) <= frame.beatLevel &&
    !crosses(frame, frame.beatLevel, s, e)
  );
}
