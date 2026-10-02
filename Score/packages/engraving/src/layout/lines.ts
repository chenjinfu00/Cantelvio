/**
 * Drawing of spanners: slurs (curves that clear the notes under them) and lines — hairpins,
 * octave lines, trill lines and pedal marks. Positions are staff-local (y from the top line).
 * Every function draws one system's segment of a spanner; `open*` flags say whether the spanner
 * continues from the previous system or into the next one.
 */
import { type Graphic, fmt, group } from '../graphics';
import { STYLE } from '../options';
import { type GlyphName, glyphBox, glyphWidth } from '../smufl/glyphs';

// ------------------------------------------------------------------------------- slurs

/** Closed outline of a curve: outer Bézier with height h, inner one with h − thickness. */
export function curvePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dir: 1 | -1,
  h: number,
  thickness: number,
): string {
  const len = Math.max(0.5, x2 - x1);
  const d = Math.min(len * 0.25, 4);
  const p = (a: number, c: number) => `${fmt(a)} ${fmt(c)}`;
  const hi = Math.max(0.05, h - thickness);
  return (
    `M ${p(x1, y1)} C ${p(x1 + d, y1 + dir * h)} ${p(x2 - d, y2 + dir * h)} ${p(x2, y2)} ` +
    `C ${p(x2 - d, y2 + dir * hi)} ${p(x1 + d, y1 + dir * hi)} ${p(x1, y1)} Z`
  );
}

