import { SAMPLES, parseScore } from '@cantelvio-score/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../host', () => ({
  IN_ARTIFACT: true,
  LOCAL_SERVICE_UNAVAILABLE: true,
  artifactDownloads: async () => ({ save }),
}));

import { saveScoreAs } from './files';
import { getStore, initStore } from './store';
import { rebrandBuiltinDraft } from './branding';

beforeEach(() => {
  save.mockReset();
  initStore(SAMPLES[0]!.build('en'));
});

describe('restored built-in demo labels', () => {
  it('updates the exact legacy sample author, keeping every musical object intact', () => {
    const sample = SAMPLES[0]!.build('zh');
    const old = { ...sample, meta: { ...sample.meta, composer: 'AIlegro Score demo' } };
    const migrated = rebrandBuiltinDraft(old);
    expect(migrated.meta.composer).toBe('Cantelvio Score demo');
    expect(migrated.content).toBe(old.content);
    expect(migrated.parts).toBe(old.parts);
    expect(migrated.measures).toBe(old.measures);
    expect(old.meta.composer).toBe('AIlegro Score demo');
  });

  it('preserves custom authors and documents that do not match the built-in markers', () => {
    const sample = SAMPLES[0]!.build('zh');
    for (const meta of [
      { ...sample.meta, composer: 'AIlegro Score' },
      { ...sample.meta, composer: 'A composer using AIlegro Score' },
      { ...sample.meta, composer: 'AIlegro Score demo', title: 'My own piece' },
      {
        ...sample.meta,
        composer: 'AIlegro Score demo',
        createdAt: '2026-10-08T00:00:00.000Z',
      },
    ]) {
      const doc = { ...sample, meta };
      expect(rebrandBuiltinDraft(doc)).toBe(doc);
    }
  });

  it('changes the old generated demo title only on the explicitly marked demo draft', () => {
    const sample = SAMPLES[0]!.build('zh');
    const old = {
      ...sample,
      id: 'demo-accompaniment-sc-123',
      meta: {
        ...sample.meta,
        title: 'AIlegro · 旋律与伴奏演示',
        subtitle: '欢乐颂旋律 · 可自由修改与试听',
      },
    };
    expect(rebrandBuiltinDraft(old).meta.title).toBe('Cantelvio · 旋律与伴奏演示');
    const custom = { ...old, id: 'custom-score' };
    expect(rebrandBuiltinDraft(custom)).toBe(custom);
  });
});

describe('Cantelvio score downloads', () => {
  it('uses the new filename while keeping the existing score format readable', async () => {
    const doc = getStore().getState().doc;
    expect(await saveScoreAs()).toBe(true);
    const saved = save.mock.calls[0]![0] as { filename: string; data: string };
    expect(saved.filename).toMatch(/\.cantelvio\.json$/);
    expect(parseScore(saved.data).parts).toEqual(doc.parts);
    expect(parseScore(saved.data).content).toEqual(doc.content);
  });

  it('suggests the new extension when saving a legacy score under a new name', async () => {
    getStore().getState().markSaved('old-score.ailegro.json');
    expect(await saveScoreAs()).toBe(true);
    expect(save).toHaveBeenCalledWith({
      filename: 'old-score.cantelvio.json',
      data: expect.any(String),
    });
  });
});
