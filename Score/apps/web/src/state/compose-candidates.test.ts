import {
  allStaves,
  applyCommand,
  createScore,
  fillStaves,
  rat,
  sequentialIds,
  validateScore,
  type ScoreDoc,
} from '@cantelvio-score/core';
import type { ComposeRequest, ComposeResult } from '@cantelvio-score/compose-bridge';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSpec, type PanelSpec } from './ailegro';
import { initStore, getStore } from './store';
import {
  acceptCandidate,
  clearCandidates,
  cancelCandidates,
  fullCandidateScope,
  generateCandidates,
  useComposeCandidates,
} from './compose-candidates';

let doc: ScoreDoc, spec: PanelSpec;
const current = () => getStore().getState();
const candidate = () => useComposeCandidates.getState().candidates[0]!;
function result(request: ComposeRequest): ComposeResult {
  return {
    schema: 'ailegro.compose-result/1',
    requestId: request.requestId,
    model: { name: 'fixture' },
    startBar: request.generate.bars.from,
    bars: Array.from({ length: request.generate.bars.count }, (_, bar) => ({
      bar,
      length: '4',
      meter: [4, 4],
      key: { tonic: 0, mode: 0 },
      chords: [{ onset: '0', root: 0, quality: 0 }],
      notes: [0, 1].map((voice) => ({
        onset: '0',
        duration: '1/3',
        group: 'high_strings',
        voice,
        pitch: voice === 0 ? 84 : 72,
        drum: null,
        velocity: 80,
        dynamic: 'mf',
        accent: 0,
        wedge: null,
      })),
    })),
  };
}
function mockResult(transform: (r: ComposeResult) => ComposeResult = (r) => r) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url: unknown, init: RequestInit) =>
        new Response(
          JSON.stringify(transform(result(JSON.parse(init.body as string) as ComposeRequest))),
        ),
    ),
  );
}
function staffContent(d: ScoreDoc, part: number) {
  return d.content[d.parts[part]!.staves[0]!.id];
}

beforeEach(() => {
  clearCandidates();
  const ids = sequentialIds();
  doc = fillStaves(
    createScore({ template: 'string-quartet', measures: 4, ids, now: 'T' }),
    {
      0: "c'1 | d1 | e1 | f1",
      1: "g'1 | a1 | b1 | c1",
      2: 'c1 | d1 | e1 | f1',
      3: 'c1 | d1 | e1 | f1',
    },
    ids,
  );
  initStore(doc);
  spec = {
    ...defaultSpec(doc, { kind: 'none' }),
    task: 'continue',
    from: 0,
    count: 2,
    groups: ['high_strings'],
    chordMode: 'free',
    difficulty: undefined,
  };
  mockResult();
});
afterEach(() => {
  clearCandidates();
  vi.unstubAllGlobals();
});

