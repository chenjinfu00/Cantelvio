import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { createScore } from '../model/create';
import { sequentialIds } from '../model/ids';
import { allStaves } from '../model/query';
import { validateScore } from '../model/validate';
import { pitchName } from '../pitch/pitch';
import { spannerTimes } from '../model/spanners';
import { buildPlayback } from '../playback/timeline';
import { SAMPLES } from '../samples/samples';
import { rat, toString } from '../time/rational';
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

describe('text notation v1 marks', () => {
  const setup = (measures = 2) => {
    const ids = sequentialIds();
    const doc = createScore({ template: 'piano', measures, ids });
    const staff = allStaves(doc)[0]!.staff.id;
    const at = { staffId: staff, voice: 0, measureId: doc.measures[0]!.id, offset: rat(0) };
    const write = (text: string) => {
      const res = textToCommands(doc, at, text, { ids });
      return { res, doc: applyCommand(doc, { type: 'batch', commands: res.commands }).doc };
    };
    return { staff, write };
  };

  it('parses articulations, ornaments, tremolo and dynamics after notes', () => {
    const items = parseText('c4-. d-> e-_ f-^ g\\fermata a\\trill b:16 <c e g>\\arpeggio\\ff');
    const marks = items.map((i) => (i.kind === 'note' ? i.marks : undefined));
    expect(marks[0]!.articulations).toEqual(['staccato']);
    expect(marks[1]!.articulations).toEqual(['accent']);
    expect(marks[2]!.articulations).toEqual(['tenuto', 'staccato']);
    expect(marks[3]!.articulations).toEqual(['marcato']);
    expect(marks[4]!.articulations).toEqual(['fermata']);
    expect(marks[5]!.ornament).toBe('trill');
    expect(marks[6]!.tremolo).toBe(2);
    expect(marks[7]).toMatchObject({ arpeggio: 'normal', dynamic: 'ff' });
    expect(() => parseText('\\p c4')).toThrow(/must follow a note/);
    expect(() => parseText('c4 \\acciaccatura d8')).toThrow(/following note/);
    expect(() => parseText('r4-.')).toThrow(/needs a note/);
  });

  it('writes marks, grace notes and lines into the score', () => {
    const { staff, write } = setup(3);
    const { res, doc } = write(
      "c4\\p\\< d( e f) | \\acciaccatura a8 g4\\f\\sustainOn a\\mordent b\\sustainOff c'-. | " +
        '\\8va d1\\startTrillSpan',
    );
    expect(res.warnings).toEqual([]);
    expect(validateScore(doc)).toEqual([]);
    const bar = (i: number) => doc.content[staff]![doc.measures[i]!.id]!.voices[0]!;
    expect(bar(1)[0]!.graces!.map((g) => [g.slash, pitchName(g.notes[0]!.pitch)])).toEqual([
      [true, 'A5'],
    ]);
    expect(bar(1)[1]!.ornament).toBe('mordent');
    expect(bar(1)[3]!.articulations).toEqual(['staccato']);
    const dyn = (i: number) =>
      doc.content[staff]![doc.measures[i]!.id]!.dynamics!.map((d) => d.value);
    expect(dyn(0)).toEqual(['p']);
    expect(dyn(1)).toEqual(['f']);
    const lines = doc.spanners.map((sp) => {
      const t = spannerTimes(doc, sp)!;
      return `${sp.kind}:${toString(t.start)}-${toString(t.end)}`;
    });
    expect(lines.sort()).toEqual(
      ['hairpin:0-1', 'slur:1/4-1', 'pedal:1-3/2', 'ottava:2-3', 'trill:2-3'].sort(),
    );
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

  const play = (text: string, measures = 2) => {
    const ids = sequentialIds();
    let doc = createScore({ template: 'piano', measures, tempo: 120, ids });
    const staff = allStaves(doc)[0]!.staff.id;
    const res = textToCommands(
      doc,
      { staffId: staff, voice: 0, measureId: doc.measures[0]!.id, offset: rat(0) },
      text,
      { ids },
    );
    doc = applyCommand(doc, { type: 'batch', commands: res.commands }).doc;
    return buildPlayback(doc).notes;
  };

  it('plays grace notes on the beat, taking time from the principal', () => {
    const notes = play('\\appoggiatura d8 c2 \\acciaccatura e8 d2');
    expect(notes.map((n) => [n.midi, toString(n.at), toString(n.length)])).toEqual([
      [74, '0', '1/8'],
      [72, '1/8', '3/8'],
      [76, '1/2', '1/32'],
      [74, '17/32', '15/32'],
    ]);
  });

  it('plays ornaments, tremolos and rolled chords', () => {
    const trill = play('c4\\trill');
    expect(trill.length).toBe(8); // 32nds over a quarter
    expect(trill.slice(0, 3).map((n) => n.midi)).toEqual([72, 74, 72]);
    expect(play('c4\\mordent').map((n) => n.midi)).toEqual([72, 71, 72]);
    expect(play('c4\\turn').map((n) => n.midi)).toEqual([74, 72, 71, 72]);
    expect(play('c4:16').length).toBe(4);
    const rolled = play('<c e g>2\\arpeggio');
    expect(rolled.map((n) => [n.midi, toString(n.at)])).toEqual([
      [72, '0'],
      [76, '1/64'],
      [79, '1/32'],
    ]);
  });

  it('holds notes under the pedal, ramps hairpins and binds slurred notes', () => {
    const pedal = play('c8\\sustainOn d e f g4\\sustainOff a');
    const first = pedal.find((n) => n.midi === 72)!;
    expect(first.duration).toBeCloseTo(1.0); // held until the pedal lifts at beat 3
    const ramp = play('c4\\p\\< d e f g1\\f');
    expect(ramp.map((n) => n.velocity)).toEqual([56, 67, 77, 88, 98]);
    const slurred = play('c4( d) e');
    expect(slurred[0]!.duration).toBeCloseTo(0.5);
    expect(slurred[1]!.duration).toBeCloseTo(0.475);
  });
});
