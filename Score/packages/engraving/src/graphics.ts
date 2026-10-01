/**
 * The engraver's output: positioned graphics in STAFF SPACES (sp), y pointing down.
 * Renderers (SVG now; canvas/PDF later) only translate these primitives.
 */
import type { GlyphName } from './smufl/glyphs';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Base {
  /** CSS class for styling (e.g. "note", "ghost", "stem"). */
  readonly cls?: string;
  /** Element reference for hit-testing: "e:<eventId>", "n:<noteId>", "rest:...", "m:..." */
  readonly ref?: string;
}

export interface GlyphGraphic extends Base {
  readonly kind: 'glyph';
  readonly name: GlyphName;
  readonly x: number;
  readonly y: number;
  readonly scale?: number;
  /** Additional vertical scale (braces). */
  readonly scaleY?: number;
}

export interface LineGraphic extends Base {
  readonly kind: 'line';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly cap?: 'butt' | 'round' | 'square';
  readonly dash?: readonly number[];
}

export interface RectGraphic extends Base {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Stroke width; absent = filled. */
  readonly stroke?: number;
}

export interface PolygonGraphic extends Base {
  readonly kind: 'polygon';
  readonly points: readonly number[];
}

export interface PathGraphic extends Base {
  readonly kind: 'path';
  readonly d: string;
  /** Stroke width; absent = filled. */
  readonly stroke?: number;
}

export interface TextGraphic extends Base {
  readonly kind: 'text';
  readonly x: number;
  readonly y: number;
  readonly text: string;
  /** Font size in staff spaces. */
  readonly size: number;
  readonly family: 'serif' | 'sans';
  readonly weight?: 'normal' | 'bold';
  readonly italic?: boolean;
  readonly anchor?: 'start' | 'middle' | 'end';
}

export interface GroupGraphic extends Base {
  readonly kind: 'group';
  readonly children: readonly Graphic[];
}

export type Graphic =
  | GlyphGraphic
  | LineGraphic
  | RectGraphic
  | PolygonGraphic
  | PathGraphic
  | TextGraphic
  | GroupGraphic;

export function group(children: Graphic[], cls?: string, ref?: string): GroupGraphic {
  return { kind: 'group', children, ...(cls ? { cls } : {}), ...(ref ? { ref } : {}) };
}

/** Translate graphics by (dx, dy) — returns new objects. */
export function translate(gs: readonly Graphic[], dx: number, dy: number): Graphic[] {
  if (dx === 0 && dy === 0) return gs.slice();
  return gs.map((g) => translateOne(g, dx, dy));
}

function translateOne(g: Graphic, dx: number, dy: number): Graphic {
  switch (g.kind) {
    case 'glyph':
    case 'text':
    case 'rect':
      return { ...g, x: g.x + dx, y: g.y + dy };
    case 'line':
      return { ...g, x1: g.x1 + dx, x2: g.x2 + dx, y1: g.y1 + dy, y2: g.y2 + dy };
    case 'polygon':
      return { ...g, points: g.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) };
    case 'path':
      return { ...g, d: translatePath(g.d, dx, dy) };
    case 'group':
      return { ...g, children: g.children.map((c) => translateOne(c, dx, dy)) };
  }
}

/** Translate an absolute-command path ("M x y C ... Z"). Only M/L/C/Q/Z absolute commands are produced by the engraver. */
function translatePath(d: string, dx: number, dy: number): string {
  let i = 0;
  return d.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, (num) => {
    const v = Number(num) + (i++ % 2 === 0 ? dx : dy);
    return fmt(v);
  });
}

export function fmt(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}
