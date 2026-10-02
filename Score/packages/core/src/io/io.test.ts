import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { createScore } from '../model/create';
import { sequentialIds } from '../model/ids';
import { allStaves } from '../model/query';
import { validateScore } from '../model/validate';
import { pitchName } from '../pitch/pitch';
import { buildPlayback } from '../playback/timeline';
import { SAMPLES } from '../samples/samples';
import { rat } from '../time/rational';
import { parseScore, serializeScore } from './json';
import { parseText, textToCommands, TextNotationError } from './text';

describe('json', () => {
  it('round-trips every sample exactly', () => {
    for (const s of SAMPLES) {
      const doc = s.build();
      const text = serializeScore(doc);
      const back = parseScore(text);
      expect(back).toEqual(doc);
      expect(serializeScore(back)).toBe(text);
      expect(validateScore(back)).toEqual([]);
    }
  });

  it('writes readable, line-oriented JSON', () => {
    const text = serializeScore(SAMPLES[0]!.build());
    expect(text).toContain('"format": "ailegro-score"');
    // one event per line with rational and pitch strings
    expect(text).toMatch(
      /\{"id":"e_\d+","kind":"note","offset":"0","duration":"1\/4","notes":\[\{"id":"n_\d+","pitch":"D5"\}\]\}/,
    );
  });

  it('rejects other formats', () => {
    expect(() => parseScore('{"format":"musicxml"}')).toThrow();
    expect(() => parseScore('not json')).toThrow();
  });
});

describe('text notation', () => {
  it('parses notes, chords, rests and tuplets', () => {
    const items = parseText('c4. d8 <e g>2 r4 3{a8 b c} R |');
    expect(items.map((i) => i.kind)).toEqual([
      'note',
      'note',
      'note',
      'rest',
      'note',
      'note',
      'note',
      'measureRest',
      'barCheck',
    ]);
  });

  it('reports errors with positions', () => {
    expect(() => parseText('c4 h4')).toThrow(TextNotationError);
    expect(() => parseText('3{ c8 d')).toThrow(/unterminated/);
  });

  it('follows the key signature and relative octaves', () => {
    const ids = sequentialIds();
    const doc = createScore({ template: 'piano', measures: 2, keySig: { fifths: 2 }, ids });
    const staff = allStaves(doc)[0]!.staff.id;
    const res = textToCommands(
      doc,
      { staffId: staff, voice: 0, measureId: doc.measures[0]!.id, offset: rat(0) },
      "d4 f a d' | cn2 c",
      { ids },
    );
    const names = res.commands.flatMap((c) =>
      c.type === 'note.enter' ? c.pitches.map(pitchName) : [],
    );
    expect(names).toEqual(['D5', 'F#5', 'A5', 'D7', 'C7', 'C#7']);
    expect(res.warnings).toEqual([]);
  });

  it('warns on failed bar checks and extends the score', () => {
    const ids = sequentialIds();
    const doc = createScore({ template: 'piano', measures: 1, ids });
    const staff = allStaves(doc)[0]!.staff.id;
    const res = textToCommands(
      doc,
      { staffId: staff, voice: 0, measureId: doc.measures[0]!.id, offset: rat(0) },
      'c2 | d2 e1',
      { ids },
    );
    expect(res.warnings.length).toBe(1);
    const next = applyCommand(doc, { type: 'batch', commands: res.commands }).doc;
    expect(next.measures.length).toBe(2);
  });

  it('R rests to the barline and overwrites what was there', () => {
    const ids = sequentialIds();
    const doc = createScore({ template: 'piano', measures: 2, ids });
    const staff = allStaves(doc)[0]!.staff.id;
    const at = { staffId: staff, voice: 0, measureId: doc.measures[0]!.id, offset: rat(0) };
    const write = (d: typeof doc, text: string) =>
      applyCommand(d, { type: 'batch', commands: textToCommands(d, at, text, { ids }).commands })
        .doc;
    const filled = write(doc, 'e4 f g a | b1');
    const next = write(filled, 'c4 R | R');
    const bar = (i: number) =>
      next.content[staff]?.[next.measures[i]!.id]?.voices[0]?.map((e) =>
        e.notes.map((n) => pitchName(n.pitch)).join('+'),
      ) ?? [];
    expect(bar(0)).toEqual(['C5']);
    expect(bar(1)).toEqual([]);
    expect(next.measures.length).toBe(2);
    expect(validateScore(next)).toEqual([]);
  });
});

describe('playback', () => {
  it('times notes with the tempo and merges ties', () => {
    const ids = sequentialIds();
    let doc = createScore({ template: 'piano', measures: 2, tempo: 120, ids });
    const staff = allStaves(doc)[0]!.staff.id;
    const res = textToCommands(
      doc,
      { staffId: staff, voice: 0, measureId: doc.measures[0]!.id, offset: rat(0) },
      'c4~ c4 d2',
      { ids },
    );
    doc = applyCommand(doc, { type: 'batch', commands: res.commands }).doc;
    const p = buildPlayback(doc);
    expect(p.notes.length).toBe(2);
    expect(p.notes[0]!.start).toBe(0);
    expect(p.notes[0]!.duration).toBeCloseTo(1.0); // two tied quarters at 120 qpm
    expect(p.notes[1]!.start).toBeCloseTo(1.0);
    expect(p.totalSeconds).toBeCloseTo(4);
  });
});
