import { describe, expect, it } from 'vitest';
import { createScore } from '../model/create';
import { sequentialIds } from '../model/ids';
import {
  allStaves,
  findEvent,
  measureInfos,
  pitchBefore,
  scoreLength,
  voiceEvents,
} from '../model/query';
import type { ScoreDoc, ScorePosition } from '../model/types';
import { validateScore } from '../model/validate';
import { parsePitch, pitchName } from '../pitch/pitch';
import { parseRational as r, toString } from '../time/rational';
import { textToCommands } from '../io/text';
import { applyCommand } from './apply';
import { inputDurationAt, tupletContaining } from './content';
import { Session } from './history';
import { CommandError } from './types';

function setup(measures = 4, template = 'piano') {
  const ids = sequentialIds();
  const doc = createScore({ template, measures, ids, now: 'T' });
  const staff = allStaves(doc)[0]!.staff.id;
  const at = (measure: number, offset: string, voice = 0): ScorePosition => ({
    staffId: staff,
    voice,
    measureId: doc.measures[measure]!.id,
    offset: r(offset),
  });
  return { ids, doc, staff, at };
}

const shared = sequentialIds(100);

function write(doc: ScoreDoc, at: ScorePosition, text: string, ids = shared): ScoreDoc {
  const res = textToCommands(doc, at, text, { ids });
  return applyCommand(doc, { type: 'batch', commands: res.commands }).doc;
}

/** Compact view of one voice: "C4/1/4 D4/1/4 ..." per measure. */
function view(doc: ScoreDoc, staffId: string, voice = 0): string {
  return measureInfos(doc)
    .map((m) =>
      voiceEvents(doc, staffId, m.measure.id, voice)
        .map(
          (e) =>
            `${toString(e.offset)}:${e.notes.map((n) => pitchName(n.pitch) + (n.tieForward ? '~' : '')).join('+')}/${toString(e.duration)}`,
        )
        .join(' '),
    )
    .join(' | ');
}

describe('note.enter', () => {
  it('writes a note and keeps the document valid', () => {
    const { doc, at, staff } = setup();
    const next = applyCommand(doc, {
      type: 'note.enter',
      at: at(0, '0'),
      duration: r('1/4'),
      pitches: [parsePitch('C5')],
      eventId: 'e_x',
      noteIds: ['n_x'],
    }).doc;
    expect(view(next, staff)).toBe('0:C5/1/4 |  |  | ');
    expect(validateScore(next)).toEqual([]);
    expect(doc.content[staff]).toEqual({}); // the original is untouched
  });

  it('overwrites: shortens earlier notes and removes covered ones', () => {
    const { doc, at, staff } = setup();
    let d = write(doc, at(0, '0'), 'c2 d4 e');
    d = applyCommand(d, {
      type: 'note.enter',
      at: at(0, '1/4'),
      duration: r('1/4'),
      pitches: [parsePitch('G4')],
      eventId: 'e_g',
      noteIds: ['n_g'],
    }).doc;
    // the half note C is cut to a quarter; D (at 1/2) survives
    expect(view(d, staff)).toBe('0:C5/1/4 1/4:G4/1/4 1/2:D5/1/4 3/4:E5/1/4 |  |  | ');
  });

  it('lets long notes cross barlines as one event', () => {
    const { doc, at, staff } = setup();
    const d = write(doc, at(0, '1/2'), 'c1');
    expect(view(d, staff)).toBe('1/2:C5/1 |  |  | ');
    // entering into the second half of that note truncates it at the new note
    const e = write(d, at(1, '1/4'), 'g4');
    expect(view(e, staff)).toBe('1/2:C5/3/4 | 1/4:G4/1/4 |  | ');
  });

  it('clips at the end of the score', () => {
    const { doc, at, staff } = setup(1);
    const d = applyCommand(doc, {
      type: 'note.enter',
      at: at(0, '3/4'),
      duration: r('1'),
      pitches: [parsePitch('C4')],
      eventId: 'e1',
      noteIds: ['n1'],
    }).doc;
    expect(view(d, staff)).toBe('3/4:C4/1/4');
    expect(toString(scoreLength(d))).toBe('1');
  });

  it('ties from the previous note', () => {
    const { doc, at, staff } = setup();
    const d = write(doc, at(0, '0'), 'c4~ c8 d');
    expect(view(d, staff)).toBe('0:C5~/1/4 1/4:C5/1/8 3/8:D5/1/8 |  |  | ');
  });

  it('rejects invalid commands without changing anything', () => {
    const { doc, at } = setup();
    expect(() =>
      applyCommand(doc, {
        type: 'note.enter',
        at: at(0, '1'),
        duration: r('1/4'),
        pitches: [parsePitch('C4')],
        eventId: 'e',
        noteIds: ['n'],
      }),
    ).toThrow(CommandError);
    expect(() =>
      applyCommand(doc, {
        type: 'note.enter',
        at: at(0, '0'),
        duration: r('0'),
        pitches: [parsePitch('C4')],
        eventId: 'e',
        noteIds: ['n'],
      }),
    ).toThrow(CommandError);
  });
});

