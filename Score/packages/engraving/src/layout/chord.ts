/**
 * Geometry of single chords and rests, relative to their own origin:
 * x = 0 is the left edge of the "normal side" notehead column, y is measured from the top staff
 * line (y down, staff spaces). Horizontal placement happens later in the measure layout.
 */
import { NOTE_VALUE_BEAMS, type NoteValue } from '@ailegro-score/core';
import { type GlyphName, anchor, glyphBox, glyphWidth } from '../smufl/glyphs';
import { STYLE } from '../options';
import type { AccidentalKind, NChord, NRest } from './notation';

export interface NoteheadGeom {
  readonly noteId: string;
  readonly glyph: GlyphName;
  readonly x: number;
  readonly y: number;
  readonly position: number;
  readonly flipped: boolean;
}

export interface ChordGeom {
  readonly kind: 'chord';
  readonly noteheads: NoteheadGeom[];
  /** Stem: x is the centre line; yBase at the noteheads, yTip at the free end. */
  stem: { x: number; yBase: number; yTip: number } | null;
  flag: { glyph: GlyphName; x: number; y: number } | null;
  readonly dots: { x: number; y: number }[];
  readonly accidentals: { glyph: GlyphName; x: number; y: number }[];
  readonly ledgers: { y: number; x1: number; x2: number }[];
  readonly articulations: { glyph: GlyphName; x: number; y: number }[];
  readonly noteheadWidth: number;
  /** Horizontal extents relative to the origin (left is negative when accidentals exist). */
  left: number;
  right: number;
}

export interface RestGeom {
  readonly kind: 'rest';
  readonly glyph: GlyphName;
  readonly x: number;
  readonly y: number;
  readonly dots: { x: number; y: number }[];
  readonly left: number;
  readonly right: number;
  readonly fullMeasure: boolean;
}

const NOTEHEAD: Record<NoteValue, GlyphName> = {
  breve: 'noteheadDoubleWhole',
  whole: 'noteheadWhole',
  half: 'noteheadHalf',
  quarter: 'noteheadBlack',
  eighth: 'noteheadBlack',
  '16th': 'noteheadBlack',
  '32nd': 'noteheadBlack',
  '64th': 'noteheadBlack',
  '128th': 'noteheadBlack',
};

const REST: Record<NoteValue, GlyphName> = {
  breve: 'restDoubleWhole',
  whole: 'restWhole',
  half: 'restHalf',
  quarter: 'restQuarter',
  eighth: 'rest8th',
  '16th': 'rest16th',
  '32nd': 'rest32nd',
  '64th': 'rest64th',
  '128th': 'rest128th',
};

const FLAG_UP: GlyphName[] = ['flag8thUp', 'flag16thUp', 'flag32ndUp', 'flag64thUp', 'flag128thUp'];
const FLAG_DOWN: GlyphName[] = [
  'flag8thDown',
  'flag16thDown',
  'flag32ndDown',
  'flag64thDown',
  'flag128thDown',
];

export const ACCIDENTAL_GLYPH: Record<AccidentalKind, GlyphName> = {
  flat: 'accidentalFlat',
  natural: 'accidentalNatural',
  sharp: 'accidentalSharp',
  doubleSharp: 'accidentalDoubleSharp',
  doubleFlat: 'accidentalDoubleFlat',
};

const ARTICULATION_GLYPH: Record<string, [GlyphName, GlyphName]> = {
  staccato: ['articStaccatoAbove', 'articStaccatoBelow'],
  staccatissimo: ['articStaccatissimoAbove', 'articStaccatissimoBelow'],
  accent: ['articAccentAbove', 'articAccentBelow'],
  tenuto: ['articTenutoAbove', 'articTenutoBelow'],
  marcato: ['articMarcatoAbove', 'articMarcatoBelow'],
};

const y = (position: number) => position * 0.5;

export function hasStem(value: NoteValue): boolean {
  return value !== 'whole' && value !== 'breve';
}

