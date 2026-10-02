/**
 * Geometry of single chords and rests, relative to their own origin:
 * x = 0 is the left edge of the "normal side" notehead column, y is measured from the top staff
 * line (y down, staff spaces). Horizontal placement happens later in the measure layout.
 *
 * A chord carries everything attached to it: accidentals, dots, ledger lines, an arpeggio, grace
 * notes before it and a breath mark after it. Articulations, ornaments and tremolo strokes depend
 * on the final stem (beams change stem lengths) and are placed when the chord is drawn
 * (`placeMarks`).
 */
import {
  ARTICULATIONS,
  type Arpeggio,
  type Articulation,
  NOTE_VALUE_BEAMS,
  type NoteValue,
} from '@ailegro-score/core';
import { type GlyphName, anchor, glyphBox, glyphWidth } from '../smufl/glyphs';
import { STYLE } from '../options';
import type { AccidentalKind, NChord, NNote, NRest } from './notation';

export interface NoteheadGeom {
  readonly noteId: string;
  readonly glyph: GlyphName;
  readonly x: number;
  readonly y: number;
  readonly position: number;
  readonly flipped: boolean;
  /** Glyph scale (cue and grace notes are smaller). */
  readonly scale: number;
}

export interface PlacedGlyph {
  readonly glyph: GlyphName;
  readonly x: number;
  readonly y: number;
  readonly scale?: number;
  /** Degrees, clockwise (arpeggio wiggles). */
  readonly rotate?: number;
}

export interface GraceGeom {
  readonly graceId: string;
  readonly noteheads: NoteheadGeom[];
  readonly stem: { x: number; yBase: number; yTip: number } | null;
  readonly flag: PlacedGlyph | null;
  /** Acciaccatura stroke through the stem. */
  readonly slash: { x1: number; y1: number; x2: number; y2: number } | null;
  readonly accidentals: PlacedGlyph[];
  readonly ledgers: { y: number; x1: number; x2: number }[];
}

