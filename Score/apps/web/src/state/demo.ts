/** Explicit demo links use their own draft storage and never replace a normal editing draft. */
import {
  SAMPLES,
  applyCommand,
  createScore,
  fillStaves,
  randomIds,
  rat,
  type ScoreDoc,
} from '@cantelvio-score/core';
import { type ComposeTask } from '@cantelvio-score/compose-bridge';
export const DEMO_TASKS: Record<string, ComposeTask> = {
  accompaniment: 'accompany-melody',
  continue: 'continue',
  chords: 'melody-from-chords',
  motif: 'develop-motif',
  orchestrate: 'orchestrate',
};
export function demoId(): string | null {
  if (typeof window === 'undefined') return null;
  const id = new URLSearchParams(window.location.search).get('demo');
  return id && Object.hasOwn(DEMO_TASKS, id) ? id : null;
}
export function demoDocument(id: string): ScoreDoc {
  const ids = randomIds();
  if (id === 'orchestrate')
    return { ...SAMPLES[2]!.build('zh'), id: `demo-${id}-${ids.next('sc')}` };
  if (id === 'continue') return { ...SAMPLES[0]!.build('zh'), id: `demo-${id}-${ids.next('sc')}` };
  const base = createScore({
    template: 'violin-piano',
    title: 'Cantelvio · 旋律与伴奏演示',
    subtitle: '欢乐颂旋律 · 可自由修改与试听',
    lang: 'zh',
    measures: 8,
    timeSig: { beats: 4, beatType: 4 },
    keySig: { fifths: 0, mode: 'major' },
    tempo: 92,
    ids,
  });
  let doc = fillStaves(
    base,
    { 0: 'e4 e f g | g f e d | c c d e | e4. d8 d2 | e4 e f g | g f e d | c c d e | d4. c8 c2' },
    ids,
  );
  if (id === 'chords') {
    doc = applyCommand(doc, {
      type: 'batch',
      commands: ['C', 'F', 'G', 'C'].map((step, i) => ({
        type: 'harmony.set' as const,
        chord: {
          id: ids.next('ch'),
          measureId: doc.measures[i]!.id,
          offset: rat(0),
          root: { step: step as 'C' | 'F' | 'G', alter: 0 },
          quality: 'maj',
        },
      })),
    }).doc;
  }
  return { ...doc, id: `demo-${id}-${ids.next('sc')}` };
}
