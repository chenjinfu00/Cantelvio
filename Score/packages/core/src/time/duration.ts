import { type Rational, add, cmp, divInt, eq, isDyadic, rat, sub } from './rational';

/** Written (notated) note values, longest first. */
export const NOTE_VALUES = [
  'breve',
  'whole',
  'half',
  'quarter',
  'eighth',
  '16th',
  '32nd',
  '64th',
  '128th',
] as const;
export type NoteValue = (typeof NOTE_VALUES)[number];

/** Length of each undotted value in whole notes. */
export const NOTE_VALUE_LENGTH: Readonly<Record<NoteValue, Rational>> = {
  breve: rat(2),
  whole: rat(1),
  half: rat(1, 2),
  quarter: rat(1, 4),
  eighth: rat(1, 8),
  '16th': rat(1, 16),
  '32nd': rat(1, 32),
  '64th': rat(1, 64),
  '128th': rat(1, 128),
};

/** Number of beams/flags a value carries (eighth = 1). */
export const NOTE_VALUE_BEAMS: Readonly<Record<NoteValue, number>> = {
  breve: 0,
  whole: 0,
  half: 0,
  quarter: 0,
  eighth: 1,
  '16th': 2,
  '32nd': 3,
  '64th': 4,
  '128th': 5,
};

export interface WrittenDuration {
  readonly value: NoteValue;
  readonly dots: number;
}

/** value × (2 − 1/2^dots) */
export function writtenLength(w: WrittenDuration): Rational {
  const base = NOTE_VALUE_LENGTH[w.value];
  // base * (2^(dots+1) - 1) / 2^dots
  const k = 2 ** w.dots;
  return rat(base.n * (2 * k - 1), base.d * k);
}

const MAX_DOTS = 2;

/**
 * The single written value (optionally dotted) that has exactly this length, or null.
 * Only dyadic lengths can be written without a tuplet.
 */
export function writtenFromLength(length: Rational, maxDots = MAX_DOTS): WrittenDuration | null {
  if (length.n <= 0 || !isDyadic(length)) return null;
  for (const value of NOTE_VALUES) {
    for (let dots = 0; dots <= maxDots; dots++) {
      if (eq(writtenLength({ value, dots }), length)) return { value, dots };
    }
  }
  return null;
}

/** The longest undotted value not longer than `length`, or null if length < 1/128. */
export function longestValueWithin(length: Rational): NoteValue | null {
  for (const value of NOTE_VALUES) {
    if (cmp(NOTE_VALUE_LENGTH[value], length) <= 0) return value;
  }
  return null;
}

/**
 * Greedy decomposition of a dyadic length into tied written values (longest first).
 * Used as a fallback when no metric context is available.
 */
export function decomposeGreedy(length: Rational): WrittenDuration[] {
  const out: WrittenDuration[] = [];
  let rest = length;
  let guard = 0;
  while (rest.n > 0 && guard++ < 64) {
    const single = writtenFromLength(rest);
    if (single) {
      out.push(single);
      break;
    }
    const value = longestValueWithin(rest);
    if (!value) break; // shorter than a 128th: cannot be written
    out.push({ value, dots: 0 });
    rest = sub(rest, NOTE_VALUE_LENGTH[value]);
  }
  return out;
}

/** Human readable, e.g. "dotted quarter". For logs and tests. */
export function describeWritten(w: WrittenDuration): string {
  return `${'dotted '.repeat(w.dots)}${w.value}`;
}

/** Convenience: duration in whole notes for a value with dots. */
export function lengthOf(value: NoteValue, dots = 0): Rational {
  return writtenLength({ value, dots });
}

/** Tuplet scaling: actual length of a written value inside an `actual:normal` tuplet. */
export function tupletActual(written: Rational, actual: number, normal: number): Rational {
  return divInt(rat(written.n * normal, written.d), actual);
}

export function addAll(values: readonly Rational[]): Rational {
  return values.reduce((a, b) => add(a, b), rat(0));
}
