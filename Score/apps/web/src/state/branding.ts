import { SAMPLES, type ScoreDoc } from '@cantelvio-score/core';

/** Update only labels identified as built-in demo metadata, never a user's author or title. */
export function rebrandBuiltinDraft(doc: ScoreDoc): ScoreDoc {
  const builtinComposer =
    doc.meta.composer === 'AIlegro Score demo' &&
    doc.meta.createdAt === '2026-10-01T00:00:00.000Z' &&
    SAMPLES.some((sample) =>
      (['en', 'zh'] as const).some((lang) => sample.build(lang).meta.title === doc.meta.title),
    );
  const builtinTitle =
    doc.id.startsWith('demo-') &&
    doc.meta.title === 'AIlegro · 旋律与伴奏演示' &&
    doc.meta.subtitle === '欢乐颂旋律 · 可自由修改与试听';
  if (!builtinComposer && !builtinTitle) return doc;
  return {
    ...doc,
    meta: {
      ...doc.meta,
      ...(builtinComposer ? { composer: 'Cantelvio Score demo' } : {}),
      ...(builtinTitle ? { title: 'Cantelvio · 旋律与伴奏演示' } : {}),
    },
  };
}