describe('reviewing generated candidates', () => {
  it('keeps the edited score untouched, preserves exact rhythm in previews and varies candidate seeds', async () => {
    await generateCandidates('http://local', spec, 3);
    expect(current().doc).toBe(doc);
    expect(useComposeCandidates.getState().candidates).toHaveLength(3);
    const requests = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => JSON.parse(init!.body as string) as ComposeRequest);
    expect(requests.map((r) => r.generate.sampling.seed)).toEqual([1, 2, 3]);
    const notes = Object.values(candidate().preview.content).flatMap((row) =>
      Object.values(row).flatMap((m) => m.voices.flat()),
    );
    expect(notes.some((e) => e.duration.n === 1 && e.duration.d === 12)).toBe(true);
    expect(validateScore(candidate().preview)).toEqual([]);
  });
  it('accepts only selected bars and parts using the full candidate mapping, and undoes in one step', async () => {
    await generateCandidates('http://local', spec);
    const c = candidate(),
      second = doc.parts[1]!;
    const scope = { ...fullCandidateScope(c), from: 0, to: 0, parts: [second.id], chords: false };
    expect(acceptCandidate(c, scope)).toBe(true);
    const accepted = current().doc;
    expect(staffContent(accepted, 0)).toEqual(staffContent(doc, 0));
    expect(staffContent(accepted, 2)).toEqual(staffContent(doc, 2));
    expect(staffContent(accepted, 1)![doc.measures[1]!.id]).toEqual(
      staffContent(doc, 1)![doc.measures[1]!.id],
    );
    const music = (d: ScoreDoc) => {
      const measure = staffContent(d, 1)![doc.measures[0]!.id]!;
      return measure.voices
        .flat()
        .map((e) => ({ offset: e.offset, duration: e.duration, notes: e.notes }));
    };
    expect(music(accepted)).toEqual(music(c.preview));
    expect(validateScore(accepted)).toEqual([]);
    current().undo();
    expect(current().doc).toEqual(doc);
    expect(current().session.canUndo).toBe(false);
  });
  it('ends generated tails at the requested boundary without rewriting following music', async () => {
    mockResult((r) => ({
      ...r,
      bars: r.bars.map((b, i) => ({
        ...b,
        notes: b.notes.map((n) => ({
          ...n,
          onset: '0',
          duration: i === r.bars.length - 1 ? '12' : n.duration,
        })),
      })),
    }));
    await generateCandidates('http://local', spec);
    const c = candidate();
    expect(c.clippedTails).toBe(2);
    expect(c.result.bars[1]!.notes[0]!.duration).toBe('12');
    expect(acceptCandidate(c)).toBe(true);
    for (const staff of allStaves(doc))
      for (const m of doc.measures.slice(2))
        expect(current().doc.content[staff.staff.id]?.[m.id]).toEqual(
          doc.content[staff.staff.id]?.[m.id],
        );
    expect(validateScore(current().doc)).toEqual([]);
  });
  it('accepts chordal candidates after their command payloads have been frozen by preview', async () => {
    mockResult((r) => ({
      ...r,
      bars: r.bars.map((b) => ({ ...b, notes: [...b.notes, { ...b.notes[0]!, pitch: 79 }] })),
    }));
    await generateCandidates('http://local', spec);
    const c = candidate();
    expect(
      Object.values(c.preview.content)
        .flatMap((row) => Object.values(row).flatMap((m) => m.voices.flat()))
        .some((e) => e.notes.length > 1),
    ).toBe(true);
    expect(acceptCandidate(c)).toBe(true);
    expect(validateScore(current().doc)).toEqual([]);
    current().undo();
    expect(current().doc).toEqual(doc);
  });
  it('rejects a result after any document edit', async () => {
    await generateCandidates('http://local', spec);
    const c = candidate();
    current().apply({
      type: 'harmony.set',
      chord: {
        id: 'edit',
        measureId: doc.measures[0]!.id,
        offset: rat(0),
        root: { step: 'F', alter: 0 },
        quality: 'maj',
      },
    });
    const edited = current().doc;
    expect(() => acceptCandidate(c)).toThrow();
    expect(current().doc).toBe(edited);
  });
  it('discards late responses after cancellation, even when the service ignores abort', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise<Response>((done) => {
            resolve = () =>
              done(new Response(JSON.stringify(result(JSON.parse(init.body as string)))));
          }),
      ),
    );
    const generating = generateCandidates('http://local', spec);
    cancelCandidates();
    resolve(new Response());
    await generating;
    expect(useComposeCandidates.getState().candidates).toHaveLength(0);
    expect(current().doc).toBe(doc);
    expect(useComposeCandidates.getState().busy).toBe(false);
  });
  it.each(['requestId', 'startBar', 'bars'] as const)('rejects a mismatched %s', async (field) => {
    mockResult((r) => ({
      ...r,
      [field]: field === 'requestId' ? 'wrong' : field === 'startBar' ? 9 : [],
    }));
    await expect(generateCandidates('http://local', spec)).rejects.toThrow();
    expect(current().doc).toBe(doc);
    expect(useComposeCandidates.getState().candidates).toHaveLength(0);
  });
  it('replaces existing chord symbols consistently in preview and acceptance, with undo', async () => {
    const old = {
      id: 'old',
      measureId: doc.measures[0]!.id,
      offset: rat(0),
      root: { step: 'F' as const, alter: 0 },
      quality: 'maj' as const,
    };
    doc = applyCommand(doc, { type: 'harmony.set', chord: old }).doc;
    initStore(doc);
    await generateCandidates('http://local', spec);
    const c = candidate();
    expect(c.preview.harmony.filter((h) => h.measureId === old.measureId)).toHaveLength(1);
    expect(c.preview.harmony.some((h) => h.id === 'old')).toBe(false);
    expect(acceptCandidate(c)).toBe(true);
    expect(current().doc.harmony.some((h) => h.id === 'old')).toBe(false);
    current().undo();
    expect(current().doc).toEqual(doc);
  });
  it('preserves given harmony and refuses an acceptance that asks to overwrite it', async () => {
    doc = applyCommand(doc, {
      type: 'harmony.set',
      chord: {
        id: 'given',
        measureId: doc.measures[0]!.id,
        offset: rat(0),
        root: { step: 'F', alter: 0 },
        quality: 'maj',
      },
    }).doc;
    initStore(doc);
    await generateCandidates('http://local', { ...spec, chordMode: 'given' });
    const c = candidate();
    expect(c.preview.harmony).toEqual(doc.harmony);
    expect(() => acceptCandidate(c, { ...fullCandidateScope(c), chords: true })).toThrow();
    expect(acceptCandidate(c)).toBe(true);
    expect(current().doc.harmony).toEqual(doc.harmony);
  });
  it('refuses a partial acceptance that severs an existing sustained note', async () => {
    const staff = allStaves(doc)[1]!.staff.id;
    doc = applyCommand(doc, {
      type: 'range.clear',
      staffIds: [staff],
      from: { measureId: doc.measures[0]!.id, offset: rat(0) },
      to: { measureId: doc.measures[1]!.id, offset: rat(1) },
    }).doc;
    doc = applyCommand(doc, {
      type: 'events.insert',
      staffId: staff,
      measureId: doc.measures[0]!.id,
      voice: 0,
      events: [
        {
          id: 'long',
          kind: 'note',
          offset: rat(0),
          duration: rat(2),
          notes: [{ id: 'long-note', pitch: { step: 'C', alter: 0, octave: 4 } }],
        },
      ],
    }).doc;
    initStore(doc);
    await generateCandidates('http://local', spec);
    const c = candidate();
    expect(() =>
      acceptCandidate(c, { ...fullCandidateScope(c), to: 0, parts: [doc.parts[1]!.id] }),
    ).toThrow();
    expect(current().doc).toBe(doc);
  });
});