describe('editing', () => {
  it('adds to chords, changes pitch and deletes', () => {
    const { doc, at, staff } = setup();
    let d = write(doc, at(0, '0'), 'c4 d e f');
    const first = voiceEvents(d, staff, d.measures[0]!.id, 0)[0]!;
    d = applyCommand(d, {
      type: 'note.addToChord',
      eventId: first.id,
      pitch: parsePitch('E5'),
      noteId: 'n_e',
    }).doc;
    d = applyCommand(d, {
      type: 'note.setPitch',
      noteId: first.notes[0]!.id,
      pitch: parsePitch('G4'),
    }).doc;
    expect(view(d, staff).split(' | ')[0]).toBe('0:G4+E5/1/4 1/4:D5/1/4 1/2:E5/1/4 3/4:F5/1/4');
    const second = voiceEvents(d, staff, d.measures[0]!.id, 0)[1]!;
    d = applyCommand(d, { type: 'events.delete', eventIds: [second.id] }).doc;
    expect(view(d, staff).split(' | ')[0]).toBe('0:G4+E5/1/4 1/2:E5/1/4 3/4:F5/1/4');
    expect(validateScore(d)).toEqual([]);
  });

  it('changes duration with overwrite of following notes', () => {
    const { doc, at, staff } = setup();
    let d = write(doc, at(0, '0'), 'c4 d e f');
    const first = voiceEvents(d, staff, d.measures[0]!.id, 0)[0]!;
    d = applyCommand(d, { type: 'event.setDuration', eventId: first.id, duration: r('1/2') }).doc;
    expect(view(d, staff).split(' | ')[0]).toBe('0:C5/1/2 1/2:E5/1/4 3/4:F5/1/4');
  });

  it('creates tuplets and fills them', () => {
    const { doc, at, staff } = setup();
    const d = write(doc, at(0, '0'), '3{c8 d e} f4 g2', sequentialIds(100));
    expect(view(d, staff).split(' | ')[0]).toBe(
      '0:C5/1/12 1/12:D5/1/12 1/6:E5/1/12 1/4:F5/1/4 1/2:G5/1/2',
    );
    expect(d.content[staff]![d.measures[0]!.id]!.tuplets).toEqual([
      { id: 'tu_100', voice: 0, offset: r('0'), length: r('1/4'), actual: 3, normal: 2 },
    ]);
  });
});

