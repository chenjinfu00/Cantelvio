/** Drawing of chords, rests, beams, ties and tuplet marks into staff-local graphics. */
import { NOTE_VALUE_BEAMS, type DynamicValue } from '@cantelvio-score/core';
import { type Graphic, fmt, group } from '../graphics';
import { STYLE } from '../options';
import { type GlyphName, TUPLET_DIGITS, glyphWidth } from '../smufl/glyphs';
import { type ChordGeom, type GraceGeom, type RestGeom, arpeggioGlyphs, placeMarks } from './chord';
import type { NChord, NRest } from './notation';

export interface PlacedChord {
  readonly chord: NChord;
  readonly geom: ChordGeom;
  readonly x: number;
}

const glyphAt = (
  g: { glyph: GlyphName; x: number; y: number; scale?: number; rotate?: number },
  x: number,
  cls: string,
): Graphic => ({
  kind: 'glyph',
  name: g.glyph,
  x: x + g.x,
  y: g.y,
  ...(g.scale !== undefined && g.scale !== 1 ? { scale: g.scale } : {}),
  ...(g.rotate ? { rotate: g.rotate } : {}),
  cls,
});

function drawGrace(g: GraceGeom, x: number): Graphic {
  const children: Graphic[] = [];
  const scale = g.noteheads[0]?.scale ?? 1;
  for (const l of g.ledgers)
    children.push({
      kind: 'line',
      x1: x + l.x1,
      y1: l.y,
      x2: x + l.x2,
      y2: l.y,
      width: STYLE.ledgerLineWidth * 0.8,
      cls: 'ledger',
    });
  if (g.stem)
    children.push({
      kind: 'line',
      x1: x + g.stem.x,
      y1: g.stem.yBase,
      x2: x + g.stem.x,
      y2: g.stem.yTip,
      width: STYLE.stemWidth * scale,
      cls: 'stem',
    });
  if (g.flag) children.push(glyphAt(g.flag, x, 'flag'));
  if (g.slash)
    children.push({
      kind: 'line',
      x1: x + g.slash.x1,
      y1: g.slash.y1,
      x2: x + g.slash.x2,
      y2: g.slash.y2,
      width: STYLE.stemWidth * 1.1,
      cls: 'grace-slash',
    });
  for (const a of g.accidentals) children.push(glyphAt(a, x, 'accidental'));
  for (const h of g.noteheads)
    children.push({
      kind: 'glyph',
      name: h.glyph,
      x: x + h.x,
      y: h.y,
      scale: h.scale,
      cls: 'notehead',
      ref: `n:${h.noteId}`,
    });
  return group(children, 'grace', `gc:${g.graceId}`);
}

export function drawChord(p: PlacedChord, extraCls = ''): Graphic {
  const { chord, geom, x } = p;
  const mag = geom.mag;
  const children: Graphic[] = [];
  for (const g of geom.graces) children.push(drawGrace(g, x));
  for (const points of geom.graceBeams)
    children.push({
      kind: 'polygon',
      points: points.map((v, i) => (i % 2 === 0 ? v + x : v)),
      cls: 'beam',
    });
  if (geom.arpeggio)
    for (const g of arpeggioGlyphs(geom.arpeggio, x)) children.push(glyphAt(g, 0, 'arpeggio'));
  for (const l of geom.ledgers) {
    children.push({
      kind: 'line',
      x1: x + l.x1,
      y1: l.y,
      x2: x + l.x2,
      y2: l.y,
      width: STYLE.ledgerLineWidth,
      cls: 'ledger',
    });
  }
  if (geom.stem) {
    children.push({
      kind: 'line',
      x1: x + geom.stem.x,
      y1: geom.stem.yBase,
      x2: x + geom.stem.x,
      y2: geom.stem.yTip,
      width: STYLE.stemWidth * mag,
      cls: 'stem',
    });
  }
  if (geom.flag && geom.stem) {
    children.push(glyphAt({ ...geom.flag, y: geom.stem.yTip }, x, 'flag'));
  }
  for (const a of geom.accidentals) children.push(glyphAt(a, x, 'accidental'));
  for (const h of geom.noteheads) {
    children.push({
      kind: 'glyph',
      name: h.glyph,
      x: x + h.x,
      y: h.y,
      ...(h.scale !== 1 ? { scale: h.scale } : {}),
      cls: 'notehead',
      ref: `n:${h.noteId}`,
    });
  }
  for (const d of geom.dots)
    children.push(glyphAt({ glyph: 'augmentationDot', x: d.x, y: d.y, scale: mag }, x, 'dot'));
  for (const m of placeMarks(chord, geom))
    children.push(glyphAt(m, x, m.glyph.startsWith('tremolo') ? 'tremolo' : 'articulation'));
  if (geom.breath) children.push(glyphAt(geom.breath, x, 'breath'));
  const cls = [
    'chord',
    chord.ghost ? 'ghost' : '',
    chord.approx ? 'approx' : '',
    chord.cue ? 'cue' : '',
    extraCls,
  ]
    .filter(Boolean)
    .join(' ');
  return group(children, cls, `e:${chord.eventId}`);
}

