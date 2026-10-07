import {
  allStaves,
  applyCommand,
  createScore,
  measureInfos,
  rat,
  sequentialIds,
  validateScore,
  add,
  divInt,
  parseRational,
} from '@cantelvio-score/core';
import { describe, expect, it } from 'vitest';
import { buildScoreRecord } from './record';
import { planComposeImport } from './result';
import {
  DIFFICULTIES,
  PERFORMANCE_PROFILES,
  planPerformance,
  type PerformanceOptions,
  type PerformanceNote,
} from './performance';
import type { ComposeResult, ResultNote } from './schemas';

const note = (pitch: number, onset = '0', duration = '4', voice = 0): ResultNote => ({
  pitch,
  onset,
  duration,
  voice,
  group: 'keys',
  drum: null,
  velocity: 90,
  dynamic: 'sffz',
  accent: 2,
  wedge: 'crescendo',
});
function fixture(bars = 2): ComposeResult {
  return {
    schema: 'ailegro.compose-result/1',
    requestId: 'test-performance',
    model: { name: 'fixture' },
    startBar: 0,
    bars: Array.from({ length: bars }, (_, bar) => ({
      bar,
      length: '4',
      meter: [4, 4],
      key: { tonic: 0, mode: 0 },
      chords: [{ onset: '0', root: bar % 2 ? 5 : 0, quality: bar % 2 ? 'min7' : 'dom7' }],
      notes: [24, 36, 48, 60, 64, 67, 72, 84, 96, 110].map((p, i) => note(p, '0', '8', i)),
    })),
  };
}
function realize(result: ComposeResult, options: PerformanceOptions, tempo = 92) {
  const ids = sequentialIds(),
    doc = createScore({ template: 'piano', measures: result.bars.length, tempo, ids, now: 'T' });
  const plan = planComposeImport(doc, result, { ids, performance: options, quantize: 'exact' });
  const preview = applyCommand(doc, { type: 'batch', commands: plan.commands }).doc;
  const record = buildScoreRecord(preview, { include: () => true });
  expect(validateScore(preview)).toEqual([]);
  return { doc, preview, record, plan };
}

