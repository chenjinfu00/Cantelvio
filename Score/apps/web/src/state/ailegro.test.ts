// Editor-side AIlegro flow without a browser: defaults, request building, import as suggestions,
// review and accept/reject — the same calls the AIlegro panel makes.
import { SAMPLES, randomIds } from '@ailegro-score/core';
import type { ComposeResult } from '@ailegro-score/ailegro-bridge';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptRun,
  defaultSpec,
  importResult,
  lastContentMeasure,
  newRequest,
  pendingRuns,
  rejectRun,
  toComposeSpec,
} from './ailegro';
import { getStore, initStore } from './store';

function result(requestId: string, startBar: number): ComposeResult {
  return {
    schema: 'ailegro.compose-result/1',
    requestId,
    model: { name: 'test-model' },
    startBar,
    bars: [0, 1].map((bar) => ({
      bar,
      length: '4',
      meter: [4, 4] as const,
      key: { tonic: 7, mode: 0 },
      chords: [{ onset: '0', root: 7, quality: 0 }],
      notes: [
        {
          onset: '0',
          duration: '2',
          group: 'keys' as const,
          voice: 0,
          pitch: 74,
          drum: null,
          velocity: 70,
          dynamic: null,
          accent: 0,
          wedge: null,
        },
        {
          onset: '2',
          duration: '2',
          group: 'keys' as const,
          voice: 0,
          pitch: 71,
          drum: null,
          velocity: 70,
          dynamic: null,
          accent: 0,
          wedge: null,
        },
        {
          onset: '0',
          duration: '4',
          group: 'keys' as const,
          voice: 1,
          pitch: 43,
          drum: null,
          velocity: 70,
          dynamic: null,
          accent: 0,
          wedge: null,
        },
      ],
    })),
  };
}

describe('AIlegro panel flow', () => {
  beforeEach(() => {
    initStore({ ...SAMPLES[0]!.build('zh'), id: randomIds().next('sc') });
  });

  it('continues after the last bar with music, with the score groups', () => {
    const s = getStore().getState();
    expect(lastContentMeasure(s.doc)).toBe(s.doc.measures.length - 1);
    const spec = defaultSpec(s.doc, { kind: 'none' });
    expect(spec).toMatchObject({
      task: 'continue',
      from: s.doc.measures.length,
      count: 4,
      groups: ['keys'],
    });
    expect(toComposeSpec(spec)).not.toHaveProperty('materialParts');
    const range = defaultSpec(s.doc, {
      kind: 'range',
      staffFrom: 0,
      staffTo: 1,
      measureFrom: 2,
      measureTo: 4,
    });
    expect(range).toMatchObject({ from: 2, count: 3 });
  });

  it('imports a result as reviewable suggestions, then accepts or rejects it', () => {
    const before = getStore().getState().doc;
    const request = newRequest(defaultSpec(before, { kind: 'none' }));
    expect(request.schema).toBe('ailegro.compose-request/1');
    expect(request.targets).toEqual([{ group: 'keys', parts: [before.parts[0]!.id] }]);

    expect(importResult(result(request.requestId, before.measures.length))).toBe(true);
    let doc = getStore().getState().doc;
    expect(doc.measures.length).toBe(before.measures.length + 2);
    expect(pendingRuns(doc)).toEqual([
      expect.objectContaining({
        runId: request.requestId,
        model: 'test-model',
        notes: 6,
        chords: 2,
        firstMeasure: before.measures.length,
        lastMeasure: before.measures.length + 1,
      }),
    ]);

    acceptRun(request.requestId);
    doc = getStore().getState().doc;
    expect(pendingRuns(doc)).toEqual([]);

    // a second run is rejected: only its notes disappear
    const second = newRequest(defaultSpec(doc, { kind: 'none' }));
    expect(importResult(result(second.requestId, doc.measures.length))).toBe(true);
    expect(pendingRuns(getStore().getState().doc)).toHaveLength(1);
    rejectRun(second.requestId);
    const after = getStore().getState().doc;
    expect(pendingRuns(after)).toEqual([]);
    expect(lastContentMeasure(after)).toBe(before.measures.length + 1);

    // undo brings the rejected suggestion back
    getStore().getState().undo();
    expect(pendingRuns(getStore().getState().doc)).toHaveLength(1);
  });

  it('refuses files that are not compose results', () => {
    const s = getStore().getState();
    expect(importResult({ schema: 'something-else' } as unknown as ComposeResult)).toBe(false);
    expect(getStore().getState().toast?.kind).toBe('error');
    expect(getStore().getState().doc).toBe(s.doc);
  });
});