export function drawRest(rest: NRest, geom: RestGeom, x: number): Graphic {
  const children: Graphic[] = [
    { kind: 'glyph', name: geom.glyph, x: x + geom.x, y: geom.y, cls: 'rest-glyph' },
  ];
  for (const d of geom.dots)
    children.push({ kind: 'glyph', name: 'augmentationDot', x: x + d.x, y: d.y, cls: 'dot' });
  // ledger line for whole/half rests outside the staff (multi-voice)
  if ((geom.glyph === 'restWhole' || geom.glyph === 'restHalf') && (geom.y < 0 || geom.y > 4)) {
    const w = glyphWidth(geom.glyph);
    children.push({
      kind: 'line',
      x1: x - 0.4,
      y1: geom.y,
      x2: x + w + 0.4,
      y2: geom.y,
      width: STYLE.ledgerLineWidth,
      cls: 'ledger',
    });
  }
  return group(children, rest.approx ? 'rest approx' : 'rest', rest.key);
}

// ------------------------------------------------------------------------------- beams

/**
 * Compute beam geometry for one group: adjusts the stems' tips in place and returns the beam
 * polygons.
 */
export function beamGroup(chords: PlacedChord[]): Graphic[] {
  const out: Graphic[] = [];
  const valid = chords.filter((c) => c.geom.stem);
  if (valid.length < 2) return out;
  const up = valid[0]!.chord.stem === 'up';
  const dir = up ? -1 : 1; // direction from noteheads towards the beam
  const stemX = valid.map((c) => c.x + c.geom.stem!.x);
  // y of the note nearest to the beam in each chord
  const near = valid.map((c) =>
    up
      ? Math.min(...c.geom.noteheads.map((h) => h.y))
      : Math.max(...c.geom.noteheads.map((h) => h.y)),
  );
  const levels = valid.map((c) => NOTE_VALUE_BEAMS[c.chord.written.value]);
  const maxLevel = Math.max(...levels);
  // cue-size groups get thinner, closer beams and shorter stems
  const mag = Math.max(...valid.map((c) => c.geom.mag));
  const x0 = stemX[0]!;
  const x1 = stemX[stemX.length - 1]!;
  const yF = near[0]!;
  const yL = near[near.length - 1]!;
  // slope: follow the outer notes, at most one staff space over the group; flat when concave
  let rise = Math.max(-1, Math.min(1, (yL - yF) / 2));
  const inner = near.slice(1, -1);
  if (inner.length) {
    const concave = up
      ? inner.some((v) => v < Math.min(yF, yL))
      : inner.some((v) => v > Math.max(yF, yL));
    if (concave) rise = 0;
  }
  const span = Math.max(0.001, x1 - x0);
  const slope = rise / span;
  const stemMin = (3.0 + (maxLevel - 1) * (STYLE.beamThickness + STYLE.beamSpacing)) * mag;
  // beam line y(x) = b + slope (x - x0) is the OUTER edge of the primary beam
  let b = up ? Infinity : -Infinity;
  valid.forEach((c, i) => {
    const need = near[i]! + dir * Math.max(stemMin, c.geom.minStem) - slope * (stemX[i]! - x0);
    b = up ? Math.min(b, need) : Math.max(b, need);
  });
  // groups far outside the staff: centre of the beam reaches the middle line
  const centerY = b + slope * (span / 2);
  if (mag === 1 && up && centerY > 2) b -= centerY - 2;
  if (mag === 1 && !up && centerY < 2) b += 2 - centerY;
  const beamY = (x: number) => b + slope * (x - x0);
  valid.forEach((c, i) => {
    c.geom.stem!.yTip = beamY(stemX[i]!);
  });
  const T = STYLE.beamThickness * mag;
  const step = T + STYLE.beamSpacing * mag;
  const half = (STYLE.stemWidth * mag) / 2;
  const poly = (xa: number, xb: number, level: number): Graphic => {
    const off = -dir * (level - 1) * step; // towards the noteheads
    const ya = beamY(xa) + off;
    const yb = beamY(xb) + off;
    const t = -dir * T;
    return { kind: 'polygon', points: [xa, ya, xb, yb, xb, yb + t, xa, ya + t], cls: 'beam' };
  };
  out.push(poly(x0 - half, x1 + half, 1));
  for (let level = 2; level <= maxLevel; level++) {
    let i = 0;
    while (i < valid.length) {
      if (levels[i]! < level) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < valid.length && levels[j + 1]! >= level) j++;
      if (j > i) out.push(poly(stemX[i]! - half, stemX[j]! + half, level));
      else {
        // beamlet: points right for the first chord or when the next chord is shorter
        const len = Math.min(1.1, span / 2);
        const right =
          i === 0 || (i < valid.length - 1 && (levels[i - 1] ?? 0) < (levels[i + 1] ?? 0));
        out.push(
          right
            ? poly(stemX[i]! - half, stemX[i]! + len, level)
            : poly(stemX[i]! - len, stemX[i]! + half, level),
        );
      }
      i = j + 1;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------- ties

export function tiePath(x1: number, y1: number, x2: number, y2: number, dir: 1 | -1): string {
  const len = Math.max(0.5, x2 - x1);
  const h = Math.min(0.35 + len * 0.06, 1.1);
  const t = STYLE.tieThickness;
  const cx1 = x1 + len * 0.25;
  const cx2 = x2 - len * 0.25;
  const p = (a: number, c: number) => `${fmt(a)} ${fmt(c)}`;
  return (
    `M ${p(x1, y1)} C ${p(cx1, y1 + dir * h)} ${p(cx2, y2 + dir * h)} ${p(x2, y2)} ` +
    `C ${p(cx2, y2 + dir * (h - t))} ${p(cx1, y1 + dir * (h - t))} ${p(x1, y1)} Z`
  );
}

export function drawTie(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dir: 1 | -1,
  ref?: string,
): Graphic {
  return { kind: 'path', d: tiePath(x1, y1, x2, y2, dir), cls: 'tie', ...(ref ? { ref } : {}) };
}

// ------------------------------------------------------------------------------- tuplets

export function drawTupletMark(
  number: number,
  x1: number,
  x2: number,
  y: number,
  above: boolean,
  bracket: boolean,
): Graphic[] {
  const digits = String(number)
    .split('')
    .map((d) => TUPLET_DIGITS[Number(d)]! as GlyphName);
  const w = digits.reduce((s, g) => s + glyphWidth(g), 0);
  const cx = (x1 + x2) / 2;
  const out: Graphic[] = [];
  let gx = cx - w / 2;
  const numberY = y + 0.55;
  for (const g of digits) {
    out.push({ kind: 'glyph', name: g, x: gx, y: numberY, cls: 'tuplet-number' });
    gx += glyphWidth(g);
  }
  if (bracket) {
    const hook = above ? 0.6 : -0.6;
    const gap = w / 2 + 0.35;
    const lw = 0.12;
    out.push({ kind: 'line', x1, y1: y + hook, x2: x1, y2: y, width: lw, cls: 'tuplet-bracket' });
    out.push({ kind: 'line', x1, y1: y, x2: cx - gap, y2: y, width: lw, cls: 'tuplet-bracket' });
    out.push({ kind: 'line', x1: cx + gap, y1: y, x2, y2: y, width: lw, cls: 'tuplet-bracket' });
    out.push({ kind: 'line', x1: x2, y1: y, x2, y2: y + hook, width: lw, cls: 'tuplet-bracket' });
  }
  return out;
}

// ------------------------------------------------------------------------------- dynamics

const DYNAMIC_LETTERS: Record<string, GlyphName> = {
  p: 'dynamicPiano',
  m: 'dynamicMezzo',
  f: 'dynamicForte',
  r: 'dynamicRinforzando',
  s: 'dynamicSforzando',
  z: 'dynamicZ',
  n: 'dynamicNiente',
};

export function drawDynamic(
  value: DynamicValue,
  x: number,
  y: number,
  ref?: string,
  extraCls = '',
): Graphic {
  const children: Graphic[] = [];
  let cx = x;
  for (const ch of value) {
    const g = DYNAMIC_LETTERS[ch];
    if (!g) continue;
    children.push({ kind: 'glyph', name: g, x: cx, y });
    cx += glyphWidth(g) * 0.92;
  }
  return group(children, `dynamic${extraCls}`, ref);
}

/** Width of a dynamic mark as drawn by `drawDynamic`. */
export function dynamicWidth(value: DynamicValue): number {
  let w = 0;
  for (const ch of value) {
    const g = DYNAMIC_LETTERS[ch];
    if (g) w += glyphWidth(g) * 0.92;
  }
  return w;
}
