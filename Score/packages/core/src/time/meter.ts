import { type Rational, add, cmp, divInt, eq, lt, mulInt, rat, sub, ZERO } from './rational';

/**
 * A time signature. `groups` optionally gives the beat grouping in units of 1/beatType, e.g.
 * 7/8 as [2, 2, 3]. When absent, a conventional grouping is used.
 */
export interface TimeSignature {
  readonly beats: number;
  readonly beatType: number;
  readonly symbol?: 'common' | 'cut';
  readonly groups?: readonly number[];
}

export const timeSig = (
  beats: number,
  beatType: number,
  extra?: Partial<TimeSignature>,
): TimeSignature => ({
  beats,
  beatType,
  ...extra,
});

/** Nominal bar length in whole notes. */
export function barLength(ts: TimeSignature): Rational {
  return rat(ts.beats, ts.beatType);
}

export function isCompound(ts: TimeSignature): boolean {
  return ts.beats % 3 === 0 && ts.beats > 3 && ts.beatType >= 4;
}

/** Beat groups as lengths (whole notes), in order. Their sum equals the bar length. */
export function beatGroups(ts: TimeSignature): Rational[] {
  const unit = rat(1, ts.beatType);
  if (ts.groups && ts.groups.length > 0) return ts.groups.map((g) => mulInt(unit, g));
  if (isCompound(ts)) return Array.from({ length: ts.beats / 3 }, () => mulInt(unit, 3));
  if (ts.beatType >= 8 && ts.beats % 2 === 1 && ts.beats > 3) {
    // Irregular meters such as 5/8 and 7/8: groups of 2 ending with one 3 (2+3, 2+2+3, ...).
    const groups: number[] = [];
    let left = ts.beats;
    while (left > 3) {
      groups.push(2);
      left -= 2;
    }
    groups.push(left);
    return groups.map((g) => mulInt(unit, g));
  }
  return Array.from({ length: ts.beats }, () => unit);
}

/**
 * Metric hierarchy of a bar as nested boundary lists, strongest first. Level 0 is [0, L].
 * Used to split durations into readable notated values and to place rests.
 */
export function metricLevels(ts: TimeSignature, length: Rational = barLength(ts)): Rational[][] {
  const nominal = barLength(ts);
  if (eq(length, nominal)) return regularLevels(ts, nominal);
  if (lt(length, nominal)) {
    // Pickup / short bar: it is the END of a full bar, so beats align to the barline after it.
    const shift = sub(nominal, length);
    return regularLevels(ts, nominal).map((level) => {
      const out: Rational[] = [ZERO];
      for (const b of level) {
        if (cmp(b, shift) > 0 && lt(b, nominal)) out.push(sub(b, shift));
      }
      out.push(length);
      return out;
    });
  }
  // Long irregular bar (cadenza): beat grid from the start, then binary subdivisions.
  const unit = rat(1, ts.beatType);
  const beats: Rational[] = [];
  for (let pos = ZERO; lt(pos, length); pos = add(pos, unit)) beats.push(pos);
  beats.push(length);
  return [[ZERO, length], beats, ...binaryLevels(beats)];
}

function regularLevels(ts: TimeSignature, length: Rational): Rational[][] {
  const levels: Rational[][] = [[ZERO, length]];
  const groups = beatGroups(ts);
  const groupBoundaries = boundariesFromLengths(groups);
  // Half-bar level for even groupings of 4 beats (4/4, 2/2, 12/8, 4/2 ...).
  if (groups.length === 4 && groups.every((g) => eq(g, groups[0]!))) {
    levels.push([ZERO, divInt(length, 2), length]);
  }
  if (groups.length > 1) levels.push(groupBoundaries);
  // Compound / irregular beat groups first divide into their unit pulses (e.g. 3 eighths).
  let current = groupBoundaries;
  const unit = rat(1, ts.beatType);
  const needsPulse = groups.some((g) => cmp(g, unit) > 0 && !isPowerOfTwoMultiple(g, unit));
  if (needsPulse) {
    current = subdivideEach(current, (span) => Math.round((span.n * ts.beatType) / span.d));
    levels.push(current);
  }
  return [...levels, ...binaryLevels(current)];
}

