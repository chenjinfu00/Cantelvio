/**
 * Example Cantelvio compose requests for every task, built from small demo scores, and a check that
 * imports the adapter's results back into the same scores (end-to-end test of the Cantelvio bridge).
 *
 *   npm run cantelvio:examples -- --out out/cantelvio       # write <example>.request.json files
 *   # in the Cantelvio folder, for each request (see docs/ailegro-integration.md):
 *   #   .venv-training/bin/python "../Score/integrations/ailegro/score_compose.py" \
 *   #     --request <example>.request.json --checkpoint <weights.pt> --output <example>.result.json
 *   npm run cantelvio:examples -- --check out/cantelvio     # import every result found, validate, report
 *
 * The melodies are public-domain tunes (Ode to Joy, Twinkle Twinkle); the other music comes from
 * the demo samples in packages/core.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  SAMPLES,
  allStaves,
  applyCommand,
  createScore,
  fillStaves,
  rat,
  sequentialIds,
  validateScore,
  voiceEvents,
  type Command,
  type CreateScoreOptions,
  type ScoreDoc,
} from '@cantelvio-score/core';
import {
  ANALYSIS_RESULT_SCHEMA,
  buildAnalysisRequest,
  buildComposeRequest,
  planAnalysisImport,
  planComposeImport,
  type AnalysisResult,
  type AnalysisSpec,
  type ComposeRequest,
  type ComposeResult,
  type ComposeSpec,
} from '@cantelvio-score/compose-bridge';

const NOW = '2026-10-01T00:00:00.000Z';

function score(options: CreateScoreOptions, music: Record<number, string | string[]>): ScoreDoc {
  const ids = sequentialIds();
  return fillStaves(createScore({ ...options, ids, now: NOW }), music, ids);
}

/** Chord symbols (root letter + alter, Cantelvio quality id) at the start of the given measures. */
function withChords(
  doc: ScoreDoc,
  chords: readonly [number, 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B', number, string][],
): ScoreDoc {
  const commands: Command[] = chords.map(([measure, step, alter, quality], i) => ({
    type: 'harmony.set',
    chord: {
      id: `example-chord-${i}`,
      measureId: doc.measures[measure]!.id,
      offset: rat(0),
      root: { step, alter },
      quality,
    },
  }));
  return applyCommand(doc, { type: 'batch', commands }).doc;
}

const CHORALE = {
  0: "a2 b4 c | d2 c | b4 a g a | f1 | c'4 d e f | g2 f4 e | d4 c b a | g1",
  1: "f2 g4 a | b2 a | g4 f e f | c1 | a'4 b c d | e2 d4 c | b4 a g f | e1",
  2: 'c2 d4 c | d2 c | d4 c c c | a1 | c4 d e f | g2 a4 g | f4 f e d | c1',
  3: "f2 c4 f | b,2 f' | b,4 c c c | f1 | f4 e d b | c2 f4 a | b4 f g c | f,1",
};
const STUDY = {
  0: 'd4 g,8 a b c d4 | e4 c8 d e f g4 | d4. c8 b4 a | g2 r4 d | e8 f g a b4 g | c4 b8 a g4 f | g8 a b c d4 <b d> | <g b d>2. r4',
  1: "g,2 <b d>2 | c2 <e g>2 | d2 f,2 | g4 d' g, r | c2 e2 | a,2 d2 | g,2 d'2 | g,1",
};

interface Example {
  readonly name: string;
  readonly about: string;
  readonly doc: () => ScoreDoc;
  readonly spec: (doc: ScoreDoc) => ComposeSpec;
}

const partId = (doc: ScoreDoc, instrument: string) =>
  doc.parts.find((p) => p.instrument === instrument)!.id;

const EXAMPLES: readonly Example[] = [
  {
    name: 'continue-orchestra',
    about: 'four new bars after the orchestral demo',
    doc: () => SAMPLES[2]!.build(),
    spec: () => ({ task: 'continue', from: 6, count: 4 }),
  },
  {
    name: 'melody-from-chords-quartet',
    about: 'string quartet: four bars over F | Bb | C7 | F after the chorale',
    doc: () =>
      withChords(
        score(
          {
            template: 'string-quartet',
            measures: 12,
            timeSig: { beats: 4, beatType: 4 },
            keySig: { fifths: -1, mode: 'major' },
            tempo: 72,
          },
          CHORALE,
        ),
        [
          [8, 'F', 0, 'maj'],
          [9, 'B', -1, 'maj'],
          [10, 'C', 0, 'dom7'],
          [11, 'F', 0, 'maj'],
        ],
      ),
    spec: () => ({ task: 'melody-from-chords', from: 8, count: 4, chordMode: 'given' }),
  },
  {
    name: 'accompany-melody-violin',
    about: 'violin and piano: piano accompaniment for Ode to Joy (D major)',
    doc: () =>
      score(
        {
          template: 'violin-piano',
          measures: 8,
          timeSig: { beats: 4, beatType: 4 },
          keySig: { fifths: 2, mode: 'major' },
          tempo: 92,
        },
        {
          0: "f'4 f g a | a g f e | d d e f | f4. e8 e2 | f4 f g a | a g f e | d d e f | e4. d8 d2",
        },
      ),
    spec: (doc) => ({
      task: 'accompany-melody',
      from: 0,
      count: 8,
      materialParts: [partId(doc, 'violin')],
    }),
  },
  {
    name: 'accompany-melody-voice',
    about: 'soprano and piano: piano accompaniment for Twinkle Twinkle (C major)',
    doc: () =>
      score(
        {
          template: 'satb-piano',
          measures: 8,
          timeSig: { beats: 4, beatType: 4 },
          keySig: { fifths: 0, mode: 'major' },
          tempo: 88,
        },
        { 0: "c4 c g' g | a a g2 | f4 f e e | d d c2 | g'4 g f f | e e d2 | g4 g f f | e e d2" },
      ),
    spec: (doc) => ({
      task: 'accompany-melody',
      from: 0,
      count: 8,
      materialParts: [partId(doc, 'soprano')],
    }),
  },
  {
    name: 'orchestrate-study',
    about: 'the piano study orchestrated for flute, oboe, violin, viola and cello',
    doc: () =>
      score(
        {
          template: {
            id: 'example-piano-and-orchestra',
            name: { en: 'Piano and small orchestra', zh: '钢琴与小乐队' },
            category: 'orchestra',
            parts: [
              { instrument: 'flute' },
              { instrument: 'oboe' },
              { instrument: 'violin' },
              { instrument: 'viola' },
              { instrument: 'cello' },
              { instrument: 'piano' },
            ],
            bracketing: 'families',
            staffSpaceMm: 1.5,
          },
          measures: 8,
          timeSig: { beats: 4, beatType: 4 },
          keySig: { fifths: 1, mode: 'major' },
          tempo: 96,
        },
        { 5: STUDY[0], 6: STUDY[1] },
      ),
    spec: (doc) => ({
      task: 'orchestrate',
      from: 0,
      count: 8,
      materialParts: [partId(doc, 'piano')],
    }),
  },
  {
    name: 'develop-motif-study',
    about: 'piano: bars 3-6 developed from the motif of bars 1-2',
    doc: () => SAMPLES[0]!.build(),
    spec: (doc) => ({
      task: 'develop-motif',
      from: 2,
      count: 4,
      materialParts: [doc.parts[0]!.id],
    }),
  },
];

interface AnalysisExample {
  readonly name: string;
  readonly about: string;
  readonly doc: () => ScoreDoc;
  readonly spec: (doc: ScoreDoc) => AnalysisSpec;
}

/** Harmonic analysis (ailegro.analysis-request/1): label the chords of existing music. */
const ANALYSIS_EXAMPLES: readonly AnalysisExample[] = [
  {
    name: 'analyze-chorale',
    about: 'string quartet chorale (F major), all bars, harmonic rhythm as analysed',
    doc: () =>
      score(
        {
          template: 'string-quartet',
          measures: 8,
          timeSig: { beats: 4, beatType: 4 },
          keySig: { fifths: -1, mode: 'major' },
          tempo: 72,
        },
        CHORALE,
      ),
    spec: () => ({ from: 0, count: 8 }),
  },
  {
    name: 'analyze-study-by-bar',
    about: 'piano study (G major), one chord per bar at most',
    doc: () =>
      score(
        {
          template: 'piano',
          measures: 8,
          timeSig: { beats: 4, beatType: 4 },
          keySig: { fifths: 1, mode: 'major' },
          tempo: 96,
        },
        { 0: STUDY[0], 1: STUDY[1] },
      ),
    spec: () => ({ from: 0, count: 8, harmonicRhythm: 'bar' }),
  },
];

/** Notes per part in measures [from, to), counting AI suggestions separately. */
function noteCounts(doc: ScoreDoc, from: number, to: number) {
  const out = new Map<string, { notes: number; ai: number }>();
  for (const s of allStaves(doc)) {
    const row = out.get(s.part.name) ?? { notes: 0, ai: 0 };
    for (const m of doc.measures.slice(from, to))
      for (let v = 0; v < 4; v++)
        for (const e of voiceEvents(doc, s.staff.id, m.id, v)) {
          if (e.kind !== 'note') continue;
          row.notes += e.notes.length;
          if (e.source?.kind === 'ai') row.ai += e.notes.length;
        }
    out.set(s.part.name, row);
  }
  return Object.fromEntries(out);
}

function materialUnchanged(
  before: ScoreDoc,
  after: ScoreDoc,
  parts: readonly string[],
  from: number,
  to: number,
) {
  const dump = (doc: ScoreDoc) =>
    JSON.stringify(
      allStaves(doc)
        .filter((s) => parts.includes(s.part.id))
        .map((s) =>
          doc.measures.slice(from, to).map((m) => doc.content[s.staff.id]?.[m.id] ?? null),
        ),
    );
  return dump(before) === dump(after);
}

const { values } = parseArgs({
  options: { out: { type: 'string' }, check: { type: 'string' } },
});

if (values.out) {
  mkdirSync(values.out, { recursive: true });
  for (const ex of EXAMPLES) {
    const doc = ex.doc();
    const request = buildComposeRequest(doc, ex.spec(doc), {
      requestId: `example-${ex.name}`,
      createdAt: NOW,
    });
    const path = join(values.out, `${ex.name}.request.json`);
    writeFileSync(path, JSON.stringify(request, null, 1));
    console.log(`${path}  (${ex.about})`);
  }
  for (const ex of ANALYSIS_EXAMPLES) {
    const doc = ex.doc();
    const request = buildAnalysisRequest(doc, ex.spec(doc), {
      requestId: `example-${ex.name}`,
      createdAt: NOW,
    });
    const path = join(values.out, `${ex.name}.request.json`);
    writeFileSync(path, JSON.stringify(request, null, 1));
    console.log(`${path}  (${ex.about})`);
  }
} else if (values.check) {
  let failures = 0;
  for (const ex of EXAMPLES) {
    const resultPath = join(values.check, `${ex.name}.result.json`);
    if (!existsSync(resultPath)) {
      console.log(`${ex.name}: no result yet`);
      continue;
    }
    const request = JSON.parse(
      readFileSync(join(values.check, `${ex.name}.request.json`), 'utf8'),
    ) as ComposeRequest;
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as ComposeResult;
    const doc = ex.doc();
    const spec = ex.spec(doc);
    const plan = planComposeImport(doc, result, {
      ids: sequentialIds(900000),
      runId: result.requestId,
      targets: request.targets,
    });
    const next = applyCommand(doc, { type: 'batch', commands: plan.commands }).doc;
    const problems = validateScore(next).map((p) => JSON.stringify(p));
    const to = spec.from + spec.count;
    if (
      spec.task !== 'develop-motif' &&
      spec.materialParts?.length &&
      !materialUnchanged(doc, next, spec.materialParts, spec.from, to)
    )
      problems.push('the given material changed');
    if (!plan.stats.notes) problems.push('nothing was imported');
    failures += problems.length ? 1 : 0;
    console.log(
      JSON.stringify(
        {
          example: ex.name,
          model: result.model.name,
          imported: plan.stats,
          parts: noteCounts(next, spec.from, to),
          warnings: plan.warnings,
          problems,
        },
        null,
        1,
      ),
    );
  }
  for (const ex of ANALYSIS_EXAMPLES) {
    const resultPath = join(values.check, `${ex.name}.result.json`);
    if (!existsSync(resultPath)) {
      console.log(`${ex.name}: no result yet`);
      continue;
    }
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as AnalysisResult;
    const problems: string[] = [];
    if (result.schema !== ANALYSIS_RESULT_SCHEMA)
      problems.push(`unexpected schema ${result.schema}`);
    const doc = ex.doc();
    const plan = planAnalysisImport(doc, result, { ids: sequentialIds(900000) });
    const next = applyCommand(doc, { type: 'batch', commands: plan.commands }).doc;
    problems.push(...validateScore(next).map((p) => JSON.stringify(p)));
    if (!plan.stats.chords) problems.push('no chord symbols were imported');
    const bars = next.measures.map((m) =>
      next.harmony
        .filter((h) => h.measureId === m.id)
        .map(
          (h) =>
            `${h.root.step}${h.root.alter > 0 ? '#' : h.root.alter < 0 ? 'b' : ''}:${h.quality}`,
        )
        .join(' '),
    );
    failures += problems.length ? 1 : 0;
    console.log(
      JSON.stringify(
        {
          example: ex.name,
          model: result.model.name,
          imported: plan.stats,
          chords: bars,
          warnings: plan.warnings,
          problems,
        },
        null,
        1,
      ),
    );
  }
  if (failures) process.exitCode = 1;
} else {
  console.error('use --out <dir> to write example requests or --check <dir> to import results');
  process.exitCode = 1;
}
