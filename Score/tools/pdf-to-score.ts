/**
 * PDF or scanned image → Cantelvio Score, through Audiveris (optical music recognition; AGPL-3.0,
 * installed separately: https://github.com/Audiveris/audiveris/releases) and the MusicXML importer.
 *
 *   npm run import:pdf -- score.pdf                                # → score.cantelvio.json next to it
 *   npm run import:pdf -- score.pdf --instruments clarinet-bb,piano --out out/score.cantelvio.json
 *   npm run import:pdf -- page.png --keep out/omr                  # also keep Audiveris' .mxl / .omr
 *
 * Audiveris is found through --audiveris, $AUDIVERIS, the PATH, or its default install location
 * (macOS /Applications/Audiveris.app, Linux /opt/audiveris, Windows Program Files). Printed parts of
 * transposing instruments are read as written pitch (--concert: the print is in concert pitch).
 * See docs/pdf-import.md.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  findInstrument,
  randomIds,
  sequentialIds,
  serializeScore,
  validateScore,
} from '@cantelvio-score/core';
import { importMusicXmlFile } from './musicxml-file';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    audiveris: { type: 'string' },
    instruments: { type: 'string' },
    sheets: { type: 'string' },
    keep: { type: 'string' },
    concert: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    'sequential-ids': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const input = positionals[0];
if (!input || positionals.length > 1)
  fail(
    'usage: npm run import:pdf -- <score.pdf|.png|.jpg|.tif> [--out file.cantelvio.json] ' +
      '[--instruments id,id,…] [--sheets "1 3-4"] [--keep dir] [--concert] [--audiveris path]',
  );
if (!existsSync(input)) fail(`no such file: ${input}`);

/** The Audiveris launcher: option, environment, PATH, then the installers' default places. */
function findAudiveris(): string | null {
  const explicit = values.audiveris ?? process.env.AUDIVERIS;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const names =
    process.platform === 'win32' ? ['Audiveris.exe', 'audiveris.exe'] : ['audiveris', 'Audiveris'];
  for (const dir of (process.env.PATH ?? '').split(delimiter))
    for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name);
  const defaults = [
    '/Applications/Audiveris.app/Contents/MacOS/Audiveris',
    join(process.env.HOME ?? '', 'Applications/Audiveris.app/Contents/MacOS/Audiveris'),
    '/opt/audiveris/bin/Audiveris',
    'C:\\Program Files\\Audiveris\\Audiveris.exe',
  ];
  return defaults.find((p) => existsSync(p)) ?? null;
}

const audiveris = findAudiveris();
if (!audiveris)
  fail(
    'Audiveris was not found. Install it from https://github.com/Audiveris/audiveris/releases ' +
      '(see docs/pdf-import.md) or pass --audiveris <path to the launcher> (or set AUDIVERIS).',
  );

const instruments = values.instruments?.split(',').map((x) => x.trim() || null);
for (const id of instruments ?? [])
  if (id && !findInstrument(id)) fail(`unknown instrument id "${id}" (see the instrument catalog)`);

// ---------------------------------------------------------------------------------- recognition

const work = mkdtempSync(join(tmpdir(), 'cantelvio-omr-'));
const stem = basename(input, extname(input));
const args = ['-batch', '-export', '-output', work];
if (values.sheets) args.push('-sheets', ...values.sheets.split(/[\s,]+/).filter(Boolean));
args.push('--', resolve(input));
console.log(`Audiveris: recognising ${basename(input)} (roughly 10–20 s per page)…`);
const t0 = performance.now();
const run = spawnSync(audiveris, args, {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
if (values.verbose) console.log(log);
if (run.error) fail(`could not run ${audiveris}: ${run.error.message}`);

/** Audiveris writes <stem>.mxl, or <stem>.mvt<N>.mxl when it finds several movements. */
function exported(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.mxl$/i.test(name)) found.push(p);
    }
  };
  walk(dir);
  const movement = (p: string) => Number(/\.mvt(\d+)\.mxl$/i.exec(p)?.[1] ?? 0);
  return found.sort((a, b) => movement(a) - movement(b) || a.localeCompare(b));
}

const files = exported(work);
const problems = log
  .split('\n')
  .filter((l) => /\b(WARN|ERROR)\b/.test(l) && !/Tesseract|OCR|language/i.test(l))
  .map((l) => l.replace(/^.*\|\s*/, '').trim());
if (!files.length) {
  rmSync(work, { recursive: true, force: true });
  fail(
    `Audiveris produced no MusicXML (exit code ${run.status}).\n` +
      (problems.slice(-12).join('\n') || log.split('\n').slice(-12).join('\n')),
  );
}
if (/couldn't load any languages|Missing support for/i.test(log))
  console.log(
    '  ! Audiveris has no OCR language installed: titles, part names and lyrics were not read ' +
      '(Audiveris: Tools › Install languages).',
  );
console.log(
  `  ${files.length} movement(s) in ${((performance.now() - t0) / 1000).toFixed(0)} s` +
    (problems.length ? `, ${problems.length} Audiveris warnings (--verbose shows them)` : ''),
);

// ---------------------------------------------------------------------------------- import

if (values.keep) mkdirSync(values.keep, { recursive: true });
let failed = 0;
for (const [k, mxl] of files.entries()) {
  const suffix = files.length > 1 ? `.mvt${k + 1}` : '';
  const target =
    values.out && files.length === 1
      ? values.out
      : values.out
        ? values.out.replace(/(\.(?:cantelvio|ailegro))?\.json$/i, '') + `${suffix}.cantelvio.json`
        : join(dirname(input), `${stem}${suffix}.cantelvio.json`);
  const { doc, warnings } = await importMusicXmlFile(mxl, {
    ids: values['sequential-ids'] ? sequentialIds() : randomIds(),
    fileName: basename(input),
    writtenPitch: !values.concert,
    trustTimeSignatures: true,
    ...(instruments ? { instruments } : {}),
  });
  const invalid = validateScore(doc);
  let notes = 0;
  for (const bars of Object.values(doc.content))
    for (const sm of Object.values(bars)) for (const v of sm.voices) notes += v.length;
  console.log(
    `${basename(input)}${suffix} → ${target}: ${doc.parts.length} parts ` +
      `(${doc.parts.map((p) => p.instrument).join(', ')}), ${doc.measures.length} bars, ${notes} events`,
  );
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const p of invalid) console.log(`  ✗ ${p.path}: ${p.message}`);
  if (invalid.length) failed++;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serializeScore(doc));
  if (values.keep) {
    copyFileSync(mxl, join(values.keep, basename(mxl)));
    const book = join(work, `${stem}.omr`);
    if (k === 0 && existsSync(book)) copyFileSync(book, join(values.keep, `${stem}.omr`));
  }
}
if (values.keep)
  console.log(
    `  Audiveris output kept in ${values.keep} (open the .omr book in Audiveris to correct)`,
  );
rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
