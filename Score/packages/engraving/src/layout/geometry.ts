/** Geometry of laid-out measures: segment positions and time <-> x conversions. */
import { type Rational, toNumber } from '@cantelvio-score/core';

export interface SegmentGeometry {
  readonly offset: Rational;
  readonly x: number;
}

export interface MeasureGeometry {
  readonly measureId: string;
  readonly index: number;
  /** Start barline x. */
  readonly x: number;
  readonly width: number;
  /** x where the content (first segment area) starts. */
  readonly contentX: number;
  readonly segments: readonly SegmentGeometry[];
  readonly length: Rational;
}

/** x of a time position; floats are supported for the audio-clock-driven playhead. */
export function offsetToX(measure: MeasureGeometry, t: Rational | number): number {
  return xAtOffset(measure.segments, measure.length, measure.x + measure.width, t);
}

/** Approximate time position (whole notes, float) of an x inside a laid-out measure. */
export function xToOffset(measure: MeasureGeometry, x: number): number {
  const segs = measure.segments;
  const len = toNumber(measure.length);
  if (!segs.length) return 0;
  const end = measure.x + measure.width;
  for (let k = 0; k < segs.length; k++) {
    const a = segs[k]!;
    const bx = segs[k + 1]?.x ?? end;
    const bt = segs[k + 1] ? toNumber(segs[k + 1]!.offset) : len;
    if (x < bx || k === segs.length - 1) {
      if (x <= a.x) return toNumber(a.offset);
      return (
        toNumber(a.offset) +
        ((Math.min(x, bx) - a.x) / Math.max(0.001, bx - a.x)) * (bt - toNumber(a.offset))
      );
    }
  }
  return 0;
}

export function xAtOffset(
  segs: readonly SegmentGeometry[],
  length: Rational,
  endX: number,
  t: Rational | number,
): number {
  if (segs.length === 0) return endX;
  const offset = typeof t === 'number' ? t : toNumber(t);
  let k = 0;
  while (k + 1 < segs.length && toNumber(segs[k + 1]!.offset) <= offset) k++;
  const a = segs[k]!;
  const start = toNumber(a.offset);
  if (start === offset) return a.x;
  const nextOffset = segs[k + 1]?.offset ?? length;
  const nextX = segs[k + 1]?.x ?? endX;
  const span = toNumber(nextOffset) - start;
  const frac = span > 0 ? (offset - start) / span : 0;
  return a.x + (nextX - a.x) * frac;
}
