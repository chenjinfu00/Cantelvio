/** Clefs, key signatures and time signatures: glyph placement and widths. */
import type { ClefType, KeySignature, TimeSignature } from '@ailegro-score/core';
import { type Graphic } from '../graphics';
import { type GlyphName, DIGIT_GLYPHS, glyphWidth } from '../smufl/glyphs';

interface ClefDraw {
  readonly glyph: GlyphName;
  /** y of the glyph origin relative to the top staff line. */
  readonly y: number;
}

const CLEF_DRAW: Record<ClefType, ClefDraw> = {
  treble: { glyph: 'gClef', y: 3 },
  treble8vb: { glyph: 'gClef8vb', y: 3 },
  treble8va: { glyph: 'gClef8va', y: 3 },
  bass: { glyph: 'fClef', y: 1 },
  bass8vb: { glyph: 'fClef8vb', y: 1 },
  alto: { glyph: 'cClef', y: 2 },
  tenor: { glyph: 'cClef', y: 1 },
  soprano: { glyph: 'cClef', y: 4 },
  percussion: { glyph: 'unpitchedPercussionClef1', y: 2 },
};

export const CHANGE_CLEF_SCALE = 0.75;

export function clefWidth(clef: ClefType, scale = 1): number {
  return glyphWidth(CLEF_DRAW[clef].glyph, scale);
}

export function drawClef(clef: ClefType, x: number, scale = 1, cls = 'clef'): Graphic {
  const d = CLEF_DRAW[clef];
  return { kind: 'glyph', name: d.glyph, x, y: d.y, ...(scale !== 1 ? { scale } : {}), cls };
}

// Staff positions (0 = top line, half-space steps down) of key-signature accidentals.
const SHARPS_TREBLE = [0, 3, -1, 2, 5, 1, 4];
const FLATS_TREBLE = [4, 1, 5, 2, 6, 3, 7];
const KEY_POSITIONS: Record<ClefType, { sharps: number[]; flats: number[] }> = {
  treble: { sharps: SHARPS_TREBLE, flats: FLATS_TREBLE },
  treble8vb: { sharps: SHARPS_TREBLE, flats: FLATS_TREBLE },
  treble8va: { sharps: SHARPS_TREBLE, flats: FLATS_TREBLE },
  bass: { sharps: SHARPS_TREBLE.map((p) => p + 2), flats: FLATS_TREBLE.map((p) => p + 2) },
  bass8vb: { sharps: SHARPS_TREBLE.map((p) => p + 2), flats: FLATS_TREBLE.map((p) => p + 2) },
  alto: { sharps: SHARPS_TREBLE.map((p) => p + 1), flats: FLATS_TREBLE.map((p) => p + 1) },
  tenor: { sharps: [6, 2, 5, 1, 4, 0, 3], flats: FLATS_TREBLE.map((p) => p - 1) },
  soprano: { sharps: SHARPS_TREBLE.map((p) => p + 2), flats: FLATS_TREBLE.map((p) => p + 2) },
  percussion: { sharps: [], flats: [] },
};

interface KeyGlyph {
  glyph: GlyphName;
  position: number;
}

/** Glyphs for a key signature, preceded by naturals cancelling the previous key where needed. */
export function keySignatureGlyphs(
  key: KeySignature,
  clef: ClefType,
  previous?: KeySignature,
): KeyGlyph[] {
  const pos = KEY_POSITIONS[clef];
  const out: KeyGlyph[] = [];
  if (previous && previous.fifths !== key.fifths) {
    const prevSharps = previous.fifths > 0;
    const sameSide = key.fifths !== 0 && key.fifths > 0 === prevSharps;
    const keep = sameSide ? Math.abs(key.fifths) : 0;
    const count = Math.abs(previous.fifths);
    for (let i = keep; i < count; i++) {
      const p = prevSharps ? pos.sharps[i] : pos.flats[i];
      if (p !== undefined) out.push({ glyph: 'accidentalNatural', position: p });
    }
  }
  const n = Math.min(7, Math.abs(key.fifths));
  for (let i = 0; i < n; i++) {
    const p = key.fifths > 0 ? pos.sharps[i] : pos.flats[i];
    if (p !== undefined)
      out.push({ glyph: key.fifths > 0 ? 'accidentalSharp' : 'accidentalFlat', position: p });
  }
  return out;
}

export function keySignatureWidth(glyphs: readonly KeyGlyph[]): number {
  return glyphs.reduce((w, g) => w + glyphWidth(g.glyph) + 0.06, 0);
}

export function drawKeySignature(glyphs: readonly KeyGlyph[], x: number, cls = 'key'): Graphic[] {
  const out: Graphic[] = [];
  let cx = x;
  for (const g of glyphs) {
    out.push({ kind: 'glyph', name: g.glyph, x: cx, y: g.position * 0.5, cls });
    cx += glyphWidth(g.glyph) + 0.06;
  }
  return out;
}

function digits(n: number): GlyphName[] {
  return String(n)
    .split('')
    .map((d) => DIGIT_GLYPHS[Number(d)]!);
}

export function timeSignatureWidth(ts: TimeSignature): number {
  if (ts.symbol === 'common') return glyphWidth('timeSigCommon');
  if (ts.symbol === 'cut') return glyphWidth('timeSigCutCommon');
  const w = (ds: GlyphName[]) => ds.reduce((s, g) => s + glyphWidth(g), 0);
  return Math.max(w(digits(ts.beats)), w(digits(ts.beatType)));
}

export function drawTimeSignature(ts: TimeSignature, x: number, cls = 'time'): Graphic[] {
  if (ts.symbol === 'common' || ts.symbol === 'cut') {
    return [
      {
        kind: 'glyph',
        name: ts.symbol === 'common' ? 'timeSigCommon' : 'timeSigCutCommon',
        x,
        y: 2,
        cls,
      },
    ];
  }
  const total = timeSignatureWidth(ts);
  const row = (n: number, y: number): Graphic[] => {
    const ds = digits(n);
    const w = ds.reduce((s, g) => s + glyphWidth(g), 0);
    let cx = x + (total - w) / 2;
    return ds.map((g) => {
      const gr: Graphic = { kind: 'glyph', name: g, x: cx, y, cls };
      cx += glyphWidth(g);
      return gr;
    });
  };
  return [...row(ts.beats, 1), ...row(ts.beatType, 3)];
}
