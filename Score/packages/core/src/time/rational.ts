/**
 * Exact rational numbers for musical time.
 *
 * All score time (offsets, durations, measure lengths) is stored as rationals measured in
 * WHOLE NOTES: a quarter note is 1/4, a triplet eighth is 1/12. Floating point is never used for
 * musical time, so tuplets and long scores never accumulate rounding error.
 *
 * Values are plain JSON objects `{ n, d }` (normalized: d > 0, gcd(n, d) = 1) so they serialize
 * directly and work with immutable updates.
 */
export interface Rational {
  readonly n: number;
  readonly d: number;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function lcm(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : Math.abs((a / gcd(a, b)) * b);
}

/** Create a normalized rational. Throws on non-integers or a zero denominator. */
export function rat(n: number, d = 1): Rational {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) {
    throw new RangeError(`rational parts must be safe integers, got ${n}/${d}`);
  }
  if (d === 0) throw new RangeError('rational denominator must not be zero');
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1;
  // `+ 0` turns -0 into 0 so equal values serialize identically.
  return { n: n / g + 0, d: d / g };
}

export const ZERO: Rational = rat(0);
export const ONE: Rational = rat(1);

export const add = (a: Rational, b: Rational): Rational => rat(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rational, b: Rational): Rational => rat(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rational, b: Rational): Rational => rat(a.n * b.n, a.d * b.d);
export function div(a: Rational, b: Rational): Rational {
  if (b.n === 0) throw new RangeError('division by zero');
  return rat(a.n * b.d, a.d * b.n);
}
export const neg = (a: Rational): Rational => rat(-a.n, a.d);
export const mulInt = (a: Rational, k: number): Rational => rat(a.n * k, a.d);
export const divInt = (a: Rational, k: number): Rational => rat(a.n, a.d * k);

/** Compare: negative if a < b, 0 if equal, positive if a > b. */
export const cmp = (a: Rational, b: Rational): number => a.n * b.d - b.n * a.d;
export const eq = (a: Rational, b: Rational): boolean => a.n === b.n && a.d === b.d;
export const lt = (a: Rational, b: Rational): boolean => cmp(a, b) < 0;
export const le = (a: Rational, b: Rational): boolean => cmp(a, b) <= 0;
export const gt = (a: Rational, b: Rational): boolean => cmp(a, b) > 0;
export const ge = (a: Rational, b: Rational): boolean => cmp(a, b) >= 0;
export const min = (a: Rational, b: Rational): Rational => (le(a, b) ? a : b);
export const max = (a: Rational, b: Rational): Rational => (ge(a, b) ? a : b);
export const isZero = (a: Rational): boolean => a.n === 0;
export const isPositive = (a: Rational): boolean => a.n > 0;
export const isNegative = (a: Rational): boolean => a.n < 0;

export function sum(values: readonly Rational[]): Rational {
  return values.reduce(add, ZERO);
}

/** Approximate value, for display/geometry only. Never feed this back into score time. */
export const toNumber = (a: Rational): number => a.n / a.d;

/** "3/8", "1", "-1/4". */
export const toString = (a: Rational): string => (a.d === 1 ? `${a.n}` : `${a.n}/${a.d}`);

/** Parse "3/8", "2", " -1/4 ". */
export function parseRational(text: string): Rational {
  const m = /^\s*(-?\d+)\s*(?:\/\s*(\d+))?\s*$/.exec(text);
  if (!m) throw new SyntaxError(`not a rational: "${text}"`);
  return rat(Number(m[1]), m[2] === undefined ? 1 : Number(m[2]));
}

/** Floor of a/b as an integer (b > 0). */
export function floorDiv(a: Rational, b: Rational): number {
  return Math.floor((a.n * b.d) / (a.d * b.n));
}

/** True if `a` is an integer multiple of `unit`. */
export function isMultipleOf(a: Rational, unit: Rational): boolean {
  const q = div(a, unit);
  return q.d === 1;
}

/** True if the denominator is a power of two (a "binary" duration that needs no tuplet). */
export function isDyadic(a: Rational): boolean {
  return (a.d & (a.d - 1)) === 0;
}
