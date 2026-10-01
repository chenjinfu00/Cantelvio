import { ENGRAVING_DEFAULTS, GLYPH_DATA } from './bravura.generated';

export type GlyphName = keyof typeof GLYPH_DATA;

export interface GlyphInfo {
  readonly cp: number;
  /** SMuFL bbox [x0, y0, x1, y1], y up, staff spaces. */
  readonly bbox: readonly [number, number, number, number];
  readonly anchors?: Readonly<Record<string, readonly [number, number]>>;
  readonly advance?: number;
  readonly path: string;
}

export const ENGRAVING = ENGRAVING_DEFAULTS;

export function glyph(name: GlyphName): GlyphInfo {
  return GLYPH_DATA[name] as unknown as GlyphInfo;
}

/** Glyph extents in y-DOWN staff-space coordinates relative to its origin. */
export function glyphBox(
  name: GlyphName,
  scale = 1,
): { left: number; right: number; top: number; bottom: number; width: number } {
  const [x0, y0, x1, y1] = glyph(name).bbox;
  return {
    left: x0 * scale,
    right: x1 * scale,
    top: -y1 * scale,
    bottom: -y0 * scale,
    width: (x1 - x0) * scale,
  };
}

export function glyphWidth(name: GlyphName, scale = 1): number {
  const g = glyph(name);
  return (g.advance ?? g.bbox[2] - g.bbox[0]) * scale;
}

/** Anchor in y-DOWN coordinates, or undefined. */
export function anchor(
  name: GlyphName,
  key: string,
  scale = 1,
): { x: number; y: number } | undefined {
  const a = glyph(name).anchors?.[key];
  return a ? { x: a[0] * scale, y: -a[1] * scale } : undefined;
}

export const DIGIT_GLYPHS = [
  'timeSig0',
  'timeSig1',
  'timeSig2',
  'timeSig3',
  'timeSig4',
  'timeSig5',
  'timeSig6',
  'timeSig7',
  'timeSig8',
  'timeSig9',
] as const;
export const TUPLET_DIGITS = [
  'tuplet0',
  'tuplet1',
  'tuplet2',
  'tuplet3',
  'tuplet4',
  'tuplet5',
  'tuplet6',
  'tuplet7',
  'tuplet8',
  'tuplet9',
] as const;
