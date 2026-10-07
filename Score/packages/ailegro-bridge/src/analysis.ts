/**
 * Harmonic analysis: build an ailegro.analysis-request/1 for a range of bars and import the
 * ailegro.analysis-result/1 as chord symbols (AI suggestions until accepted, one undoable step).
 */
import {
  type Command,
  type KeySignature,
  type Provenance,
  type ScoreDoc,
  divInt,
  lt,
  measureInfos,
  parseRational,
  rat,
  toString as ratString,
} from '@cantelvio-score/core';
import { qualityIndex, qualityOf } from './qualities';
import { buildScoreRecord } from './record';
import type { RequestMeta } from './request';
import {
  ANALYSIS_REQUEST_SCHEMA,
  ANALYSIS_RESULT_SCHEMA,
  type AnalysisRequest,
  type AnalysisResult,
} from './schemas';
import { keyFromTonic, spellRoot } from './spelling';

/** How often chords may change: as learned (`auto`), on beats, on the downbeat and the middle of the bar,
 * once per bar, or every second bar. */
export type HarmonicRhythm = 'auto' | 'beat' | 'half-bar' | 'bar' | 'two-bars';
export const HARMONIC_RHYTHMS: readonly HarmonicRhythm[] = [
  'auto',
  'beat',
  'half-bar',
  'bar',
  'two-bars',
];

export interface AnalysisSpec {
  /** 0-based first measure to label. */
  readonly from: number;
  readonly count: number;
  readonly melodyPart?: string | null;
  readonly engine?: 'auto' | 'model' | 'rules';
  readonly harmonicRhythm?: HarmonicRhythm;
}

export function buildAnalysisRequest(
  doc: ScoreDoc,
  spec: AnalysisSpec,
  meta: RequestMeta,
): AnalysisRequest {
  const infos = measureInfos(doc);
  if (spec.from < 0 || spec.count < 1 || spec.from >= infos.length)
    throw new Error('invalid bar range');
  const to = Math.min(spec.from + spec.count, infos.length);
  if (spec.melodyPart && !doc.parts.some((p) => p.id === spec.melodyPart))
    throw new Error(`unknown part ${spec.melodyPart}`);
  return {
    schema: ANALYSIS_REQUEST_SCHEMA,
    requestId: meta.requestId,
    createdAt: meta.createdAt ?? null,
    client: { app: 'Cantelvio Score', version: meta.appVersion ?? '0.0.0' },
    score: buildScoreRecord(doc, { bars: { from: spec.from, to } }),
    analyze: {
      bars: { from: spec.from, count: to - spec.from },
      melodyPart: spec.melodyPart ?? null,
      engine: spec.engine ?? 'auto',
      harmonicRhythm: spec.harmonicRhythm ?? 'auto',
    },
  };
}

export interface AnalysisImportOptions {
  readonly ids: { next(prefix: string): string };
  /** Run id for review (accept / reject); defaults to the request id. */
  readonly runId?: string;
  /** false = import as accepted material instead of suggestions. */
  readonly suggestion?: boolean;
  /** Replace chord symbols already at the same position (default: keep them). */
  readonly overwrite?: boolean;
}

export interface AnalysisImportPlan {
  readonly commands: Command[];
  readonly warnings: string[];
  readonly runId: string;
  readonly stats: { readonly chords: number; readonly kept: number; readonly skipped: number };
}

/** Chord symbols for every chord change of the result. A position that already holds a chord symbol is
 * kept unless `overwrite`; changes outside a measure or with unknown qualities are skipped (warned). */
export function planAnalysisImport(
  doc: ScoreDoc,
  result: AnalysisResult,
  options: AnalysisImportOptions,
): AnalysisImportPlan {
  if (result.schema !== ANALYSIS_RESULT_SCHEMA)
    throw new Error(`expected ${ANALYSIS_RESULT_SCHEMA}`);
  const runId = options.runId ?? result.requestId;
  const provenance: Provenance = {
    kind: 'ai',
    model: result.model.name,
    runId,
    accepted: options.suggestion === false,
  };
  const infos = measureInfos(doc);
  const warnings: string[] = [...(result.warnings ?? [])];
  const commands: Command[] = [];
  const existing = new Map(doc.harmony.map((h) => [`${h.measureId}@${ratString(h.offset)}`, h]));
  let chords = 0;
  let kept = 0;
  let skipped = 0;
  result.bars.forEach((b, k) => {
    const bar = result.startBar + k;
    const info = infos[bar];
    if (!info) {
      skipped += b.chords.length;
      return;
    }
    const scoreKey: KeySignature = info.keySig;
    const key = b.key ? keyFromTonic(b.key.tonic, b.key.mode, scoreKey) : scoreKey;
    for (const c of b.chords) {
      const offset = divInt(parseRational(c.onset), 4);
      if (lt(offset, rat(0)) || !lt(offset, info.length)) {
        skipped++;
        continue;
      }
      let quality: string;
      try {
        quality = typeof c.quality === 'number' ? qualityOf(c.quality).id : c.quality;
        qualityIndex(quality);
      } catch {
        skipped++;
        continue;
      }
      // harmony.set replaces a chord symbol at the same position
      const at = existing.get(`${info.measure.id}@${ratString(offset)}`);
      if (at && !options.overwrite) {
        kept++;
        continue;
      }
      commands.push({
        type: 'harmony.set',
        chord: {
          id: options.ids.next('ch'),
          measureId: info.measure.id,
          offset,
          root: spellRoot(((c.root % 12) + 12) % 12, key),
          quality,
          source: provenance,
        },
      });
      chords++;
    }
  });
  if (kept) warnings.push(`${kept} chord symbols already in the score were kept`);
  if (skipped) warnings.push(`${skipped} chord changes could not be placed`);
  return { commands, warnings, runId, stats: { chords, kept, skipped } };
}
