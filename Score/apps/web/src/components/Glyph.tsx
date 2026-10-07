import { type GlyphName, glyph } from '@cantelvio-score/engraving';

/** A SMuFL glyph as a small inline SVG icon (uses the same outlines as the engraver). */
export function Glyph({
  name,
  size = 22,
  title,
}: {
  name: GlyphName;
  size?: number;
  title?: string;
}) {
  return <GlyphRow names={[name]} size={size} {...(title ? { title } : {})} />;
}

/** Several glyphs side by side in one icon (dynamics like "mf", "8va" with a wiggle, …). */
export function GlyphRow({
  names,
  size = 22,
  title,
  gap = 0.05,
}: {
  names: readonly GlyphName[];
  size?: number;
  title?: string;
  /** Extra space between glyphs, staff spaces. */
  gap?: number;
}) {
  let x = 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const parts = names.map((name) => {
    const g = glyph(name);
    const [bx0, by0, bx1, by1] = g.bbox;
    const at = x;
    x0 = Math.min(x0, at + bx0);
    x1 = Math.max(x1, at + bx1);
    y0 = Math.min(y0, by0);
    y1 = Math.max(y1, by1);
    x += (g.advance ?? bx1 - bx0) + gap;
    return { at, path: g.path };
  });
  const pad = 0.15;
  const w = x1 - x0 + pad * 2;
  const h = y1 - y0 + pad * 2;
  const box = Math.max(w, h);
  const vx = x0 - pad - (box - w) / 2;
  const vy = -y1 - pad - (box - h) / 2;
  return (
    <svg
      className="glyph-icon"
      width={size}
      height={size}
      viewBox={`${vx} ${vy} ${box} ${box}`}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {parts.map((p, i) => (
        <path
          key={i}
          d={p.path}
          transform={p.at ? `translate(${p.at} 0)` : undefined}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
