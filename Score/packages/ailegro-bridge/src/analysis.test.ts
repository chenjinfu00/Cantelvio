import {
  SAMPLES,
  applyCommand,
  measureInfos,
  rat,
  sequentialIds,
  toString as ratString,
  validateScore,
  type ScoreDoc,
} from '@ailegro-score/core';
import { describe, expect, it } from 'vitest';
import { buildAnalysisRequest, planAnalysisImport } from './analysis';
import { buildComposeRequest } from './request';
import type { AnalysisResult } from './schemas';

function result(bars: AnalysisResult['bars'], startBar = 0): AnalysisResult {
  return {
    schema: 'ailegro.analysis-result/1',
    requestId: 'ai_analysis1',
    model: { name: 'harmonizer-v2' },
    startBar,
    bars,
  };
}

function withChord(doc: ScoreDoc): ScoreDoc {
  return applyCommand(doc, {
    type: 'harmony.set',
    chord: {
      id: 'ch_user',
      measureId: doc.measures[1]!.id,
      offset: rat(0),
      root: { step: 'D', alter: 0 },
      quality: 'min',
    },
  }).doc;
}

describe('harmonic analysis', () => {
  it('builds a request for a bar range of the whole texture', () => {
    const doc = SAMPLES[1]!.build();
    const req = buildAnalysisRequest(doc, { from: 1, count: 99 }, { requestId: 'ai_a1' });
    const bars = measureInfos(doc).length;
    expect(req.schema).toBe('ailegro.analysis-request/1');
    expect(req.analyze).toEqual({
      bars: { from: 1, count: bars - 1 },
      melodyPart: null,
      engine: 'auto',
      harmonicRhythm: 'auto',
    });
    expect(req.score.parts.length).toBe(doc.parts.length);
    expect(req.score.notes.length).toBeGreaterThan(0);
    expect(req.score.notes.every((n) => n.bar >= 1)).toBe(true);
    expect(() => buildAnalysisRequest(doc, { from: bars, count: 1 }, { requestId: 'x' })).toThrow();
    expect(() =>
      buildAnalysisRequest(doc, { from: 0, count: 1, melodyPart: 'nope' }, { requestId: 'x' }),
    ).toThrow();
  });

  it('imports chord changes as reviewable chord symbols, keeping the user’s', () => {
    const doc = withChord(SAMPLES[0]!.build());
    const plan = planAnalysisImport(
      doc,
      result([
        {
          bar: 0,
          key: { tonic: 7, mode: 0 },
          chords: [
            { onset: '0', root: 7, quality: 'maj' },
            { onset: '2', root: 2, quality: 10 }, // dom7 by index
            { onset: '9', root: 0, quality: 'maj' }, // outside the bar
          ],
        },
        { bar: 1, key: { tonic: 7, mode: 0 }, chords: [{ onset: '0', root: 6, quality: 'dim' }] },
        {
          bar: 2,
          key: { tonic: 7, mode: 0 },
          chords: [{ onset: '1', root: 0, quality: 'nonsense' }],
        },
      ]),
      { ids: sequentialIds(900) },
    );
    expect(plan.stats).toEqual({ chords: 2, kept: 1, skipped: 2 });
    const next = applyCommand(doc, { type: 'batch', commands: plan.commands }).doc;
    expect(validateScore(next)).toEqual([]);
    const placed = next.harmony.filter((h) => h.source?.kind === 'ai');
    expect(
      placed.map((h) => [
        h.measureId,
        ratString(h.offset),
        `${h.root.step}${h.root.alter}`,
        h.quality,
      ]),
    ).toEqual([
      [doc.measures[0]!.id, '0', 'G0', 'maj'],
      [doc.measures[0]!.id, '1/2', 'D0', 'dom7'],
    ]);
    expect(placed.every((h) => h.source?.kind === 'ai' && !h.source.accepted)).toBe(true);
    expect(next.harmony.find((h) => h.id === 'ch_user')?.quality).toBe('min');
    expect(plan.warnings.join(' ')).toMatch(/kept/);
  });

  it('can overwrite existing chord symbols and spells roots in the key', () => {
    const doc = withChord(SAMPLES[0]!.build());
    const plan = planAnalysisImport(
      doc,
      result(
        [
          {
            bar: 1,
            key: { tonic: 5, mode: 0 },
            chords: [{ onset: '0', root: 10, quality: 'maj' }],
          },
        ],
        1,
      ),
      { ids: sequentialIds(900), overwrite: true, suggestion: false },
    );
    const next = applyCommand(doc, { type: 'batch', commands: plan.commands }).doc;
    const chord = next.harmony.find((h) => h.measureId === doc.measures[1]!.id)!;
    expect(chord.root).toEqual({ step: 'B', alter: -1 }); // B-flat in F major, not A-sharp
    expect(chord.source).toMatchObject({ kind: 'ai', accepted: true });
    expect(next.harmony.some((h) => h.id === 'ch_user')).toBe(false);
  });

  it('rejects other schemas', () => {
    const bad = { ...result([]), schema: 'ailegro.compose-result/1' } as unknown as AnalysisResult;
    expect(() => planAnalysisImport(SAMPLES[0]!.build(), bad, { ids: sequentialIds(1) })).toThrow();
  });
});

describe('harmonic rhythm', () => {
  it('travels as an intent tag in compose requests and as a field in analysis requests', () => {
    const doc = SAMPLES[0]!.build();
    const base = {
      task: 'accompany-melody' as const,
      from: 1,
      count: 2,
      materialParts: [doc.parts[0]!.id],
    };
    const tagged = buildComposeRequest(
      doc,
      { ...base, harmonicRhythm: 'bar' },
      { requestId: 'r1' },
    );
    expect(tagged.intent).toEqual({ text: '', tags: ['harmonic-rhythm:bar'] });
    const auto = buildComposeRequest(doc, { ...base, harmonicRhythm: 'auto' }, { requestId: 'r2' });
    expect(auto.intent).toBeNull();
    const both = buildComposeRequest(
      doc,
      {
        ...base,
        harmonicRhythm: 'half-bar',
        intent: { text: 'calm', tags: ['harmonic-rhythm:beat', 'x'] },
      },
      { requestId: 'r3' },
    );
    expect(both.intent).toEqual({ text: 'calm', tags: ['x', 'harmonic-rhythm:half-bar'] });
    const analysis = buildAnalysisRequest(
      doc,
      { from: 0, count: 2, harmonicRhythm: 'two-bars' },
      { requestId: 'a' },
    );
    expect(analysis.analyze.harmonicRhythm).toBe('two-bars');
  });
});
