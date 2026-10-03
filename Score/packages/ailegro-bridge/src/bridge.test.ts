import {
  SAMPLES,
  allStaves,
  applyCommand,
  createScore,
  pitchName,
  rat,
  sequentialIds,
  textToCommands,
  validateScore,
  voiceEvents,
  type ScoreDoc,
} from '@ailegro-score/core';
import { describe, expect, it } from 'vitest';
import { buildScoreRecord } from './record';
import { buildComposeRequest } from './request';
import { detectTriplets, planComposeImport } from './result';
import type { ComposeResult } from './schemas';
import { keyFromTonic, spellNote } from './spelling';

function write(doc: ScoreDoc, staff: number, text: string, ids = sequentialIds(500)): ScoreDoc {
  const s = allStaves(doc)[staff]!;
  const res = textToCommands(
    doc,
    { staffId: s.staff.id, voice: 0, measureId: doc.measures[0]!.id, offset: rat(0) },
    text,
    { ids },
  );
  return applyCommand(doc, { type: 'batch', commands: res.commands }).doc;
}

describe('score record', () => {
  it('exports parts, measures and notes in quarter-note units', () => {
    const doc = SAMPLES[1]!.build();
    const rec = buildScoreRecord(doc);
    expect(rec.schema).toBe('ailegro.score-record/1');
    expect(rec.parts.map((p) => p.group)).toEqual([
      'high_strings',
      'high_strings',
      'high_strings',
      'low_strings',
    ]);
    expect(rec.parts[0]!.sound).toBe('strings.violin');
    expect(rec.measures[1]).toMatchObject({
      number: 2,
      on: '4',
      dur: '4',
      meter: [4, 4],
      key: { fifths: -1 },
    });
    const total = Object.values(doc.content).flatMap((m) =>
      Object.values(m).flatMap((sm) => sm.voices.flat().flatMap((e) => e.notes)),
    ).length;
    expect(rec.notes.length).toBe(total);
    expect(rec.notes[0]).toMatchObject({
      on: '0',
      voice: '1',
      staff: '1',
      grace: false,
      unpitched: false,
    });
  });

  it('merges ties and writes transposed pitch', () => {
    const ids = sequentialIds();
    let doc = createScore({ template: 'wind-quintet', measures: 2, ids, now: 'T' });
    doc = write(doc, 2, 'bb2~ bb4 c4 | d1');
    const rec = buildScoreRecord(doc);
    const cl = rec.notes.filter((n) => n.part === doc.parts[2]!.id);
    expect(cl.map((n) => [n.on, n.dur, n.pitch, n.writtenPitch])).toEqual([
      ['0', '3', 70, 72],
      ['3', '1', 72, 74],
      ['4', '4', 74, 76],
    ]);
    expect(cl[0]!.group).toBe('woodwinds');
  });

  it('exports grace notes with zero duration and hairpins as wedges', () => {
    const ids = sequentialIds();
    let doc = createScore({ template: 'piano', measures: 1, ids, now: 'T' });
    doc = write(doc, 0, '\\acciaccatura d8 c4\\< d e f\\!');
    const rec = buildScoreRecord(doc);
    expect(rec.notes.map((n) => [n.on, n.dur, n.pitch, n.grace, n.wedge])).toEqual([
      ['0', '1', 72, false, 'crescendo'],
      ['0', '0', 74, true, 'crescendo'],
      ['1', '1', 74, false, 'crescendo'],
      ['2', '1', 76, false, 'crescendo'],
      ['3', '1', 77, false, null],
    ]);
  });

  it('skips unaccepted AI suggestions by default', () => {
    const ids = sequentialIds();
    const doc = createScore({ template: 'piano', measures: 1, ids, now: 'T' });
    const staff = allStaves(doc)[0]!.staff.id;
    const withAi = applyCommand(doc, {
      type: 'events.insert',
      staffId: staff,
      measureId: doc.measures[0]!.id,
      voice: 0,
      events: [
        {
          id: 'e_ai',
          kind: 'note',
          offset: rat(0),
          duration: rat(1, 4),
          notes: [{ id: 'n_ai', pitch: { step: 'C', alter: 0, octave: 5 } }],
          source: { kind: 'ai', model: 'm', runId: 'r1' },
        },
      ],
    }).doc;
    expect(buildScoreRecord(withAi).notes.length).toBe(0);
    expect(buildScoreRecord(withAi, { include: () => true }).notes.length).toBe(1);
  });
});

