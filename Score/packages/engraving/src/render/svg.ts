/**
 * SVG renderer: pages of graphics -> standalone SVG strings. Glyph outlines are embedded once per
 * page in <defs> and instanced with <use>, so output needs no music font and is identical in
 * every browser, in Node and in exported files. Colour is `currentColor` throughout, so the
 * editor can recolour selections and AI suggestions with CSS alone.
 */
import { type Graphic, fmt } from '../graphics';
import type { PageLayout, ScoreLayout } from '../layout/engrave';
import { type GlyphName, glyph } from '../smufl/glyphs';

export interface SvgOptions {
  /** Size attributes: 'mm' for print-true pages, 'none' to size with CSS (editor). */
  readonly size?: 'mm' | 'none';
  /** Fill the page background (white) — off for transparent overlays. */
  readonly background?: boolean;
  /** Embed a <style> block with default class colours (ghost notes, selection). */
  readonly embedStyle?: boolean;
  readonly idPrefix?: string;
}

export const FONT_STACK: Record<'serif' | 'sans', string> = {
  serif: "'Times New Roman', 'Noto Serif', 'Songti SC', 'Noto Serif CJK SC', serif",
  sans: "'Helvetica Neue', Arial, 'PingFang SC', 'Noto Sans CJK SC', sans-serif",
};

export const DEFAULT_SVG_STYLE = `
.ghost{color:#3b82f6;opacity:.75}
.approx{color:#c2410c}
.sel{color:#1d6bf3}
`;

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attrs(g: { cls?: string; ref?: string }): string {
  return `${g.cls ? ` class="${esc(g.cls)}"` : ''}${g.ref ? ` data-ref="${esc(g.ref)}"` : ''}`;
}

function collectGlyphs(gs: readonly Graphic[], into: Set<GlyphName>): void {
  for (const g of gs) {
    if (g.kind === 'glyph') into.add(g.name);
    else if (g.kind === 'group') collectGlyphs(g.children, into);
  }
}

function renderOne(g: Graphic, prefix: string, out: string[]): void {
  switch (g.kind) {
    case 'glyph': {
      const sx = g.scale ?? 1;
      const sy = (g.scaleY ?? 1) * sx;
      if (sx === 1 && sy === 1 && !g.rotate) {
        out.push(`<use href="#${prefix}${g.name}" x="${fmt(g.x)}" y="${fmt(g.y)}"${attrs(g)}/>`);
      } else {
        const rot = g.rotate ? ` rotate(${fmt(g.rotate)})` : '';
        const scale = sx === 1 && sy === 1 ? '' : ` scale(${fmt(sx)} ${fmt(sy)})`;
        out.push(
          `<use href="#${prefix}${g.name}" transform="translate(${fmt(g.x)} ${fmt(g.y)})${rot}${scale}"${attrs(g)}/>`,
        );
      }
      break;
    }
    case 'line':
      out.push(
        `<line x1="${fmt(g.x1)}" y1="${fmt(g.y1)}" x2="${fmt(g.x2)}" y2="${fmt(g.y2)}" stroke="currentColor" stroke-width="${fmt(g.width)}"${g.cap ? ` stroke-linecap="${g.cap}"` : ''}${g.dash ? ` stroke-dasharray="${g.dash.map(fmt).join(' ')}"` : ''}${attrs(g)}/>`,
      );
      break;
    case 'rect':
      out.push(
        g.stroke
          ? `<rect x="${fmt(g.x)}" y="${fmt(g.y)}" width="${fmt(g.w)}" height="${fmt(g.h)}" fill="none" stroke="currentColor" stroke-width="${fmt(g.stroke)}"${attrs(g)}/>`
          : `<rect x="${fmt(g.x)}" y="${fmt(g.y)}" width="${fmt(g.w)}" height="${fmt(g.h)}" fill="currentColor"${attrs(g)}/>`,
      );
      break;
    case 'polygon':
      out.push(`<polygon points="${g.points.map(fmt).join(' ')}" fill="currentColor"${attrs(g)}/>`);
      break;
    case 'path':
      out.push(
        g.stroke
          ? `<path d="${g.d}" fill="none" stroke="currentColor" stroke-width="${fmt(g.stroke)}"${attrs(g)}/>`
          : `<path d="${g.d}" fill="currentColor"${attrs(g)}/>`,
      );
      break;
    case 'text':
      out.push(
        `<text x="${fmt(g.x)}" y="${fmt(g.y)}" font-size="${fmt(g.size)}" font-family="${esc(FONT_STACK[g.family])}"${g.weight === 'bold' ? ' font-weight="bold"' : ''}${g.italic ? ' font-style="italic"' : ''}${g.anchor && g.anchor !== 'start' ? ` text-anchor="${g.anchor}"` : ''} fill="currentColor"${attrs(g)}>${esc(g.text)}</text>`,
      );
      break;
    case 'group':
      out.push(`<g${attrs(g)}>`);
      for (const c of g.children) renderOne(c, prefix, out);
      out.push('</g>');
      break;
  }
}

export function renderPageSvg(
  page: PageLayout,
  layout: Pick<ScoreLayout, 'staffSpaceMm'>,
  options: SvgOptions = {},
): string {
  const prefix = options.idPrefix ?? `g${page.index}-`;
  const used = new Set<GlyphName>();
  collectGlyphs(page.graphics, used);
  const defs = [...used]
    .sort()
    .map((name) => `<path id="${prefix}${name}" d="${glyph(name).path}"/>`)
    .join('');
  const w = fmt(page.width);
  const h = fmt(page.height);
  const size =
    (options.size ?? 'mm') === 'mm'
      ? ` width="${fmt(page.width * layout.staffSpaceMm)}mm" height="${fmt(page.height * layout.staffSpaceMm)}mm"`
      : '';
  const body: string[] = [];
  for (const g of page.graphics) renderOne(g, prefix, body);
  const style = options.embedStyle ? `<style>${DEFAULT_SVG_STYLE}</style>` : '';
  const bg = options.background === false ? '' : `<rect width="${w}" height="${h}" fill="#fff"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"${size} class="ailegro-page" data-page="${page.index}">` +
    `${style}<defs>${defs}</defs>${bg}<g fill="currentColor" color="#000">${body.join('')}</g></svg>`
  );
}

export function renderScoreSvg(layout: ScoreLayout, options: SvgOptions = {}): string[] {
  return layout.pages.map((p) => renderPageSvg(p, layout, options));
}