function isPowerOfTwoMultiple(span: Rational, unit: Rational): boolean {
  const k = (span.n * unit.d) / (span.d * unit.n);
  return Number.isInteger(k) && (k & (k - 1)) === 0;
}

/** Binary subdivisions of the given boundaries down to 1/128 notes. */
function binaryLevels(start: Rational[]): Rational[][] {
  const levels: Rational[][] = [];
  const smallest = rat(1, 128);
  let current = start;
  for (let i = 0; i < 12; i++) {
    const next = subdivideEach(current, () => 2);
    if (lt(minSpan(next), smallest)) break;
    levels.push(next);
    current = next;
  }
  return levels;
}

function boundariesFromLengths(lengths: Rational[]): Rational[] {
  const out: Rational[] = [ZERO];
  let pos = ZERO;
  for (const l of lengths) {
    pos = add(pos, l);
    out.push(pos);
  }
  return out;
}

function subdivideEach(boundaries: Rational[], parts: (span: Rational) => number): Rational[] {
  const out: Rational[] = [boundaries[0]!];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const a = boundaries[i]!;
    const b = boundaries[i + 1]!;
    const span = rat(b.n * a.d - a.n * b.d, a.d * b.d);
    const k = Math.max(1, parts(span));
    for (let j = 1; j <= k; j++) {
      out.push(add(a, rat(span.n * j, span.d * k)));
    }
  }
  return out;
}

function minSpan(boundaries: Rational[]): Rational {
  let m: Rational | null = null;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const a = boundaries[i]!;
    const b = boundaries[i + 1]!;
    const span = rat(b.n * a.d - a.n * b.d, a.d * b.d);
    if (!m || lt(span, m)) m = span;
  }
  return m ?? ZERO;
}

/** Index of the strongest level that contains `pos` as a boundary (0 = bar line). */
export function metricStrength(levels: Rational[][], pos: Rational): number {
  for (let i = 0; i < levels.length; i++) {
    if (levels[i]!.some((b) => eq(b, pos))) return i;
  }
  return levels.length;
}

/** Earliest boundary strictly inside (s, e) at the strongest level that has one, or null. */
export function strongestBoundaryInside(
  levels: Rational[][],
  s: Rational,
  e: Rational,
): Rational | null {
  for (const level of levels) {
    for (const b of level) {
      if (cmp(b, s) > 0 && cmp(b, e) < 0) return b;
    }
  }
  return null;
}

/** True if [s, e) is exactly one span of some metric level. */
export function isMetricSpan(levels: Rational[][], s: Rational, e: Rational): boolean {
  for (const level of levels) {
    for (let i = 0; i + 1 < level.length; i++) {
      if (eq(level[i]!, s) && eq(level[i + 1]!, e)) return true;
    }
  }
  return false;
}

/**
 * Beam grouping for a bar: boundaries that beams must not cross, for notes of the given beam
 * level (1 = eighths, 2 = sixteenths, ...). Conventional defaults:
 * - simple meters: eighths by half-bar in 4/4 and by bar in 2/4 and x/8, otherwise by beat;
 *   sixteenths and shorter by beat;
 * - compound and irregular meters: by beat group.
 */
export function beamBoundaries(
  ts: TimeSignature,
  beamLevel: number,
  length: Rational = barLength(ts),
): Rational[] {
  const nominal = barLength(ts);
  if (!eq(length, nominal)) return [ZERO, length];
  const groups = beatGroups(ts);
  const byGroups = boundariesFromLengths(groups);
  if (isCompound(ts) || ts.groups || (ts.beatType >= 8 && ts.beats % 2 === 1 && ts.beats > 3)) {
    return byGroups;
  }
  if (beamLevel <= 1) {
    if (ts.beats === 4 && ts.beatType === 4) return [ZERO, rat(1, 2), length];
    if ((ts.beats === 2 && ts.beatType === 4) || ts.beatType >= 8) return [ZERO, length];
    if (ts.beatType === 2) return byGroups;
    return byGroups;
  }
  if (ts.beatType === 2) {
    // sixteenths in 2/2 or 3/2: beam per quarter
    return boundariesFromLengths(Array.from({ length: ts.beats * 2 }, () => rat(1, 4)));
  }
  if (ts.beatType >= 8) return [ZERO, length];
  return byGroups;
}