export function chordGeometry(chord: NChord, multiVoice: boolean, staffLines = 5): ChordGeom {
  const value = chord.written.value;
  const head = NOTEHEAD[value];
  const nhWidth = glyphWidth(head);
  const up = chord.stem === 'up';
  const positions = chord.notes.map((n) => n.position);

  // Seconds: alternate noteheads to the other side of the stem.
  const order = chord.notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) =>
      up || !hasStem(value) ? b.n.position - a.n.position : a.n.position - b.n.position,
    );
  const flipped = new Array<boolean>(chord.notes.length).fill(false);
  let prevPos: number | null = null;
  let prevFlipped = false;
  for (const { n, i } of order) {
    const adjacent: boolean = prevPos !== null && Math.abs(prevPos - n.position) === 1;
    flipped[i] = adjacent && !prevFlipped;
    prevPos = n.position;
    prevFlipped = flipped[i]!;
  }
  const flipOffset = nhWidth - STYLE.stemWidth;
  const noteheads: NoteheadGeom[] = chord.notes.map((n, i) => ({
    noteId: n.noteId,
    glyph: head,
    x: flipped[i] ? (up || !hasStem(value) ? flipOffset : -flipOffset) : 0,
    y: y(n.position),
    position: n.position,
    flipped: flipped[i]!,
  }));
  const headsLeft = Math.min(...noteheads.map((h) => h.x));
  const headsRight = Math.max(...noteheads.map((h) => h.x + nhWidth));

  // Stem.
  let stem: ChordGeom['stem'] = null;
  let flag: ChordGeom['flag'] = null;
  const beams = NOTE_VALUE_BEAMS[value];
  if (hasStem(value)) {
    const top = Math.min(...positions);
    const bottom = Math.max(...positions);
    const extra = beams >= 3 ? (beams - 2) * 0.5 : 0;
    if (up) {
      const a = anchor(head, 'stemUpSE') ?? { x: nhWidth, y: -0.168 };
      const x = a.x - STYLE.stemWidth / 2;
      const yBase = y(bottom) + a.y;
      // Stems of notes far below the staff reach at least the middle line.
      const yTip = Math.min(y(top) - STYLE.stemLength - extra, 2);
      stem = { x, yBase, yTip };
    } else {
      const a = anchor(head, 'stemDownNW') ?? { x: 0, y: 0.168 };
      const x = a.x + STYLE.stemWidth / 2;
      const yBase = y(top) + a.y;
      const yTip = Math.max(y(bottom) + STYLE.stemLength + extra, 2);
      stem = { x, yBase, yTip };
    }
    if (beams > 0 && chord.beam === null) {
      const glyphName = (up ? FLAG_UP : FLAG_DOWN)[Math.min(beams, 5) - 1]!;
      flag = { glyph: glyphName, x: stem.x - STYLE.stemWidth / 2, y: stem.yTip };
    }
  }

  // Dots.
  const dots: { x: number; y: number }[] = [];
  if (chord.written.dots > 0) {
    const used = new Set<number>();
    const dx0 = headsRight + STYLE.dotGap + (flag && up ? glyphWidth(flag.glyph) * 0.75 : 0);
    for (const n of [...chord.notes].sort((a, b) => a.position - b.position)) {
      let pos = n.position % 2 === 0 ? n.position - 1 : n.position;
      while (used.has(pos)) pos += 2;
      used.add(pos);
      for (let d = 0; d < chord.written.dots; d++)
        dots.push({ x: dx0 + d * STYLE.dotSpacing, y: y(pos) });
    }
  }

  // Accidentals (columns, top to bottom).
  const accidentals: ChordGeom['accidentals'] = [];
  const withAcc = chord.notes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.accidental)
    .sort((a, b) => a.n.position - b.n.position);
  if (withAcc.length) {
    const columns: { right: number; boxes: [number, number][] }[] = [];
    const pitch =
      Math.max(...withAcc.map(({ n }) => glyphWidth(ACCIDENTAL_GLYPH[n.accidental!]))) + 0.12;
    const firstRight = headsLeft - STYLE.accidentalGap;
    for (const { n } of withAcc) {
      const g = ACCIDENTAL_GLYPH[n.accidental!];
      const box = glyphBox(g);
      const ny = y(n.position);
      const span: [number, number] = [ny + box.top - 0.05, ny + box.bottom + 0.05];
      let col = columns.find((c) => c.boxes.every(([a, b]) => span[1] <= a || span[0] >= b));
      if (!col) {
        col = { right: firstRight - columns.length * pitch, boxes: [] };
        columns.push(col);
      }
      col.boxes.push(span);
      accidentals.push({ glyph: g, x: col.right - glyphWidth(g), y: ny });
    }
  }

  // Ledger lines.
  const ledgers: ChordGeom['ledgers'] = [];
  if (staffLines === 5) {
    const ext = STYLE.ledgerExtension;
    const byPos = new Map<number, [number, number]>();
    for (const h of noteheads) {
      const add = (p: number) => {
        const cur = byPos.get(p);
        const span: [number, number] = [h.x - ext, h.x + nhWidth + ext];
        byPos.set(p, cur ? [Math.min(cur[0], span[0]), Math.max(cur[1], span[1])] : span);
      };
      for (let p = -2; p >= h.position; p -= 2) add(p);
      for (let p = 10; p <= h.position; p += 2) add(p);
    }
    for (const [p, [x1, x2]] of byPos) ledgers.push({ y: y(p), x1, x2 });
  }

  // Articulations: notehead side, or stem side when voices share the staff.
  const articulations: ChordGeom['articulations'] = [];
  const stemSide = multiVoice && hasStem(value);
  const above = stemSide ? up : !up;
  let cursorY = above ? Math.min(...positions) * 0.5 - 1.0 : Math.max(...positions) * 0.5 + 1.0;
  if (stemSide && stem) cursorY = above ? stem.yTip - 0.8 : stem.yTip + 0.8;
  for (const a of chord.articulations) {
    if (a === 'fermata') continue;
    const pair = ARTICULATION_GLYPH[a];
    if (!pair) continue;
    const g = above ? pair[0] : pair[1];
    // keep small marks out of staff lines
    let yy = cursorY;
    if (
      yy > 0 &&
      yy < 4 &&
      Math.abs(yy * 2 - Math.round(yy * 2)) < 0.01 &&
      Math.round(yy * 2) % 2 === 0
    )
      yy += above ? -0.5 : 0.5;
    articulations.push({ glyph: g, x: nhWidth / 2 - glyphWidth(g) / 2, y: yy });
    cursorY = yy + (above ? -0.8 : 0.8);
  }
  if (chord.articulations.includes('fermata')) {
    const topY = Math.min(0, Math.min(...positions) * 0.5, stem && up ? stem.yTip : 99) - 1.2;
    articulations.push({
      glyph: 'fermataAbove',
      x: nhWidth / 2 - glyphWidth('fermataAbove') / 2,
      y: topY,
    });
  }

  let left = headsLeft;
  for (const a of accidentals) left = Math.min(left, a.x);
  let right = headsRight;
  if (flag && up) right = Math.max(right, flag.x + glyphWidth(flag.glyph));
  if (flag && !up) right = Math.max(right, flag.x + glyphWidth(flag.glyph) * 0.8);
  for (const d of dots) right = Math.max(right, d.x + 0.4);

  return {
    kind: 'chord',
    noteheads,
    stem,
    flag,
    dots,
    accidentals,
    ledgers,
    articulations,
    noteheadWidth: nhWidth,
    left,
    right,
  };
}

export function restGeometry(rest: NRest, multiVoice: boolean): RestGeom {
  const glyphName = rest.fullMeasure ? 'restWhole' : REST[rest.written.value];
  let ry =
    rest.fullMeasure || rest.written.value === 'whole' ? 1 : rest.written.value === 'breve' ? 1 : 2;
  if (multiVoice) ry += rest.voice % 2 === 0 ? -2 : 2;
  const w = glyphWidth(glyphName);
  const dots: { x: number; y: number }[] = [];
  for (let d = 0; d < rest.written.dots; d++)
    dots.push({ x: w + STYLE.dotGap + d * STYLE.dotSpacing, y: ry - 0.5 });
  return {
    kind: 'rest',
    glyph: glyphName,
    x: 0,
    y: ry,
    dots,
    left: 0,
    right: w + (dots.length ? STYLE.dotGap + dots.length * STYLE.dotSpacing : 0),
    fullMeasure: rest.fullMeasure,
  };
}
