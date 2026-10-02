/**
 * Demo scores (original material written for this project), built with the text notation so they
 * double as end-to-end fixtures for the model, the engraver and the AIlegro bridge.
 */
import { applyCommand } from '../commands/apply';
import type { Command } from '../commands/types';
import { createScore, type CreateScoreOptions } from '../model/create';
import { sequentialIds, type IdGenerator } from '../model/ids';
import { allStaves } from '../model/query';
import type { ScoreDoc } from '../model/types';
import { textToCommands } from '../io/text';
import { rat } from '../time/rational';

/** Write text into staves starting at bar 1. `music[i]` goes to staff i (voice 1) unless keyed. */
export function fillStaves(
  doc: ScoreDoc,
  music: Record<number, string | string[]>,
  ids: IdGenerator,
): ScoreDoc {
  const staves = allStaves(doc);
  let current = doc;
  for (const [indexText, value] of Object.entries(music)) {
    const staff = staves[Number(indexText)];
    if (!staff) throw new Error(`no staff ${indexText}`);
    const voices = Array.isArray(value) ? value : [value];
    voices.forEach((text, voice) => {
      if (!text.trim()) return;
      const r = textToCommands(
        current,
        { staffId: staff.staff.id, voice, measureId: current.measures[0]!.id, offset: rat(0) },
        text,
        { ids },
      );
      if (r.warnings.length) throw new Error(`sample text warnings: ${r.warnings.join('; ')}`);
      const batch: Command = { type: 'batch', commands: r.commands };
      current = applyCommand(current, batch).doc;
    });
  }
  return current;
}

export interface SampleInfo {
  readonly id: string;
  readonly title: { readonly en: string; readonly zh: string };
  readonly build: (lang?: 'en' | 'zh') => ScoreDoc;
}

function build(options: CreateScoreOptions, music: Record<number, string | string[]>): ScoreDoc {
  const ids = options.ids ?? sequentialIds();
  const doc = createScore({ ...options, ids, now: '2026-10-01T00:00:00.000Z' });
  return fillStaves(doc, music, ids);
}

export function samplePianoPiece(lang: 'en' | 'zh' = 'en'): ScoreDoc {
  return build(
    {
      template: 'piano',
      lang,
      title: lang === 'zh' ? 'G 大调小练习曲' : 'Little Study in G',
      composer: 'AIlegro Score demo',
      measures: 8,
      timeSig: { beats: 4, beatType: 4 },
      keySig: { fifths: 1, mode: 'major' },
      tempo: 96,
    },
    {
      0: 'd4 g,8 a b c d4 | e4 c8 d e f g4 | d4. c8 b4 a | g2 r4 d | e8 f g a b4 g | c4 b8 a g4 f | g8 a b c d4 <b d> | <g b d>2. r4',
      1: "g,2 <b d>2 | c2 <e g>2 | d2 f,2 | g4 d' g, r | c2 e2 | a,2 d2 | g,2 d'2 | g,1",
    },
  );
}

export function sampleStringQuartet(lang: 'en' | 'zh' = 'en'): ScoreDoc {
  return build(
    {
      template: 'string-quartet',
      lang,
      title: lang === 'zh' ? '众赞歌' : 'Chorale',
      composer: 'AIlegro Score demo',
      measures: 8,
      timeSig: { beats: 4, beatType: 4 },
      keySig: { fifths: -1, mode: 'major' },
      tempo: 72,
    },
    {
      0: "a2 b4 c | d2 c | b4 a g a | f1 | c'4 d e f | g2 f4 e | d4 c b a | g1",
      1: "f2 g4 a | b2 a | g4 f e f | c1 | a'4 b c d | e2 d4 c | b4 a g f | e1",
      2: 'c2 d4 c | d2 c | d4 c c c | a1 | c4 d e f | g2 a4 g | f4 f e d | c1',
      3: "f2 c4 f | b,2 f' | b,4 c c c | f1 | f4 e d b | c2 f4 a | b4 f g c | f,1",
    },
  );
}