describe('input helpers', () => {
  it('scales written durations inside tuplets and clips at the score end', () => {
    const { doc, at } = setup(1);
    const d = applyCommand(doc, {
      type: 'tuplet.create',
      at: at(0, '0'),
      length: r('1/4'),
      actual: 3,
      normal: 2,
      id: 'tu_1',
    }).doc;
    expect(tupletContaining(d, at(0, '1/12'))).toMatchObject({ actual: 3, normal: 2 });
    expect(tupletContaining(d, at(0, '1/4'))).toBeUndefined();
    expect(toString(inputDurationAt(d, at(0, '0'), r('1/8')))).toBe('1/12');
    expect(toString(inputDurationAt(d, at(0, '1/2'), r('1/4')))).toBe('1/4');
    // a whole note from beat 3 of the last bar only has half a bar left
    expect(toString(inputDurationAt(d, at(0, '1/2'), r('1')))).toBe('1/2');
  });

  it('finds the previous pitch across barlines for octave reference', () => {
    const { doc, at, staff } = setup(2);
    const d = write(doc, at(0, '0'), 'c4 <e g> r2 | r1');
    const startOf = (m: number) => measureInfos(d)[m]!.start;
    expect(pitchBefore(d, staff, 0, startOf(0))).toBeNull();
    expect(pitchName(pitchBefore(d, staff, 0, r('1/4'))!)).toBe('C5');
    expect(pitchName(pitchBefore(d, staff, 0, startOf(1))!)).toBe('E5');
    expect(pitchBefore(d, staff, 1, startOf(1))).toBeNull();
  });
});

describe('measures', () => {
  it('inserts and deletes measures, keeping signatures and the final barline', () => {
    const { doc, at, staff } = setup(2);
    let d = write(doc, at(0, '0'), 'c1 | d1');
    d = applyCommand(d, { type: 'measures.insert', index: 0, ids: ['m_new'] }).doc;
    expect(d.measures[0]!.timeSig).toEqual({ beats: 4, beatType: 4 });
    expect(d.measures[1]!.timeSig).toBeUndefined();
    expect(view(d, staff)).toBe(' | 0:C5/1 | 0:D5/1');
    d = applyCommand(d, { type: 'measures.insert', index: 3, ids: ['m_end'] }).doc;
    expect(d.measures[3]!.barline).toBe('final');
    expect(d.measures[2]!.barline).toBeUndefined();
    d = applyCommand(d, { type: 'measures.delete', measureIds: ['m_new', 'm_end'] }).doc;
    expect(d.measures[0]!.timeSig).toEqual({ beats: 4, beatType: 4 });
    expect(d.measures[1]!.barline).toBe('final');
    expect(view(d, staff)).toBe('0:C5/1 | 0:D5/1');
    expect(validateScore(d)).toEqual([]);
  });

  it('re-bars when the time signature changes', () => {
    const { doc, at, staff } = setup(2);
    let d = write(doc, at(0, '0'), 'c4 d e f | g a b c');
    d = applyCommand(d, {
      type: 'measure.setTimeSig',
      measureId: d.measures[0]!.id,
      timeSig: { beats: 3, beatType: 4 },
      newMeasureIds: ['m_a', 'm_b'],
    }).doc;
    // 8 quarters in 3/4 -> 3 bars (the last one padded with rests)
    expect(d.measures.length).toBe(3);
    expect(view(d, staff)).toBe(
      '0:C5/1/4 1/4:D5/1/4 1/2:E5/1/4 | 0:F5/1/4 1/4:G5/1/4 1/2:A5/1/4 | 0:B5/1/4 1/4:C6/1/4',
    );
    expect(d.measures[2]!.barline).toBe('final');
    expect(validateScore(d)).toEqual([]);
  });
});

describe('history', () => {
  it('undoes and redoes', () => {
    const { doc, at, staff } = setup();
    let s = Session.start(doc);
    s = s.dispatch({
      type: 'note.enter',
      at: at(0, '0'),
      duration: r('1/4'),
      pitches: [parsePitch('C4')],
      eventId: 'e1',
      noteIds: ['n1'],
    });
    s = s.dispatch({ type: 'note.setPitch', noteId: 'n1', pitch: parsePitch('D4') });
    expect(findEvent(s.doc, 'e1')!.event.notes[0]!.pitch.step).toBe('D');
    s = s.undo().session;
    expect(findEvent(s.doc, 'e1')!.event.notes[0]!.pitch.step).toBe('C');
    s = s.undo().session;
    expect(findEvent(s.doc, 'e1')).toBeNull();
    expect(s.doc).toEqual(doc);
    s = s.redo().session.redo().session;
    expect(findEvent(s.doc, 'e1')!.event.notes[0]!.pitch.step).toBe('D');
    expect(view(s.doc, staff).startsWith('0:D4/1/4')).toBe(true);
  });
});