/** x(t) of the curve's control polygon (monotonic), solved for t by bisection. */
function paramAt(x1: number, x2: number, x: number): number {
  const len = Math.max(0.5, x2 - x1);
  const d = Math.min(len * 0.25, 4);
  const bx = (t: number) => {
    const u = 1 - t;
    return u * u * u * x1 + 3 * u * u * t * (x1 + d) + 3 * u * t * t * (x2 - d) + t * t * t * x2;
  };
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Shape of a slur from (x1, y1) to (x2, y2) on side `dir` (−1 above, +1 below) that keeps
 * `clearance` away from the obstacle points (tops of the notes and marks under it).
 */
export function slurShape(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dir: 1 | -1,
  obstacles: readonly { x: number; y: number }[],
): { y1: number; y2: number; h: number } {
  const len = Math.max(0.5, x2 - x1);
  let h = Math.min(2.2, Math.max(0.6, 0.35 + len * 0.09));
  const hMax = Math.max(2.4, len * 0.3);
  const clearance = 0.45;
  let lift = 0;
  for (const o of obstacles) {
    if (o.x <= x1 + 0.2 || o.x >= x2 - 0.2) continue;
    const t = paramAt(x1, x2, o.x);
    const u = 1 - t;
    const base = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2;
    const k = 3 * t * u;
    // above: base − k·h <= o.y − clearance; below: base + k·h >= o.y + clearance
    const need = dir < 0 ? (base - o.y + clearance) / k : (o.y + clearance - base) / k;
    if (need > hMax) {
      lift = Math.max(lift, (need - hMax) * k);
      h = hMax;
    } else h = Math.max(h, need);
  }
  return { y1: y1 + dir * lift, y2: y2 + dir * lift, h };
}

export function drawSlur(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dir: 1 | -1,
  h: number,
  cls: string,
  ref: string,
): Graphic {
  return { kind: 'path', d: curvePath(x1, y1, x2, y2, dir, h, STYLE.tieThickness), cls, ref };
}

// ------------------------------------------------------------------------------- hairpins

/** Opening of a hairpin at its ends (staff spaces). */
export const HAIRPIN_OPENING = 1.2;

export function drawHairpin(
  x1: number,
  x2: number,
  centre: number,
  open1: number,
  open2: number,
  cls: string,
  ref: string,
): Graphic {
  const w = 0.13;
  const line = (ya: number, yb: number): Graphic => ({
    kind: 'line',
    x1,
    y1: ya,
    x2,
    y2: yb,
    width: w,
    cap: 'round',
  });
  return group(
    [line(centre - open1 / 2, centre - open2 / 2), line(centre + open1 / 2, centre + open2 / 2)],
    cls,
    ref,
  );
}

// ------------------------------------------------------------------------------- octave lines

const OTTAVA_TEXT: Record<number, GlyphName> = {
  1: 'ottavaAlta',
  2: 'quindicesimaAlta',
  [-1]: 'ottavaBassaVb',
  [-2]: 'quindicesimaBassaMb',
};
const OTTAVA_NUMBER: Record<number, GlyphName> = {
  1: 'ottava',
  2: 'quindicesima',
  [-1]: 'ottava',
  [-2]: 'quindicesima',
};

/**
 * One system's part of an octave line. `y` is the text baseline. The line is dashed and ends
 * with a hook towards the staff; a continued line starts with the number in parentheses.
 */
export function drawOttava(
  octaves: number,
  x1: number,
  x2: number,
  baseline: number,
  continued: boolean,
  continues: boolean,
  cls: string,
  ref: string,
): Graphic {
  const children: Graphic[] = [];
  const above = octaves > 0;
  let x = x1;
  if (continued) {
    for (const g of [
      'octaveParensLeft',
      OTTAVA_NUMBER[octaves]!,
      'octaveParensRight',
    ] as GlyphName[]) {
      children.push({ kind: 'glyph', name: g, x, y: baseline, scale: 0.8 });
      x += glyphWidth(g, 0.8);
    }
  } else {
    const g = OTTAVA_TEXT[octaves]!;
    children.push({ kind: 'glyph', name: g, x, y: baseline });
    x += glyphWidth(g);
  }
  const lineY = baseline - 0.9;
  const start = x + 0.35;
  // a short line still shows a little dash before its hook
  x2 = Math.max(x2, start + 1.2);
  {
    children.push({
      kind: 'line',
      x1: start,
      y1: lineY,
      x2,
      y2: lineY,
      width: 0.13,
      dash: [0.45, 0.35],
    });
    if (!continues) {
      const hookTo = above ? lineY + 1.1 : lineY - 1.1;
      children.push({ kind: 'line', x1: x2, y1: lineY, x2, y2: hookTo, width: 0.13 });
    }
  }
  return group(children, cls, ref);
}

/** Vertical extent of the octave text below and above its baseline. */
export const OTTAVA_HEIGHT = glyphBox('ottavaAlta').bottom - glyphBox('ottavaAlta').top;

// ------------------------------------------------------------------------------- trill lines

/** "tr" and a wavy line from x1 to x2; continuations have only the wavy line. */
export function drawTrillLine(
  x1: number,
  x2: number,
  baseline: number,
  continued: boolean,
  cls: string,
  ref: string,
): Graphic {
  const children: Graphic[] = [];
  let x = x1;
  if (!continued) {
    children.push({ kind: 'glyph', name: 'ornamentTrill', x, y: baseline });
    x += glyphWidth('ornamentTrill') + 0.15;
  }
  const step = 0.948; // wiggleTrill repeat offset
  const wy = baseline - 0.15;
  for (; x + step <= x2 + 0.05; x += step)
    children.push({ kind: 'glyph', name: 'wiggleTrill', x, y: wy });
  return group(children, cls, ref);
}

// ------------------------------------------------------------------------------- pedal

/**
 * Sustain pedal: "Ped." at the start and "*" at the release, or a bracket line with hooks.
 * `baseline` is the text baseline (the line style draws its line there).
 */
export function drawPedal(
  style: 'text' | 'line',
  x1: number,
  x2: number,
  baseline: number,
  continued: boolean,
  continues: boolean,
  cls: string,
  ref: string,
): Graphic {
  const children: Graphic[] = [];
  if (style === 'text') {
    if (!continued) children.push({ kind: 'glyph', name: 'keyboardPedalPed', x: x1, y: baseline });
    if (!continues) {
      const w = glyphWidth('keyboardPedalUp', 0.85);
      children.push({
        kind: 'glyph',
        name: 'keyboardPedalUp',
        x: x2 - w / 2,
        y: baseline,
        scale: 0.85,
      });
    }
  } else {
    const w = 0.13;
    const hook = 1.1;
    children.push({ kind: 'line', x1, y1: baseline, x2, y2: baseline, width: w });
    if (!continued)
      children.push({ kind: 'line', x1, y1: baseline - hook, x2: x1, y2: baseline, width: w });
    if (!continues)
      children.push({ kind: 'line', x1: x2, y1: baseline, x2, y2: baseline - hook, width: w });
  }
  return group(children, cls, ref);
}
