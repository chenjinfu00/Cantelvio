/**
 * Import MusicXML (.musicxml, .xml or compressed .mxl) into the .ailegro.json format and report
 * what was skipped or approximated, plus any structural (validation) problems.
 *
 *   npm run import:musicxml -- score.mxl --out out/score.ailegro.json
 *   npm run import:musicxml -- a.mxl b.musicxml --out-dir out/imports
 *   npm run import:musicxml -- corpus/*.mxl --summary          # one line per file
 *
 * Exit code 1 when a file cannot be read or the imported score has validation problems.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  MUSICXML_FILE_PATTERN,
  randomIds,
  sequentialIds,
  serializeScore,
  validateScore,
} from '@ailegro-score/core';
import { importMusicXmlFile } from './musicxml-file';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    'out-dir': { type: 'string' },
    summary: { type: 'boolean', default: false },
    'sequential-ids': { type: 'boolean', default: false },
  },
});

if (positionals.length === 0) {
  console.error(
    'usage: npm run import:musicxml -- <file.musicxml|.xml|.mxl>... [--out file.ailegro.json] [--out-dir dir] [--summary] [--sequential-ids]',
  );
  process.exit(2);
}
if (values.out && positionals.length > 1) {
  console.error('--out takes one input file; use --out-dir for several');
  process.exit(2);
}

let failed = 0;
for (const path of positionals) {
  try {
    const t0 = performance.now();
    const ids = values['sequential-ids'] ? sequentialIds() : randomIds();
    const { doc, warnings } = await importMusicXmlFile(path, { ids });
    const problems = validateScore(doc);
    const ms = performance.now() - t0;
    let notes = 0;
    for (const bars of Object.values(doc.content))
      for (const sm of Object.values(bars)) for (const v of sm.voices) notes += v.length;
    const line =
      `${basename(path)}: ${doc.parts.length} parts, ${doc.measures.length} bars, ${notes} events, ` +
      `${warnings.length} warnings, ${problems.length} validation problems (${ms.toFixed(0)} ms)`;
    console.log(line);
    if (!values.summary) {
      for (const w of warnings) console.log(`  ! ${w}`);
      for (const p of problems) console.log(`  ✗ ${p.path}: ${p.message}`);
    }
    if (problems.length) failed++;
    const target =
      values.out ??
      (values['out-dir']
        ? join(
            values['out-dir'],
            `${basename(path).replace(MUSICXML_FILE_PATTERN, '')}.ailegro.json`,
          )
        : null);
    if (target) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, serializeScore(doc));
      if (!values.summary) console.log(`  → ${target}`);
    }
  } catch (e) {
    failed++;
    console.log(`${basename(path)}: FAILED — ${(e as Error).message ?? String(e)}`);
  }
}
process.exit(failed ? 1 : 0);
