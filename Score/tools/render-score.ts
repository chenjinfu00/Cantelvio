/**
 * Headless renderer: engrave sample scores or .ailegro.json files to SVG (and PNG via sharp).
 * Used by humans and AI agents to check engraving changes visually, and by CI.
 *
 *   npm run render -- --sample orchestra --out out/
 *   npm run render -- --all --out out/renders --svg-only
 *   npm run render -- --file my-score.ailegro.json --concert --continuous
 *   npm run render -- --file score.mxl            # MusicXML is imported first
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  MUSICXML_FILE_PATTERN,
  SAMPLES,
  type ScoreDoc,
  parseScore,
  randomIds,
} from '@ailegro-score/core';
import { layoutScore, renderPageSvg } from '@ailegro-score/engraving';
import { importMusicXmlFile } from './musicxml-file';

const { values } = parseArgs({
  options: {
    sample: { type: 'string', multiple: true },
    all: { type: 'boolean', default: false },
    file: { type: 'string', multiple: true },
    out: { type: 'string', default: 'out' },
    concert: { type: 'boolean', default: false },
    continuous: { type: 'boolean', default: false },
    'svg-only': { type: 'boolean', default: false },
    zh: { type: 'boolean', default: false },
    scale: { type: 'string', default: '2' },
  },
});

const jobs: { name: string; doc: ScoreDoc }[] = [];
const lang = values.zh ? 'zh' : 'en';
for (const s of SAMPLES) {
  if (values.all || values.sample?.includes(s.id)) jobs.push({ name: s.id, doc: s.build(lang) });
}
for (const f of values.file ?? []) {
  if (MUSICXML_FILE_PATTERN.test(f)) {
    const { doc, warnings } = await importMusicXmlFile(f, { ids: randomIds() });
    for (const w of warnings) console.warn(`${basename(f)}: ${w}`);
    jobs.push({ name: basename(f).replace(MUSICXML_FILE_PATTERN, ''), doc });
  } else
    jobs.push({
      name: basename(f).replace(/\.ailegro\.json$|\.json$/, ''),
      doc: parseScore(readFileSync(f, 'utf8')),
    });
}
if (jobs.length === 0) {
  console.error(
    `nothing to render. Use --sample <${SAMPLES.map((s) => s.id).join('|')}>, --all or --file <path>`,
  );
  process.exit(1);
}

mkdirSync(values.out!, { recursive: true });
type Sharp = (
  input: Buffer,
  options?: { density?: number },
) => { png(): { toFile(path: string): Promise<unknown> } };
let sharp: Sharp | null = null;
if (!values['svg-only']) {
  try {
    sharp = ((await import('sharp')) as unknown as { default: Sharp }).default;
  } catch {
    console.warn('sharp is not installed; writing SVG only (npm i -D sharp for PNG output)');
  }
}

for (const job of jobs) {
  const t0 = performance.now();
  const layout = layoutScore(job.doc, {
    concertPitch: values.concert,
    mode: values.continuous ? 'continuous' : 'page',
  });
  const ms = performance.now() - t0;
  for (const page of layout.pages) {
    const svg = renderPageSvg(page, layout, { embedStyle: true });
    const base = join(
      values.out!,
      `${job.name}${values.concert ? '-concert' : ''}${values.continuous ? '-continuous' : ''}-p${page.index + 1}`,
    );
    writeFileSync(`${base}.svg`, svg);
    if (sharp) {
      const density = 96 * Number(values.scale);
      await sharp(Buffer.from(svg), { density }).png().toFile(`${base}.png`);
    }
    console.log(`${base}.svg${sharp ? ' (+png)' : ''}`);
  }
  console.log(
    `  ${job.name}: ${layout.pages.length} page(s), ${layout.systems.length} system(s), layout ${ms.toFixed(0)} ms`,
  );
}
