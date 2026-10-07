/**
 * Horizontal layout of one measure across all staves ("measure column"): onset segments,
 * minimum distances from glyph extents and duration-based springs. Width as a function of the
 * system's stretch factor lets the system layout justify lines exactly.
 */
import { type MeasureInfo, type Rational, cmp, eq, sub, toNumber } from '@cantelvio-score/core';
import { STYLE } from '../options';
import { type ChordGeom, type RestGeom, chordGeometry, restGeometry } from './chord';
import type { NItem, NMeasure } from './notation';

export interface ColumnItem {
  readonly staff: number;
  readonly item: NItem;
  readonly geom: ChordGeom | RestGeom;
}

export interface Segment {
  readonly offset: Rational;
  readonly items: ColumnItem[];
  left: number;
  right: number;
}

export interface Column {
  readonly info: MeasureInfo;
  readonly notation: readonly NMeasure[];
  readonly segments: Segment[];
  readonly fullRests: ColumnItem[];
  /** Spring (duration-based ideal distance) after each segment. */
  readonly springs: number[];
  /** Minimum distance after each segment (glyph collisions). */
  readonly minimums: number[];
  readonly startPad: number;
}

export function spacingFor(duration: Rational, factor: number): number {
  return (
    STYLE.noteSpacingQuarter * Math.pow(toNumber(duration) / 0.25, STYLE.spacingExponent) * factor
  );
}

export function buildColumn(
  info: MeasureInfo,
  notation: readonly NMeasure[],
  spacing: number,
): Column {
  const byOffset = new Map<string, Segment>();
  const fullRests: ColumnItem[] = [];
  notation.forEach((nm, staff) => {
    for (const v of nm.voices) {
      for (const item of v.items) {
        const geom =
          item.kind === 'chord'
            ? chordGeometry(item, nm.multiVoice)
            : restGeometry(item, nm.multiVoice);
        const ci: ColumnItem = { staff, item, geom };
        if (item.kind === 'rest' && item.fullMeasure) {
          fullRests.push(ci);
          continue;
        }
        const key = `${item.offset.n}/${item.offset.d}`;
        let seg = byOffset.get(key);
        if (!seg) {
          seg = { offset: item.offset, items: [], left: 0, right: 0 };
          byOffset.set(key, seg);
        }
        seg.items.push(ci);
        seg.left = Math.min(seg.left, geom.left);
        seg.right = Math.max(seg.right, geom.right);
      }
    }
  });
  const segments = [...byOffset.values()].sort((a, b) => cmp(a.offset, b.offset));
  if (segments.length === 0) {
    // Only full-measure rests: one virtual segment at the start.
    segments.push({ offset: { n: 0, d: 1 }, items: [], left: 0, right: 1.2 });
  }
  const springs: number[] = [];
  const minimums: number[] = [];
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k]!;
    const next = segments[k + 1];
    const end = next ? next.offset : info.length;
    const dur = sub(end, seg.offset);
    const onlyRests = segments.length === 1 && fullRests.length > 0 && seg.items.length === 0;
    springs.push(onlyRests ? spacingFor(info.length, spacing) * 0.9 : spacingFor(dur, spacing));
    minimums.push(
      next ? seg.right - next.left + STYLE.minPadding : seg.right + STYLE.measureEndPad,
    );
  }
  const firstLeft = segments[0]!.left;
  const startPad = Math.max(STYLE.measureStartPad, -firstLeft + STYLE.minPadding);
  return { info, notation, segments, fullRests, springs, minimums, startPad };
}

/** Content width (from the start barline/prefix to the end barline) at stretch s. */
export function columnWidth(c: Column, s: number): number {
  let w = c.startPad;
  for (let k = 0; k < c.springs.length; k++) w += Math.max(c.springs[k]! * s, c.minimums[k]!);
  return w;
}

/** x of every segment origin relative to the content start, at stretch s. */
export function segmentPositions(c: Column, s: number): number[] {
  const xs: number[] = [];
  let x = c.startPad;
  for (let k = 0; k < c.segments.length; k++) {
    xs.push(x);
    x += Math.max(c.springs[k]! * s, c.minimums[k]!);
  }
  return xs;
}

export function sameOffset(a: Rational, b: Rational): boolean {
  return eq(a, b);
}