export interface ChordGeom {
  readonly kind: 'chord';
  readonly noteheads: NoteheadGeom[];
  /** Stem: x is the centre line; yBase at the noteheads, yTip at the free end. */
  stem: { x: number; yBase: number; yTip: number } | null;
  /** Shortest stem that keeps tremolo strokes and flags apart (beams respect it). */
  readonly minStem: number;
  flag: { glyph: GlyphName; x: number; y: number; scale: number } | null;
  readonly dots: { x: number; y: number }[];
  readonly accidentals: { glyph: GlyphName; x: number; y: number; scale: number }[];
  readonly ledgers: { y: number; x1: number; x2: number }[];
  readonly noteheadWidth: number;
  /** 1, or smaller for cue notes. */
  readonly mag: number;
  readonly multiVoice: boolean;
  /** Arpeggio: wiggle column from `top` to `bottom`, its right edge at `x`. */
  readonly arpeggio: { x: number; top: number; bottom: number; dir: Arpeggio } | null;
  readonly graces: GraceGeom[];
  /** Beam polygons joining several grace notes. */
  readonly graceBeams: (readonly number[])[];
  /** Breath mark or caesura after the chord. */
  readonly breath: PlacedGlyph | null;
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

/** Size of cue notes and of grace notes relative to normal notes. */
export const CUE_MAG = 0.7;
export const GRACE_MAG = 0.65;

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

/** [above, below] glyphs of each articulation. */
const ARTICULATION_GLYPH: Record<Articulation, readonly [GlyphName, GlyphName]> = {
  staccato: ['articStaccatoAbove', 'articStaccatoBelow'],
  staccatissimo: ['articStaccatissimoAbove', 'articStaccatissimoBelow'],
  tenuto: ['articTenutoAbove', 'articTenutoBelow'],
  accent: ['articAccentAbove', 'articAccentBelow'],
  marcato: ['articMarcatoAbove', 'articMarcatoBelow'],
  harmonic: ['stringsHarmonic', 'stringsHarmonic'],
  stopped: ['brassMuteClosed', 'brassMuteClosed'],
  open: ['brassMuteOpen', 'brassMuteOpen'],
  snapPizzicato: ['pluckedSnapPizzicatoAbove', 'pluckedSnapPizzicatoBelow'],
  upBow: ['stringsUpBow', 'stringsUpBow'],
  downBow: ['stringsDownBow', 'stringsDownBow'],
  fermata: ['fermataAbove', 'fermataBelow'],
  fermataShort: ['fermataShortAbove', 'fermataShortBelow'],
  fermataLong: ['fermataLongAbove', 'fermataLongBelow'],
};

/** Articulations placed on the notehead side; the others go above the staff. */
const NOTE_SIDE = new Set<Articulation>([
  'staccato',
  'staccatissimo',
  'tenuto',
  'accent',
  'marcato',
]);
const FERMATAS = new Set<Articulation>(['fermata', 'fermataShort', 'fermataLong']);

export const ORNAMENT_GLYPH = {
  trill: 'ornamentTrill',
  shortTrill: 'ornamentShortTrill',
  mordent: 'ornamentMordent',
  turn: 'ornamentTurn',
  invertedTurn: 'ornamentTurnInverted',
} as const satisfies Record<string, GlyphName>;

const TREMOLO_GLYPH: GlyphName[] = ['tremolo1', 'tremolo2', 'tremolo3', 'tremolo4'];

/** Arpeggio wiggle: thickness of the column and length of one segment. */
const ARPEGGIO_WIDTH = 0.48;
const ARPEGGIO_SEGMENT = 1.02;

const y = (position: number) => position * 0.5;

export function hasStem(value: NoteValue): boolean {
  return value !== 'whole' && value !== 'breve';
}

/** Ledger lines for noteheads outside a five-line staff. */
function ledgersFor(heads: readonly NoteheadGeom[], width: number, ext: number) {
  const byPos = new Map<number, [number, number]>();
  for (const h of heads) {
    const add = (p: number) => {
      const cur = byPos.get(p);
      const span: [number, number] = [h.x - ext, h.x + width + ext];
      byPos.set(p, cur ? [Math.min(cur[0], span[0]), Math.max(cur[1], span[1])] : span);
    };
    for (let p = -2; p >= h.position; p -= 2) add(p);
    for (let p = 10; p <= h.position; p += 2) add(p);
  }
  return [...byPos].map(([p, [x1, x2]]) => ({ y: y(p), x1, x2 }));
}

/** Accidental columns to the left of `right`, top to bottom. */
function accidentalColumns(
  notes: readonly NNote[],
  right: number,
  scale: number,
): { glyph: GlyphName; x: number; y: number; scale: number }[] {
  const out: { glyph: GlyphName; x: number; y: number; scale: number }[] = [];
  const withAcc = notes.filter((n) => n.accidental).sort((a, b) => a.position - b.position);
  if (!withAcc.length) return out;
  const columns: { right: number; boxes: [number, number][] }[] = [];
  const pitch =
    Math.max(...withAcc.map((n) => glyphWidth(ACCIDENTAL_GLYPH[n.accidental!], scale))) +
    0.12 * scale;
  for (const n of withAcc) {
    const g = ACCIDENTAL_GLYPH[n.accidental!];
    const box = glyphBox(g, scale);
    const ny = y(n.position);
    const span: [number, number] = [ny + box.top - 0.05, ny + box.bottom + 0.05];
    let col = columns.find((c) => c.boxes.every(([a, b]) => span[1] <= a || span[0] >= b));
    if (!col) {
      col = { right: right - columns.length * pitch, boxes: [] };
      columns.push(col);
    }
    col.boxes.push(span);
    out.push({ glyph: g, x: col.right - glyphWidth(g, scale), y: ny, scale });
  }
  return out;
}

/** Noteheads of a chord, seconds moved to the other side of the stem. */
function noteheadsFor(
  notes: readonly NNote[],
  head: GlyphName,
  up: boolean,
  stemmed: boolean,
  scale: number,
): NoteheadGeom[] {
  const nhWidth = glyphWidth(head, scale);
  const order = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (up || !stemmed ? b.n.position - a.n.position : a.n.position - b.n.position));
  const flipped = new Array<boolean>(notes.length).fill(false);
  let prevPos: number | null = null;
  let prevFlipped = false;
  for (const { n, i } of order) {
    const adjacent: boolean = prevPos !== null && Math.abs(prevPos - n.position) === 1;
    flipped[i] = adjacent && !prevFlipped;
    prevPos = n.position;
    prevFlipped = flipped[i]!;
  }
  const flipOffset = nhWidth - STYLE.stemWidth * scale;
  return notes.map((n, i) => ({
    noteId: n.noteId,
    glyph: head,
    x: flipped[i] ? (up || !stemmed ? flipOffset : -flipOffset) : 0,
    y: y(n.position),
    position: n.position,
    flipped: flipped[i]!,
    scale,
  }));
}