describe('compose request', () => {
  it('describes task, material, constraints and targets', () => {
    const doc = SAMPLES[1]!.build();
    const req = buildComposeRequest(
      doc,
      { task: 'continue', from: 4, count: 4, seed: 7 },
      { requestId: 'req-1' },
    );
    expect(req.schema).toBe('ailegro.compose-request/1');
    expect(req.generate.bars).toEqual({ from: 4, count: 4 });
    expect(req.material[0]).toMatchObject({
      kind: 'notes',
      timeSpan: { from: '0', to: '16' },
      hardLock: true,
    });
    expect(req.constraints.find((c) => c.kind === 'key')!.value).toEqual({
      tonic: 5,
      mode: 0,
      fifths: -1,
    });
    expect(req.targets.map((t) => t.group)).toEqual(['high_strings', 'low_strings']);
    // context only: no notes from the bars being generated
    expect(req.score.notes.every((n) => Number(n.on) < 16)).toBe(true);
  });

  it('keeps hard-locked melody inside the generated span', () => {
    const doc = SAMPLES[1]!.build();
    const melody = doc.parts[0]!.id;
    const req = buildComposeRequest(
      doc,
      { task: 'accompany-melody', from: 4, count: 4, materialParts: [melody] },
      { requestId: 'r' },
    );
    expect(req.score.notes.some((n) => n.part === melody && Number(n.on) >= 16)).toBe(true);
    expect(req.score.notes.some((n) => n.part !== melody && Number(n.on) >= 16)).toBe(false);
    expect(req.targets.flatMap((t) => t.parts)).not.toContain(melody);
  });

  it('lets a motif part continue in develop-motif', () => {
    const doc = SAMPLES[0]!.build(); // piano
    const piano = doc.parts[0]!.id;
    const req = buildComposeRequest(
      doc,
      { task: 'develop-motif', from: 2, count: 4, materialParts: [piano] },
      { requestId: 'm' },
    );
    expect(req.material.find((m) => m.kind === 'motif')).toMatchObject({
      parts: [piano],
      timeSpan: { from: '0', to: '8' },
    });
    expect(req.targets).toEqual([{ group: 'keys', parts: [piano] }]);
  });
});

describe('spelling', () => {
  it('spells by key and by chord', () => {
    expect(keyFromTonic(5, 0)).toEqual({ fifths: -1, mode: 'major' });
    expect(keyFromTonic(9, 1)).toEqual({ fifths: 0, mode: 'minor' });
    expect(pitchName(spellNote(70, { fifths: -1 }))).toBe('Bb4');
    // G# in an E major chord in A minor, not Ab
    expect(
      pitchName(spellNote(68, { fifths: 0, mode: 'minor' }, { root: 4, quality: 'maj' })),
    ).toBe('G#4');
    // augmented C chord: G#
    expect(pitchName(spellNote(68, { fifths: 0 }, { root: 0, quality: 'aug' }))).toBe('G#4');
  });
});

