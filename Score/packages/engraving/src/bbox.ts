import type { Box, Graphic } from './graphics';
import { approximateTextWidth } from './options';
import { glyphBox } from './smufl/glyphs';

export interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const emptyExtent = (): Extent => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
});

function grow(e: Extent, x0: number, y0: number, x1: number, y1: number): void {
  if (x0 < e.minX) e.minX = x0;
  if (y0 < e.minY) e.minY = y0;
  if (x1 > e.maxX) e.maxX = x1;
  if (y1 > e.maxY) e.maxY = y1;
}

/** Approximate bounding extent of graphics (y down). */
export function extentOf(gs: readonly Graphic[], into: Extent = emptyExtent()): Extent {
  for (const g of gs) {
    switch (g.kind) {
      case 'glyph': {
        const s = g.scale ?? 1;
        const b = glyphBox(g.name, s);
        const sy = g.scaleY ?? 1;
        grow(into, g.x + b.left, g.y + b.top * sy, g.x + b.right, g.y + b.bottom * sy);
        break;
      }
      case 'line': {
        const h = g.width / 2;
        grow(
          into,
          Math.min(g.x1, g.x2) - h,
          Math.min(g.y1, g.y2) - h,
          Math.max(g.x1, g.x2) + h,
          Math.max(g.y1, g.y2) + h,
        );
        break;
      }
      case 'rect':
        grow(into, g.x, g.y, g.x + g.w, g.y + g.h);
        break;
      case 'polygon':
        for (let i = 0; i + 1 < g.points.length; i += 2)
          grow(into, g.points[i]!, g.points[i + 1]!, g.points[i]!, g.points[i + 1]!);
        break;
      case 'path': {
        const nums = g.d.match(/-?\d*\.?\d+(?:e-?\d+)?/g)?.map(Number) ?? [];
        for (let i = 0; i + 1 < nums.length; i += 2)
          grow(into, nums[i]!, nums[i + 1]!, nums[i]!, nums[i + 1]!);
        break;
      }
      case 'text': {
        const w = approximateTextWidth(g.text, g.size, g.family, g.weight);
        const x0 = g.anchor === 'middle' ? g.x - w / 2 : g.anchor === 'end' ? g.x - w : g.x;
        grow(into, x0, g.y - g.size * 0.75, x0 + w, g.y + g.size * 0.25);
        break;
      }
      case 'group':
        extentOf(g.children, into);
        break;
    }
  }
  return into;
}

export function boxOf(gs: readonly Graphic[]): Box | null {
  const e = extentOf(gs);
  if (!Number.isFinite(e.minX)) return null;
  return { x: e.minX, y: e.minY, w: e.maxX - e.minX, h: e.maxY - e.minY };
}