export function chordGeometry(chord: NChord, multiVoice: boolean, staffLines = 5): ChordGeom {
  const value = chord.written.value;
  const mag = chord.cue ? CUE_MAG : 1;
  const head = NOTEHEAD[value];
  const nhWidth = glyphWidth(head, mag);
  const up = chord.stem === 'up';
  const positions = chord.notes.map((n) => n.position);
  const stemmed = hasStem(value);
  const noteheads = noteheadsFor(chord.notes, head, up, stemmed, mag);
  const headsLeft = Math.min(...noteheads.map((h) => h.x));
  const headsRight = Math.max(...noteheads.map((h) => h.x + nhWidth));

  // Stem.
  let stem: ChordGeom['stem'] = null;
  let flag: ChordGeom['flag'] = null;
  const beams = NOTE_VALUE_BEAMS[value];
  const strokes = Math.min(4, chord.tremolo);
  let minStem = 0;
  if (stemmed) {
    const top = Math.min(...positions);
    const bottom = Math.max(...positions);
    const extra = beams >= 3 ? (beams - 2) * 0.5 : 0;
    let length = (STYLE.stemLength + extra) * mag;
    if (strokes) {
      // room for the strokes between the notes and the flag or beam
      const strokesHeight = glyphBox(TREMOLO_GLYPH[strokes - 1]!).bottom * 2;
      minStem = 1.0 + strokesHeight + 0.5 + (beams ? 0.4 + beams * 0.75 : 0);
      length = Math.max(length, minStem);
    }
    if (up) {
      const a = anchor(head, 'stemUpSE', mag) ?? { x: nhWidth, y: -0.168 * mag };
      const x = a.x - (STYLE.stemWidth * mag) / 2;
      const yBase = y(bottom) + a.y;
      // Stems of notes far below the staff reach at least the middle line.
      const yTip = Math.min(y(top) - length, chord.cue ? 99 : 2);
      stem = { x, yBase, yTip };
    } else {
      const a = anchor(head, 'stemDownNW', mag) ?? { x: 0, y: 0.168 * mag };
      const x = a.x + (STYLE.stemWidth * mag) / 2;
      const yBase = y(top) + a.y;
      const yTip = Math.max(y(bottom) + length, chord.cue ? -99 : 2);
      stem = { x, yBase, yTip };
    }
    if (beams > 0 && chord.beam === null) {
      const glyphName = (up ? FLAG_UP : FLAG_DOWN)[Math.min(beams, 5) - 1]!;
      flag = {
        glyph: glyphName,
        x: stem.x - (STYLE.stemWidth * mag) / 2,
        y: stem.yTip,
        scale: mag,
      };
    }
  }

  // Dots.
  const dots: { x: number; y: number }[] = [];
  if (chord.written.dots > 0) {
    const used = new Set<number>();
    const dx0 =
      headsRight + STYLE.dotGap * mag + (flag && up ? glyphWidth(flag.glyph, mag) * 0.75 : 0);
    for (const n of [...chord.notes].sort((a, b) => a.position - b.position)) {
      let pos = n.position % 2 === 0 ? n.position - 1 : n.position;
      while (used.has(pos)) pos += 2;
      used.add(pos);
      for (let d = 0; d < chord.written.dots; d++)
        dots.push({ x: dx0 + d * STYLE.dotSpacing * mag, y: y(pos) });
    }
  }

  // Accidentals (columns, top to bottom).
  const accidentals = accidentalColumns(chord.notes, headsLeft - STYLE.accidentalGap * mag, mag);

  // Ledger lines.
  const ledgers =
    staffLines === 5 ? ledgersFor(noteheads, nhWidth, STYLE.ledgerExtension * mag) : [];

  let left = headsLeft;
  for (const a of accidentals) left = Math.min(left, a.x);
  let right = headsRight;
  if (flag && up) right = Math.max(right, flag.x + glyphWidth(flag.glyph, mag));
  if (flag && !up) right = Math.max(right, flag.x + glyphWidth(flag.glyph, mag) * 0.8);
  for (const d of dots) right = Math.max(right, d.x + 0.4 * mag);

  // Arpeggio: a wiggly line left of the accidentals.
  let arpeggio: ChordGeom['arpeggio'] = null;
  if (chord.arpeggio) {
    const x = left - 0.45;
    arpeggio = {
      x,
      top: y(Math.min(...positions)) - 0.6,
      bottom: y(Math.max(...positions)) + 0.6,
      dir: chord.arpeggio,
    };
    left = x - ARPEGGIO_WIDTH - 0.1;
  }

  // Grace notes, right to left from the chord's left edge.
  const graces: GraceGeom[] = [];
  const graceBeams: (readonly number[])[] = [];
  if (chord.graces.length) {
    const gm = GRACE_MAG * mag;
    const graceUp = !(multiVoice && chord.voice % 2 === 1);
    // clear of the principal's ledger lines and a stem on its left
    let edge = left - 0.65;
    const built: GraceGeom[] = [];
    const levels = chord.graces.map((g) => NOTE_VALUE_BEAMS[g.value]);
    const beamable =
      chord.graces.length > 1 && chord.graces.every((g, k) => hasStem(g.value) && levels[k]! > 0);
    for (let k = chord.graces.length - 1; k >= 0; k--) {
      const g = chord.graces[k]!;
      const gh = NOTEHEAD[g.value];
      const gw = glyphWidth(gh, gm);
      const gStemmed = hasStem(g.value);
      // a flag on an up-stem sticks out to the right of the notehead
      if (!beamable && graceUp && gStemmed && levels[k]! > 0)
        edge -= glyphWidth(FLAG_UP[Math.min(levels[k]!, 5) - 1]!, gm) * 0.75;
      // provisional heads at x = 0, then shifted so the chord ends at `edge`
      const heads0 = noteheadsFor(g.notes, gh, graceUp, gStemmed, gm);
      const width = Math.max(...heads0.map((h) => h.x + gw)) - Math.min(...heads0.map((h) => h.x));
      const dx = edge - width - Math.min(...heads0.map((h) => h.x));
      const heads = heads0.map((h) => ({ ...h, x: h.x + dx }));
      const gLeft = Math.min(...heads.map((h) => h.x));
      const accs = accidentalColumns(g.notes, gLeft - 0.12, gm);
      const ps = g.notes.map((n) => n.position);
      let gstem: GraceGeom['stem'] = null;
      if (gStemmed) {
        const len = STYLE.stemLength * gm + (NOTE_VALUE_BEAMS[g.value] >= 2 ? 0.4 : 0);
        if (graceUp) {
          const a = anchor(gh, 'stemUpSE', gm) ?? { x: gw, y: -0.1 };
          gstem = {
            x: dx + a.x - (STYLE.stemWidth * gm) / 2,
            yBase: y(Math.max(...ps)) + a.y,
            yTip: y(Math.min(...ps)) - len,
          };
        } else {
          const a = anchor(gh, 'stemDownNW', gm) ?? { x: 0, y: 0.1 };
          gstem = {
            x: dx + a.x + (STYLE.stemWidth * gm) / 2,
            yBase: y(Math.min(...ps)) + a.y,
            yTip: y(Math.max(...ps)) + len,
          };
        }
      }
      built.unshift({
        graceId: g.graceId,
        noteheads: heads,
        stem: gstem,
        flag: null,
        slash: null,
        accidentals: accs,
        ledgers: staffLines === 5 ? ledgersFor(heads, gw, STYLE.ledgerExtension * gm) : [],
      });
      edge = Math.min(gLeft, ...accs.map((a) => a.x)) - 0.25;
    }
    // flags or beams, and the acciaccatura stroke
    const dir = graceUp ? -1 : 1;
    if (beamable) {
      const tipY = graceUp
        ? Math.min(...built.map((g) => g.stem!.yTip))
        : Math.max(...built.map((g) => g.stem!.yTip));
      const x0 = built[0]!.stem!.x - (STYLE.stemWidth * gm) / 2;
      const x1 = built[built.length - 1]!.stem!.x + (STYLE.stemWidth * gm) / 2;
      const t = STYLE.beamThickness * gm;
      const step = (STYLE.beamThickness + STYLE.beamSpacing) * gm;
      for (let level = 0; level < Math.min(...levels); level++) {
        const yb = tipY - dir * level * step;
        graceBeams.push([x0, yb, x1, yb, x1, yb - dir * t, x0, yb - dir * t]);
      }
      built.forEach((g, k) => (built[k] = { ...g, stem: { ...g.stem!, yTip: tipY } }));
    }
    built.forEach((g, k) => {
      const grace = chord.graces[k]!;
      let flagGlyph: PlacedGlyph | null = null;
      if (g.stem && !beamable && levels[k]! > 0) {
        flagGlyph = {
          glyph: (graceUp ? FLAG_UP : FLAG_DOWN)[Math.min(levels[k]!, 5) - 1]!,
          x: g.stem.x - (STYLE.stemWidth * gm) / 2,
          y: g.stem.yTip,
          scale: gm,
        };
      }
      let slash: GraceGeom['slash'] = null;
      if (grace.slash && g.stem && (!beamable || k === 0)) {
        const cy = g.stem.yTip - dir * 1.0 * gm;
        slash = {
          x1: g.stem.x - 0.55 * gm,
          y1: cy - dir * 0.55 * gm,
          x2: g.stem.x + 0.75 * gm,
          y2: cy + dir * 0.55 * gm,
        };
      }
      built[k] = { ...g, flag: flagGlyph, slash };
    });
    graces.push(...built);
    left = Math.min(left, edge);
  }

  // Breath mark or caesura after the chord.
  let breath: PlacedGlyph | null = null;
  if (chord.breath) {
    const glyphName: GlyphName = chord.breath === 'caesura' ? 'caesura' : 'breathMarkComma';
    breath = { glyph: glyphName, x: right + 0.45, y: chord.breath === 'caesura' ? 1.0 : -0.6 };
    right = breath.x + glyphWidth(glyphName) + 0.2;
  }

  return {
    kind: 'chord',
    noteheads,
    stem,
    minStem,
    flag,
    dots,
    accidentals,
    ledgers,
    noteheadWidth: nhWidth,
    mag,
    multiVoice,
    arpeggio,
    graces,
    graceBeams,
    breath,
    left,
    right,
  };
}