describe('compose result import', () => {
  const result: ComposeResult = {
    schema: 'ailegro.compose-result/1',
    requestId: 'run-42',
    model: { name: 'four-pillar-v3.1', step: 123 },
    startBar: 8,
    bars: [
      {
        bar: 0,
        length: '4',
        meter: [4, 4],
        key: { tonic: 5, mode: 0 },
        chords: [
          { onset: '0', root: 5, quality: 0 },
          { onset: '2', root: 10, quality: 0 },
        ],
        notes: [
          {
            onset: '0',
            duration: '2',
            group: 'high_strings',
            voice: 3,
            pitch: 72,
            drum: null,
            velocity: 80,
            dynamic: 'mf',
            accent: 0,
            wedge: null,
          },
          {
            onset: '2',
            duration: '1/3',
            group: 'high_strings',
            voice: 3,
            pitch: 70,
            drum: null,
            velocity: 80,
            dynamic: 'mf',
            accent: 0,
            wedge: null,
          },
          {
            onset: '7/3',
            duration: '1/3',
            group: 'high_strings',
            voice: 3,
            pitch: 69,
            drum: null,
            velocity: 80,
            dynamic: 'mf',
            accent: 1,
            wedge: null,
          },
          {
            onset: '8/3',
            duration: '1/3',
            group: 'high_strings',
            voice: 3,
            pitch: 67,
            drum: null,
            velocity: 80,
            dynamic: 'mf',
            accent: 0,
            wedge: null,
          },
          {
            onset: '3',
            duration: '1',
            group: 'high_strings',
            voice: 3,
            pitch: 65,
            drum: null,
            velocity: 80,
            dynamic: 'mf',
            accent: 0,
            wedge: null,
          },
          {
            onset: '0',
            duration: '4',
            group: 'low_strings',
            voice: 9,
            pitch: 41,
            drum: null,
            velocity: 70,
            dynamic: 'p',
            accent: 0,
            wedge: null,
          },
          {
            onset: '0',
            duration: '4',
            group: 'woodwinds',
            voice: 1,
            pitch: 77,
            drum: null,
            velocity: 70,
            dynamic: null,
            accent: 0,
            wedge: null,
          },
        ],
      },
      {
        bar: 1,
        length: '4',
        meter: [4, 4],
        key: { tonic: 5, mode: 0 },
        chords: [],
        notes: [
          {
            onset: '0',
            duration: '4',
            group: 'high_strings',
            voice: 3,
            pitch: 69,
            drum: null,
            velocity: 80,
            dynamic: 'mf',
            accent: 0,
            wedge: null,
          },
        ],
      },
    ],
  };

  it('writes generated bars as AI suggestions, appending measures', () => {
    const doc = SAMPLES[1]!.build();
    const plan = planComposeImport(doc, result, { ids: sequentialIds(9000) });
    expect(plan.stats.skipped).toBe(1); // woodwinds: no target part in a string quartet
    const next = applyCommand(doc, { type: 'batch', commands: plan.commands }).doc;
    expect(validateScore(next)).toEqual([]);
    expect(next.measures.length).toBe(10);
    const vln1 = allStaves(next)[0]!.staff.id;
    const bar9 = voiceEvents(next, vln1, next.measures[8]!.id, 0);
    expect(bar9.map((e) => e.notes.map((n) => pitchName(n.pitch)).join('+'))).toEqual([
      'C5',
      'Bb4',
      'A4',
      'G4',
      'F4',
    ]);
    expect(
      bar9.every(
        (e) => e.source?.kind === 'ai' && e.source.runId === 'run-42' && !e.source.accepted,
      ),
    ).toBe(true);
    expect(bar9[2]!.articulations).toEqual(['accent']);
    // triplet values become a tuplet span
    expect(next.content[vln1]![next.measures[8]!.id]!.tuplets).toMatchObject([
      { actual: 3, normal: 2, length: rat(1, 4), offset: rat(1, 2) },
    ]);
    const cello = allStaves(next)[3]!.staff.id;
    expect(voiceEvents(next, cello, next.measures[8]!.id, 0)[0]!.notes[0]!.pitch).toMatchObject({
      step: 'F',
      octave: 2,
    });
    expect(
      next.harmony
        .filter((h) => h.source?.kind === 'ai')
        .map((h) => `${h.root.step}${h.root.alter}`),
    ).toEqual(['F0', 'B-1']);

    // accept, then nothing is pending any more
    const accepted = applyCommand(next, { type: 'provenance.accept', runId: 'run-42' }).doc;
    expect(
      voiceEvents(accepted, vln1, accepted.measures[8]!.id, 0).every(
        (e) => e.source?.kind === 'ai' && e.source.accepted,
      ),
    ).toBe(true);
    const afterReject = applyCommand(accepted, { type: 'provenance.reject', runId: 'run-42' }).doc;
    expect(voiceEvents(afterReject, vln1, afterReject.measures[8]!.id, 0).length).toBe(5);
    // reject before accepting removes the suggestion
    const rejected = applyCommand(next, { type: 'provenance.reject', runId: 'run-42' }).doc;
    expect(voiceEvents(rejected, vln1, rejected.measures[8]!.id, 0).length).toBe(0);
    expect(validateScore(rejected)).toEqual([]);
  });

  it('turns runs of generated wedges into hairpins', () => {
    const doc = SAMPLES[0]!.build(); // piano
    const note = (onset: string, pitch: number, wedge: string | null) => ({
      onset,
      duration: '1',
      group: 'keys' as const,
      voice: 0,
      pitch,
      drum: null,
      velocity: 70,
      dynamic: null,
      accent: 0,
      wedge,
    });
    const res: ComposeResult = {
      schema: 'ailegro.compose-result/1',
      requestId: 'run-wedge',
      model: { name: 'mock' },
      startBar: doc.measures.length,
      bars: [
        {
          bar: 0,
          length: '4',
          meter: [4, 4],
          key: { tonic: 7, mode: 0 },
          chords: [],
          notes: [
            note('0', 74, 'crescendo'),
            note('1', 76, 'crescendo'),
            note('2', 78, 'diminuendo'),
            note('3', 79, null),
          ],
        },
      ],
    };
    const plan = planComposeImport(doc, res, { ids: sequentialIds(9700) });
    const next = applyCommand(doc, { type: 'batch', commands: plan.commands }).doc;
    expect(validateScore(next)).toEqual([]);
    expect(next.spanners.map((s) => (s.kind === 'hairpin' ? s.direction : s.kind))).toEqual([
      'crescendo',
      'diminuendo',
    ]);
    const rejected = applyCommand(next, { type: 'provenance.reject', runId: 'run-wedge' }).doc;
    expect(rejected.spanners).toEqual([]);
  });

  it('puts a keyboard bass slot in voice 1 of the lower staff, not voice 2', () => {
    const doc = SAMPLES[0]!.build(); // piano
    const note = (onset: string, duration: string, voice: number, pitch: number) => ({
      onset,
      duration,
      group: 'keys' as const,
      voice,
      pitch,
      drum: null,
      velocity: 70,
      dynamic: null,
      accent: 0,
      wedge: null,
    });
    const piano: ComposeResult = {
      schema: 'ailegro.compose-result/1',
      requestId: 'run-piano',
      model: { name: 'mock' },
      startBar: doc.measures.length,
      bars: [
        {
          bar: 0,
          length: '4',
          meter: [4, 4],
          key: { tonic: 7, mode: 0 },
          chords: [],
          notes: [note('0', '2', 0, 74), note('2', '2', 0, 71), note('0', '4', 1, 43)],
        },
      ],
    };
    const plan = planComposeImport(doc, piano, { ids: sequentialIds(9500) });
    const next = applyCommand(doc, { type: 'batch', commands: plan.commands }).doc;
    expect(validateScore(next)).toEqual([]);
    const [upper, lower] = allStaves(next).map((s) => s.staff.id);
    const bar = next.measures[next.measures.length - 1]!.id;
    expect(voiceEvents(next, upper!, bar, 0).map((e) => pitchName(e.notes[0]!.pitch))).toEqual([
      'D5',
      'B4',
    ]);
    expect(voiceEvents(next, lower!, bar, 0).map((e) => pitchName(e.notes[0]!.pitch))).toEqual([
      'G2',
    ]);
    expect(voiceEvents(next, lower!, bar, 1)).toEqual([]);
  });

  it('detects triplet spans', () => {
    const e = (on: [number, number], dur: [number, number]) => ({
      id: 'x',
      kind: 'note' as const,
      offset: rat(...on),
      duration: rat(...dur),
      notes: [],
    });
    expect(
      detectTriplets(
        [e([0, 1], [1, 12]), e([1, 12], [1, 12]), e([1, 6], [1, 12]), e([1, 4], [3, 4])],
        rat(1),
      ),
    ).toEqual([{ offset: rat(0), length: rat(1, 4) }]);
    expect(
      detectTriplets([e([0, 1], [1, 6]), e([1, 6], [1, 6]), e([1, 3], [1, 6])], rat(1)),
    ).toEqual([{ offset: rat(0), length: rat(1, 2) }]);
  });
});