export function sampleOrchestra(lang: 'en' | 'zh' = 'en'): ScoreDoc {
  return build(
    {
      template: 'classical-orchestra',
      lang,
      title: lang === 'zh' ? '序曲片段' : 'Overture Fragment',
      composer: 'AIlegro Score demo',
      measures: 6,
      timeSig: { beats: 4, beatType: 4 },
      keySig: { fifths: 0, mode: 'major' },
      tempo: 120,
    },
    {
      0: "g'4. e8 g4 c | b4. a8 g2 | a8 b c d e4 c | d2 g, | e'8 d c b c4 a | g1",
      1: 'e2 g4 e | d2 b | c2 e4 c | b2 r | c2 e | d1',
      2: 'c,2 e4 g | g2 d | e2 a4 e | d2 r | e2 c4 f | d1',
      3: 'c2 c | g2 g | f2 a | g2 g | c2 f, | g1',
      4: 'c,1 | d1 | c1 | d2 r | c1 | d1',
      5: 'c4 r c r | d4 r d r | c4 r c r | d2 r | c4 c c c | d1',
      6: 'c4 r c r | g4 r g r | c4 r c r | g2 r | c4 c c c | g1',
      7: "g4. e8 g4 c | b4. a8 g2 | a8 b c d e4 c | d2 g, | e'8 d c b c4 a | g1",
      8: 'c8 e g e c e g e | d8 g b g d g b g | c,8 e a e c e a e | b8 d g d b2 | c8 e g e c f a f | <g b>1',
      9: "g8 c e c g c e c | g8 b d b g b d b | a8 c e c a c e c | g8 b d b g2 | g8 c e c a c f c | <g d'>1",
      10: 'c,4 e g e | g4 b d b | a4 c f c | g2 g | c4 a f a | g1',
      11: 'c,4 c c c | g4 g g g | f4 f f f | g2 g | c4 f, f f | g1',
    },
  );
}

/** Ornaments, grace notes, slurs, hairpins, octave lines, trill lines, pedal and tremolo. */
export function sampleOrnaments(lang: 'en' | 'zh' = 'en'): ScoreDoc {
  return build(
    {
      template: 'piano',
      lang,
      title: lang === 'zh' ? '装饰音与线条' : 'Ornaments and Lines',
      composer: 'AIlegro Score demo',
      measures: 8,
      timeSig: { beats: 4, beatType: 4 },
      keySig: { fifths: 0, mode: 'major' },
      tempo: 72,
    },
    {
      0:
        'c4\\p\\<( e g c) | d2\\f\\trill c4-. b-. | \\appoggiatura b8 a4( g f e) | ' +
        "d2\\fermata r4 \\acciaccatura f8 g4 | \\8va c'4\\mp( d e f) | " +
        'g2\\startTrillSpan g4\\stopTrillSpan \\loco r4 | <c,,, e g c>2\\arpeggio\\> <b d g>2 | ' +
        '<c e g c>1\\pp\\fermata\\arpeggioUp',
      1:
        "c1\\sustainOn | g2\\sustainOff\\sustainOn g'2 | f2\\sustainOff\\sustainOn c2 | " +
        "g2:16\\sustainOff r2 | <c g'>1 | <b g'>1 | c2 g2 | \\8vb c,1\\sustainOn",
    },
  );
}

export const SAMPLES: readonly SampleInfo[] = [
  {
    id: 'piano',
    title: { en: 'Little Study in G (piano)', zh: '小步舞曲练习（钢琴）' },
    build: samplePianoPiece,
  },
  {
    id: 'string-quartet',
    title: { en: 'Chorale (string quartet)', zh: '众赞歌（弦乐四重奏）' },
    build: sampleStringQuartet,
  },
  {
    id: 'orchestra',
    title: { en: 'Overture Fragment (orchestra)', zh: '序曲片段（管弦乐）' },
    build: sampleOrchestra,
  },
  {
    id: 'ornaments',
    title: { en: 'Ornaments and Lines (piano)', zh: '装饰音与线条（钢琴）' },
    build: sampleOrnaments,
  },
];