/** Glyphs of an arpeggio: wiggle segments (rotated), an arrowhead at the end for up/down. */
export function arpeggioGlyphs(a: NonNullable<ChordGeom['arpeggio']>, x0: number): PlacedGlyph[] {
  const out: PlacedGlyph[] = [];
  const length = a.bottom - a.top;
  const arrow = a.dir !== 'normal';
  const arrowLength = arrow ? 2.0 : 0;
  const n = Math.max(1, Math.ceil((length - arrowLength) / ARPEGGIO_SEGMENT));
  if (a.dir === 'down') {
    // drawn downwards from the top: rotated clockwise, arrow at the bottom
    const x = x0 + a.x - ARPEGGIO_WIDTH;
    for (let k = 0; k < n; k++)
      out.push({ glyph: 'wiggleArpeggiatoUp', x, y: a.top + k * ARPEGGIO_SEGMENT, rotate: 90 });
    out.push({ glyph: 'wiggleArpeggiatoUpArrow', x, y: a.top + n * ARPEGGIO_SEGMENT, rotate: 90 });
  } else {
    const x = x0 + a.x;
    for (let k = 0; k < n; k++)
      out.push({ glyph: 'wiggleArpeggiatoUp', x, y: a.bottom - k * ARPEGGIO_SEGMENT, rotate: -90 });
    if (arrow)
      out.push({
        glyph: 'wiggleArpeggiatoUpArrow',
        x,
        y: a.bottom - n * ARPEGGIO_SEGMENT,
        rotate: -90,
      });
  }
  return out;
}

