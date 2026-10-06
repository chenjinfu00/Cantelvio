/** Vector PDF uses the existing engraver; Chinese text has an embedded OFL font. */
import { layoutScore, renderPageSvg } from '@ailegro-score/engraving';
import type { ScoreDoc } from '@ailegro-score/core';

let fontData: Promise<string> | null = null;
async function chineseFont(): Promise<string> {
  fontData ??= (async () => {
    const response = await fetch(new URL('fonts/LXGWWenKaiLite-Regular.ttf', document.baseURI));
    if (!response.ok) throw new Error(`PDF font: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  })().catch((e) => {
    fontData = null;
    throw e;
  });
  return fontData;
}

export async function scoreToPdf(doc: ScoreDoc, concertPitch: boolean): Promise<Blob> {
  const [{ jsPDF }, { svg2pdf }, font] = await Promise.all([
    import('jspdf'),
    import('svg2pdf.js'),
    chineseFont(),
  ]);
  const layout = layoutScore(doc, { concertPitch });
  const first = layout.pages[0]!;
  const mm = (x: number) => x * layout.staffSpaceMm;
  const orientation = (w: number, h: number) => (w > h ? 'landscape' : 'portrait');
  const pdf = new jsPDF({
    unit: 'mm',
    format: [mm(first.width), mm(first.height)],
    orientation: orientation(first.width, first.height),
    compress: true,
    putOnlyUsedFonts: true,
  });
  pdf.addFileToVFS('LXGWWenKaiLite-Regular.ttf', font);
  // The same Unicode face is registered for all SVG styles to avoid unsupported CJK fallback.
  for (const style of ['normal', 'bold', 'italic', 'bolditalic'])
    pdf.addFont('LXGWWenKaiLite-Regular.ttf', 'AIlegroText', style);
  pdf.setProperties({ title: doc.meta.title, creator: 'AIlegro Score' });
  for (const page of layout.pages) {
    if (page.index)
      pdf.addPage([mm(page.width), mm(page.height)], orientation(page.width, page.height));
    const svg = new DOMParser().parseFromString(
      renderPageSvg(page, layout, { size: 'mm' }),
      'image/svg+xml',
    ).documentElement;
    for (const text of svg.querySelectorAll('text'))
      text.setAttribute('font-family', 'AIlegroText');
    await svg2pdf(svg as unknown as SVGElement, pdf, {
      x: 0,
      y: 0,
      width: mm(page.width),
      height: mm(page.height),
    });
  }
  return pdf.output('blob');
}