describe('candidate performance realization', () => {
  it('captures difficulty, preserves raw model notes and given melody, and accepts/undoes the adapted notes', async () => {
    const ids = sequentialIds();
    doc = fillStaves(
      createScore({ template: 'violin-piano', measures: 4, ids, now: 'T' }),
      { 0: 'c1 | d1 | e1 | f1' },
      ids,
    );
    initStore(doc);
    spec = {
      ...defaultSpec(doc, { kind: 'none' }),
      task: 'accompany-melody',
      from: 0,
      count: 2,
      groups: ['keys'],
      materialParts: [doc.parts[0]!.id],
      difficulty: 'advanced',
      maxHandSpan: 7,
      pianoTexture: 'chords',
    };
    mockResult((r) => ({
      ...r,
      bars: r.bars.map((b) => ({
        ...b,
        notes: b.notes.map((n, i) => ({ ...n, group: 'keys', pitch: i ? 24 : 110, duration: '4' })),
      })),
    }));
    await generateCandidates('http://local', spec);
    const c = candidate();
    expect(current().doc).toBe(doc);
    expect(c.result.bars[0]!.notes[0]!.pitch).toBe(110);
    expect(c.performance).toMatchObject({
      difficulty: 'advanced',
      handSpanLimit: 7,
      arrangedPianoParts: 1,
      after: { outOfRange: 0 },
    });
    expect(c.performance!.after.maxHandSpan).toBeLessThanOrEqual(7);
    expect(staffContent(c.preview, 0)).toEqual(staffContent(doc, 0));
    expect(acceptCandidate(c)).toBe(true);
    expect(staffContent(current().doc, 0)).toEqual(staffContent(doc, 0));
    expect(validateScore(current().doc)).toEqual([]);
    const piano = doc.parts[1]!;
    for (const s of piano.staves) {
      const music = (d: ScoreDoc) =>
        Object.values(d.content[s.id]!)
          .flatMap((m) => m.voices.flat())
          .map((e) => ({ offset: e.offset, duration: e.duration, notes: e.notes }));
      expect(music(current().doc)).toEqual(music(c.preview));
    }
    current().undo();
    expect(current().doc).toEqual(doc);
  });
});

describe('default piano texture', () => {
  it('uses adapted model notes by default and leaves returned chords unchanged', async () => {
    const ids = sequentialIds();
    doc = fillStaves(
      createScore({ template: 'violin-piano', measures: 4, ids, now: 'T' }),
      { 0: 'c1 | d1 | e1 | f1' },
      ids,
    );
    initStore(doc);
    const defaults = defaultSpec(doc, { kind: 'none' });
    expect(defaults.pianoTexture).toBe('model');
    spec = {
      ...defaults,
      task: 'accompany-melody',
      from: 0,
      count: 2,
      groups: ['keys'],
      materialParts: [doc.parts[0]!.id],
    };
    mockResult((r) => ({
      ...r,
      bars: r.bars.map((b) => ({
        ...b,
        notes: b.notes.map((n, i) => ({
          ...n,
          group: 'keys',
          pitch: i ? 67 : 64,
          duration: '2',
          velocity: 92,
          dynamic: 'mf',
          accent: 1,
        })),
      })),
    }));
    await generateCandidates('http://local', spec);
    const c = candidate();
    expect(c.performance!.pianoTexture).toBe('model');
    expect(c.performance!.arrangedPianoParts).toBe(0);
    expect(c.preview.harmony.map((h) => [h.root.step, h.quality])).toEqual([
      ['C', 'maj'],
      ['C', 'maj'],
    ]);
    expect(c.result.bars.map((b) => b.chords)).toEqual(result(c.request).bars.map((b) => b.chords));
    expect(staffContent(c.preview, 0)).toEqual(staffContent(doc, 0));
    expect(validateScore(c.preview)).toEqual([]);
  });
});