/**
 * Articulations, ornaments and tremolo strokes of a chord whose stem is final (after beaming),
 * relative to the chord origin.
 */
export function placeMarks(chord: NChord, geom: ChordGeom): PlacedGlyph[] {
  const out: PlacedGlyph[] = [];
  const mag = geom.mag;
  const up = chord.stem === 'up';
  const positions = geom.noteheads.map((h) => h.position);
  const topY = y(Math.min(...positions));
  const bottomY = y(Math.max(...positions));
  const stemmed = hasStem(chord.written.value);
  const stem = geom.stem;
  const centre = geom.noteheadWidth / 2;
  const put = (g: GlyphName, above: boolean, cursor: number): number => {
    const box = glyphBox(g, mag);
    const oy = above ? cursor - box.bottom : cursor - box.top;
    out.push({ glyph: g, x: centre - (box.left + box.right) / 2, y: oy, scale: mag });
    return above ? oy + box.top - 0.25 : oy + box.bottom + 0.25;
  };

  // notehead side (stem side when voices share the staff)
  const stemSide = geom.multiVoice && stemmed;
  const sideAbove = stemSide ? up : !up;
  let cursor = sideAbove ? topY - 0.75 : bottomY + 0.75;
  if (stemSide && stem) cursor = sideAbove ? stem.yTip - 0.5 : stem.yTip + 0.5;
  // stacking order, whatever order a file lists them in
  const arts = [...chord.articulations].sort(
    (a, b) => ARTICULATIONS.indexOf(a) - ARTICULATIONS.indexOf(b),
  );
  for (const a of arts) {
    if (!NOTE_SIDE.has(a)) continue;
    const g = ARTICULATION_GLYPH[a][sideAbove ? 0 : 1];
    const box = glyphBox(g, mag);
    let oy = sideAbove ? cursor - box.bottom : cursor - box.top;
    // small marks inside the staff sit in a space, never on a line
    const c = oy + (box.top + box.bottom) / 2;
    if (box.bottom - box.top < 0.8 && c > 0 && c < 4) {
      const snapped = sideAbove ? Math.floor(c - 0.5) + 0.5 : Math.ceil(c - 0.5) + 0.5;
      oy += snapped - c;
    }
    out.push({ glyph: g, x: centre - (box.left + box.right) / 2, y: oy, scale: mag });
    cursor = sideAbove ? oy + box.top - 0.2 : oy + box.bottom + 0.2;
  }

  // marks above the staff (below it for the lower voice of a shared staff)
  const above = !(geom.multiVoice && chord.voice % 2 === 1);
  let edge = above
    ? Math.min(-0.6, topY - 0.9, stem && up ? stem.yTip - 0.5 : Infinity)
    : Math.max(4.6, bottomY + 0.9, stem && !up ? stem.yTip + 0.5 : -Infinity);
  if (sideAbove === above && arts.some((a) => NOTE_SIDE.has(a)))
    edge = above ? Math.min(edge, cursor - 0.1) : Math.max(edge, cursor + 0.1);
  const outer: GlyphName[] = [];
  for (const a of arts)
    if (!NOTE_SIDE.has(a) && !FERMATAS.has(a)) outer.push(ARTICULATION_GLYPH[a][above ? 0 : 1]);
  if (chord.ornament) outer.push(ORNAMENT_GLYPH[chord.ornament]);
  for (const a of arts) if (FERMATAS.has(a)) outer.push(ARTICULATION_GLYPH[a][above ? 0 : 1]);
  for (const g of outer) edge = put(g, above, edge) + (above ? -0.1 : 0.1);

  // tremolo strokes across the stem (above or below a stemless note)
  if (chord.tremolo) {
    const g = TREMOLO_GLYPH[Math.min(4, chord.tremolo) - 1]!;
    const half = glyphBox(g, mag).bottom;
    if (stem) {
      const dir = up ? -1 : 1;
      const from = up ? topY : bottomY;
      out.push({ glyph: g, x: stem.x, y: from + dir * (1.0 * mag + half), scale: mag });
    } else {
      const dir = up ? -1 : 1;
      const from = up ? topY : bottomY;
      out.push({ glyph: g, x: centre, y: from + dir * (1.2 + half), scale: mag });
    }
  }
  return out;
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
