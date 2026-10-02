import { type GlyphName, glyph } from '@ailegro-score/engraving';

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
  const g = glyph(name);
  const [x0, y0, x1, y1] = g.bbox;
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
      <path d={g.path} fill="currentColor" />
    </svg>
  );
}