describe('instrument-aware generated accompaniment', () => {
  it('realizes three distinct rhythmic levels with a safe piano range and consistent harmony', () => {
    const counts: number[] = [];
    for (const difficulty of DIFFICULTIES) {
      const { plan, record } = realize(fixture(), {
        difficulty,
        task: 'accompany-melody',
        seed: 1,
      });
      expect(plan.performance!.before.outOfRange).toBeGreaterThan(0);
      expect(plan.performance!.before.maxHandSpan).toBeGreaterThan(36);
      expect(plan.performance!.after.outOfRange).toBe(0);
      expect(plan.performance!.after.maxHandSpan).toBeLessThanOrEqual(
        PERFORMANCE_PROFILES[difficulty].handSpan,
      );
      expect(plan.performance!.arrangedPianoParts).toBe(1);
      expect(record.notes.every((n) => n.pitch! >= 21 && n.pitch! <= 108)).toBe(true);
      const firstPCs = new Set(
        record.notes
          .filter((n) => parseRational(n.on).n / parseRational(n.on).d < 4)
          .map((n) => n.pitch! % 12),
      );
      expect([...firstPCs].every((p) => [0, 4, 7, 10].includes(p))).toBe(true);
      expect(firstPCs.has(4), JSON.stringify({ difficulty, pcs: [...firstPCs] })).toBe(true);
      expect(firstPCs.has(10)).toBe(true);
      counts.push(plan.stats.notes);
    }
    expect(counts[0]!).toBeLessThan(counts[1]!);
    expect(counts[1]!).toBeLessThan(counts[2]!);
  });
  it.each(DIFFICULTIES)(
    'limits sustained block chords at %s level across all voices',
    (difficulty) => {
      const { plan, preview } = realize(fixture(), {
        difficulty,
        task: 'accompany-melody',
        pianoTexture: 'chords',
      });
      expect(plan.performance!.after.maxHandSpan).toBeLessThanOrEqual(
        PERFORMANCE_PROFILES[difficulty].handSpan,
      );
      const staffs = allStaves(preview);
      for (const s of staffs) {
        const limit =
          s.staffIndex === 0
            ? PERFORMANCE_PROFILES[difficulty].rightNotes
            : PERFORMANCE_PROFILES[difficulty].leftNotes;
        expect(
          Object.values(preview.content[s.staff.id]!)
            .flatMap((sm) => sm.voices.flat())
            .every((e) => e.notes.length <= limit),
        ).toBe(true);
      }
    },
  );
  it('keeps player reach separate from professional difficulty, and normalizes model polyphony too', () => {
    const { plan } = realize(fixture(), {
      difficulty: 'advanced',
      pianoTexture: 'model',
      maxHandSpan: 7,
    });
    expect(plan.performance!.after.maxHandSpan).toBeLessThanOrEqual(7);
    expect(plan.performance!.after.maxSimultaneous).toBeLessThanOrEqual(4);
    expect(plan.performance!.after.outOfRange).toBe(0);
    expect(plan.commands.some((c) => c.type === 'dynamic.set' && c.mark.value === 'sffz')).toBe(
      true,
    );
  });
  it('is deterministic and varies broken-chord patterns with the candidate seed', () => {
    const opts: PerformanceOptions = { difficulty: 'medium', task: 'accompany-melody', seed: 1 };
    const a = realize(fixture(), opts).record.notes;
    expect(realize(fixture(), opts).record.notes).toEqual(a);
    expect(realize(fixture(), { ...opts, seed: 2 }).record.notes.map((n) => n.pitch)).not.toEqual(
      a.map((n) => n.pitch),
    );
  });
  it('does not fill model rests, and slows subdivisions down at a fast tempo', () => {
    const result = fixture();
    const quiet = { ...result, bars: result.bars.map((b) => ({ ...b, notes: [] })) };
    expect(
      realize(quiet, { difficulty: 'medium', task: 'accompany-melody' }).plan.stats.notes,
    ).toBe(0);
    const opts: PerformanceOptions = { difficulty: 'medium', task: 'accompany-melody' };
    expect(realize(result, opts, 240).plan.stats.notes).toBeLessThan(
      realize(result, opts, 92).plan.stats.notes,
    );
  });
  it('retains given minor harmony and slash bass at exact off-grid changes', () => {
    const ids = sequentialIds(),
      doc = createScore({ template: 'piano', measures: 1, ids, now: 'T' });
    const given = applyCommand(doc, {
      type: 'batch',
      commands: [
        {
          type: 'harmony.set',
          chord: {
            id: ids.next('ch'),
            measureId: doc.measures[0]!.id,
            offset: rat(0),
            root: { step: 'A', alter: 0 },
            quality: 'min',
            bass: { step: 'E', alter: 0 },
          },
        },
        {
          type: 'harmony.set',
          chord: {
            id: ids.next('ch'),
            measureId: doc.measures[0]!.id,
            offset: rat(1, 3),
            root: { step: 'F', alter: 0 },
            quality: 'min',
          },
        },
      ],
    }).doc;
    const plan = planComposeImport(given, fixture(1), {
      ids,
      importChords: false,
      performance: { difficulty: 'medium', task: 'accompany-melody', useScoreChords: true },
    });
    const preview = applyCommand(given, { type: 'batch', commands: plan.commands }).doc;
    expect(preview.harmony).toEqual(given.harmony);
    const events = Object.values(preview.content).flatMap((row) =>
      Object.values(row).flatMap((sm) => sm.voices.flat()),
    );
    expect(events.some((e) => e.offset.n === 1 && e.offset.d === 3)).toBe(true);
    const rec = buildScoreRecord(preview, { include: () => true });
    expect(rec.notes.find((n) => n.staff === '2')!.pitch! % 12).toBe(4);
    expect(validateScore(preview)).toEqual([]);
  });
  it('uses concert-pitch range, one player per wind part, and breath gaps across bars', () => {
    const ids = sequentialIds(),
      doc = createScore({ template: 'wind-quintet', measures: 8, tempo: 120, ids, now: 'T' });
    const result = fixture(8),
      infos = measureInfos(doc),
      staff = allStaves(doc)[2]!;
    const raw: PerformanceNote[] = result.bars.flatMap((_, bar) =>
      [note(120), note(24)].map((n) => ({
        staff,
        voice: n.voice,
        slot: `woodwinds:${n.pitch}`,
        midi: n.pitch,
        note: { ...n, group: 'woodwinds' },
        bar,
        start: infos[bar]!.start,
        end: add(infos[bar]!.start, rat(1)),
      })),
    );
    const planned = planPerformance(
      doc,
      result,
      raw,
      infos.map((m) => m.start),
      infos.map((m) => m.length),
      { difficulty: 'easy' },
    );
    expect(planned.report.after.outOfRange).toBe(0);
    expect(planned.report.after.maxSimultaneous).toBe(1);
    expect(planned.notes.every((n) => n.midi! >= 50 && n.midi! <= 94)).toBe(true);
    expect(
      planned.notes.some(
        (n, i) =>
          i + 1 < planned.notes.length &&
          planned.notes[i + 1]!.start.n / planned.notes[i + 1]!.start.d > n.end.n / n.end.d,
      ),
    ).toBe(true);
  });
  it('audits held notes in different slots across a barline before removing their overlap', () => {
    const ids = sequentialIds(),
      doc = createScore({ template: 'piano', measures: 2, ids, now: 'T' });
    const result = fixture(),
      infos = measureInfos(doc),
      staff = allStaves(doc)[0]!;
    const ns = [note(60, '0', '8'), note(100, '0', '4', 1)];
    const raw: PerformanceNote[] = ns.map((n, bar) => ({
      staff,
      voice: bar,
      slot: `keys:${bar}`,
      midi: n.pitch,
      note: n,
      bar,
      start: infos[bar]!.start,
      end: add(infos[bar]!.start, divInt(parseRational(n.duration), 4)),
    }));
    const plan = planPerformance(
      doc,
      result,
      raw,
      infos.map((m) => m.start),
      infos.map((m) => m.length),
      { difficulty: 'medium', pianoTexture: 'model' },
    );
    expect(plan.report.before.maxHandSpan).toBe(40);
    expect(plan.report.before.maxSimultaneous).toBe(2);
    expect(plan.report.after.maxSimultaneous).toBe(1);
    expect(plan.report.after.maxHandSpan).toBe(0);
  });
});

describe('retaining model expression', () => {
  it('keeps safe pitches, velocities, dynamics and accents when adapting original model texture', () => {
    const result = fixture(1);
    const notes = [60, 64, 67].map((pitch, i) => ({
      ...note(pitch, '0', '2'),
      velocity: [61, 74, 99][i]!,
      dynamic: 'mf',
      accent: 1,
      wedge: null,
    }));
    const { plan, record, preview } = realize(
      { ...result, bars: result.bars.map((b) => ({ ...b, notes })) },
      { difficulty: 'medium', task: 'accompany-melody', pianoTexture: 'model' },
    );
    expect(plan.performance!.arrangedPianoParts).toBe(0);
    expect(record.notes.map((n) => [n.pitch, n.velocity, n.dynamic, n.accent])).toEqual(
      notes.map((n) => [n.pitch, n.velocity, n.dynamic, n.accent]),
    );
    expect(record.notes.every((n) => n.on === '0' && n.dur === '2')).toBe(true);
    expect(validateScore(preview)).toEqual([]);
  });
});
