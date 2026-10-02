import { describe, expect, it } from 'vitest';
import { parseScore, serializeScore } from '../io/json';
import { textToCommands } from '../io/text';
import { createScore } from '../model/create';
import { sequentialIds } from '../model/ids';
import { allStaves, findEvent, findNote, voiceEvents } from '../model/query';
import { ottavaAt, spannerTimes } from '../model/spanners';
import type { NoteEvent, ScoreDoc, ScorePosition, Spanner } from '../model/types';
import { validateScore } from '../model/validate';
import { parsePitch, pitchName } from '../pitch/pitch';
import { parseRational as r, rat, toString } from '../time/rational';
import { applyCommand, applyCommands } from './apply';
import { Session } from './history';
import type { Command } from './types';

function setup(measures = 4, template = 'piano') {
  const ids = sequentialIds();
  let doc = createScore({ template, measures, ids, now: 'T' });
  const staff = allStaves(doc)[0]!.staff.id;
  const at = (measure: number, offset: string, voice = 0): ScorePosition => ({
    staffId: staff,
    voice,
    measureId: doc.measures[measure]!.id,
    offset: r(offset),
  });
  const write = (pos: ScorePosition, text: string) => {
    const res = textToCommands(doc, pos, text, { ids });
    doc = applyCommand(doc, { type: 'batch', commands: res.commands }).doc;
    return res.eventIds;
  };
  return { ids, staff, at, write, doc: () => doc, set: (d: ScoreDoc) => (doc = d) };
}

const events = (doc: ScoreDoc, staff: string, measure: number): readonly NoteEvent[] =>
  voiceEvents(doc, staff, doc.measures[measure]!.id, 0);

describe('event marks', () => {
  it('sets and clears ornaments, tremolo, arpeggio, cue size and breath marks', () => {
    const t = setup();
    const [a, b] = t.write(t.at(0, '0'), 'c4 <e g c>4');
    let doc = applyCommand(t.doc(), {
      type: 'events.setProps',
      eventIds: [a!, b!],
      props: { ornament: 'trill', tremolo: 2, arpeggio: 'up', cue: true, breath: 'breath' },
    }).doc;
    const [ea, eb] = events(doc, t.staff, 0);
    expect(ea).toMatchObject({ ornament: 'trill', tremolo: 2, cue: true, breath: 'breath' });
    expect(ea!.arpeggio).toBeUndefined(); // a single note is not rolled
    expect(eb!.arpeggio).toBe('up');
    expect(validateScore(doc)).toEqual([]);
    doc = applyCommand(doc, {
      type: 'events.setProps',
      eventIds: [a!],
      props: { ornament: null, tremolo: null, cue: false, breath: null },
    }).doc;
    const cleared = events(doc, t.staff, 0)[0]!;
    expect(Object.keys(cleared).sort()).toEqual(['duration', 'id', 'kind', 'notes', 'offset']);
  });

  it('rejects unknown marks', () => {
    const t = setup();
    const [a] = t.write(t.at(0, '0'), 'c4');
    expect(() =>
      applyCommand(t.doc(), { type: 'events.setProps', eventIds: [a!], props: { tremolo: 7 } }),
    ).toThrow(/tremolo/);
  });

  it('adds grace notes in playing order and edits them like notes', () => {
    const t = setup();
    const [a] = t.write(t.at(0, '0'), 'c4');
    const grace = (id: string, note: string, pitch: string, slash = false): Command => ({
      type: 'grace.add',
      eventId: a!,
      index: id === 'gc_a' ? 0 : 1,
      grace: {
        id,
        value: 'eighth',
        ...(slash ? { slash } : {}),
        notes: [{ id: note, pitch: parsePitch(pitch) }],
      },
    });
    let doc = applyCommands(t.doc(), [
      grace('gc_a', 'n_ga', 'D5', true),
      grace('gc_b', 'n_gb', 'E5'),
    ]);
    let e = events(doc, t.staff, 0)[0]!;
    expect(e.graces!.map((g) => [g.id, g.slash ?? false, pitchName(g.notes[0]!.pitch)])).toEqual([
      ['gc_a', true, 'D5'],
      ['gc_b', false, 'E5'],
    ]);
    expect(findNote(doc, 'n_gb')).toMatchObject({ graceIndex: 1, note: { id: 'n_gb' } });
    expect(validateScore(doc)).toEqual([]);
    // re-pitch, add a note to the grace chord, delete
    doc = applyCommands(doc, [
      { type: 'note.setPitch', noteId: 'n_ga', pitch: parsePitch('B4') },
      { type: 'note.addToChord', eventId: 'gc_a', noteId: 'n_gc', pitch: parsePitch('G4') },
    ]);
    e = events(doc, t.staff, 0)[0]!;
    expect(e.graces![0]!.notes.map((n) => pitchName(n.pitch))).toEqual(['G4', 'B4']);
    doc = applyCommand(doc, { type: 'notes.delete', noteIds: ['n_gb'] }).doc;
    expect(events(doc, t.staff, 0)[0]!.graces!.map((g) => g.id)).toEqual(['gc_a']);
    doc = applyCommand(doc, { type: 'notes.delete', noteIds: ['n_ga', 'n_gc'] }).doc;
    expect(events(doc, t.staff, 0)[0]!.graces).toBeUndefined();
    // ids must be fresh
    expect(() =>
      applyCommand(t.doc(), {
        type: 'grace.add',
        eventId: a!,
        index: 0,
        grace: { id: a!, value: 'eighth', notes: [{ id: 'x', pitch: parsePitch('D5') }] },
      }),
    ).toThrow(/already exists/);
  });

  it('sets the value of a grace note in place', () => {
    const t = setup();
    t.write(t.at(0, '0'), '\\acciaccatura d8 c4');
    const g = events(t.doc(), t.staff, 0)[0]!.graces![0]!;
    expect(g.slash).toBe(true);
    const doc = applyCommand(t.doc(), {
      type: 'grace.set',
      grace: { id: g.id, value: '16th', notes: g.notes },
    }).doc;
    expect(events(doc, t.staff, 0)[0]!.graces).toEqual([
      { id: g.id, value: '16th', notes: g.notes },
    ]);
    expect(() =>
      applyCommand(t.doc(), { type: 'grace.set', grace: { ...g, id: 'gc_none' } }),
    ).toThrow(/unknown grace/);
    expect(() => applyCommand(t.doc(), { type: 'grace.set', grace: { ...g, notes: [] } })).toThrow(
      /at least one note/,
    );
  });

  it('stacks articulations from the note outwards and checks marks of inserted events', () => {
    const t = setup();
    const [a] = t.write(t.at(0, '0'), 'c4');
    const doc = applyCommands(t.doc(), [
      { type: 'events.setArticulation', eventIds: [a!], articulation: 'accent', on: true },
      { type: 'events.setArticulation', eventIds: [a!], articulation: 'staccato', on: true },
    ]);
    expect(events(doc, t.staff, 0)[0]!.articulations).toEqual(['staccato', 'accent']);
    const insert = (extra: Partial<NoteEvent>): Command => ({
      type: 'events.insert',
      staffId: t.staff,
      measureId: t.doc().measures[1]!.id,
      voice: 0,
      events: [
        {
          id: 'e_new',
          kind: 'note',
          offset: rat(0),
          duration: r('1/4'),
          notes: [{ id: 'n_new', pitch: parsePitch('C5') }],
          ...extra,
        } as NoteEvent,
      ],
    });
    expect(() => applyCommand(t.doc(), insert({ tremolo: 9 }))).toThrow(/tremolo/);
    expect(() =>
      applyCommand(t.doc(), insert({ graces: [{ id: 'gc_x', value: 'eighth', notes: [] }] })),
    ).toThrow(/no notes/);
    expect(validateScore(applyCommand(t.doc(), insert({ ornament: 'turn' })).doc)).toEqual([]);
  });

  it('keeps grace notes and marks in the file', () => {
    const t = setup();
    const [a] = t.write(t.at(0, '0'), 'c4 d e f');
    const doc = applyCommands(t.doc(), [
      { type: 'events.setProps', eventIds: [a!], props: { ornament: 'mordent' } },
      {
        type: 'grace.add',
        eventId: a!,
        index: 0,
        grace: {
          id: 'gc_1',
          slash: true,
          value: '16th',
          notes: [{ id: 'n_g1', pitch: parsePitch('D5') }],
        },
      },
    ]);
    const text = serializeScore(doc);
    expect(text).toContain(
      '"graces":[{"id":"gc_1","slash":true,"value":"16th","notes":[{"id":"n_g1","pitch":"D5"}]}]',
    );
    expect(parseScore(text)).toEqual(doc);
  });
});

describe('spanners', () => {
  function withNotes() {
    const t = setup();
    const ids = t.write(t.at(0, '0'), 'c4 d e f | g a b c');
    return { ...t, ev: ids };
  }
  const hairpin = (
    staff: string,
    doc: ScoreDoc,
    id: string,
    from: [number, string],
    to: [number, string],
  ): Spanner => ({
    id,
    kind: 'hairpin',
    staffId: staff,
    direction: 'crescendo',
    start: { measureId: doc.measures[from[0]]!.id, offset: r(from[1]) },
    end: { measureId: doc.measures[to[0]]!.id, offset: r(to[1]) },
  });

  it('adds slurs between later events of one voice', () => {
    const t = withNotes();
    const slur: Spanner = {
      id: 'sp_1',
      kind: 'slur',
      staffId: t.staff,
      from: t.ev[0]!,
      to: t.ev[3]!,
    };
    const doc = applyCommand(t.doc(), { type: 'spanner.add', spanner: slur }).doc;
    expect(doc.spanners).toEqual([slur]);
    expect(validateScore(doc)).toEqual([]);
    expect(() =>
      applyCommand(t.doc(), {
        type: 'spanner.add',
        spanner: { ...slur, from: t.ev[3]!, to: t.ev[0]! },
      }),
    ).toThrow(/later event/);
  });

  it('stores line ends inside the bar they close and orders lines by time', () => {
    const t = withNotes();
    const doc0 = t.doc();
    const doc = applyCommands(doc0, [
      { type: 'spanner.add', spanner: hairpin(t.staff, doc0, 'sp_2', [1, '0'], [2, '0']) },
      { type: 'spanner.add', spanner: hairpin(t.staff, doc0, 'sp_1', [0, '1/4'], [0, '3/4']) },
    ]);
    expect(doc.spanners.map((s) => s.id)).toEqual(['sp_1', 'sp_2']);
    const second = doc.spanners[1]!;
    expect(second.kind === 'hairpin' && second.end).toEqual({
      measureId: doc.measures[1]!.id,
      offset: rat(1),
    });
  });

  it('refuses overlapping octave lines and shifts nothing but the display', () => {
    const t = withNotes();
    const doc0 = t.doc();
    const ottava = (id: string, from: string, to: string): Spanner => ({
      id,
      kind: 'ottava',
      staffId: t.staff,
      octaves: 1,
      start: { measureId: doc0.measures[0]!.id, offset: r(from) },
      end: { measureId: doc0.measures[0]!.id, offset: r(to) },
    });
    const doc = applyCommand(doc0, {
      type: 'spanner.add',
      spanner: ottava('sp_1', '0', '1/2'),
    }).doc;
    expect(ottavaAt(doc, t.staff, r('1/4'))).toBe(1);
    expect(ottavaAt(doc, t.staff, r('1/2'))).toBe(0);
    expect(() =>
      applyCommand(doc, { type: 'spanner.add', spanner: ottava('sp_2', '1/4', '3/4') }),
    ).toThrow(/octave line/);
    // pitches are unchanged
    expect(events(doc, t.staff, 0).map((e) => pitchName(e.notes[0]!.pitch))).toEqual(
      events(doc0, t.staff, 0).map((e) => pitchName(e.notes[0]!.pitch)),
    );
  });

  it('drops a slur together with its notes, in the same undo step', () => {
    const t = withNotes();
    const slur: Spanner = {
      id: 'sp_1',
      kind: 'slur',
      staffId: t.staff,
      from: t.ev[0]!,
      to: t.ev[2]!,
    };
    let s = Session.start(applyCommand(t.doc(), { type: 'spanner.add', spanner: slur }).doc);
    const loc = findEvent(s.doc, t.ev[2]!)!;
    s = s.dispatch({ type: 'notes.delete', noteIds: loc.event.notes.map((n) => n.id) });
    expect(s.doc.spanners).toEqual([]);
    expect(validateScore(s.doc)).toEqual([]);
    s = s.undo().session;
    expect(s.doc.spanners).toEqual([slur]);
  });

  it('shrinks lines when bars are deleted and re-anchors them when bars are re-barred', () => {
    const t = withNotes();
    const doc0 = t.doc();
    let doc = applyCommand(doc0, {
      type: 'spanner.add',
      spanner: hairpin(t.staff, doc0, 'sp_1', [0, '1/2'], [2, '1/2']),
    }).doc;
    const times = (d: ScoreDoc) => {
      const x = spannerTimes(d, d.spanners[0]!)!;
      return `${toString(x.start)}-${toString(x.end)}`;
    };
    expect(times(doc)).toBe('1/2-5/2');
    const deleted = applyCommand(doc, {
      type: 'measures.delete',
      measureIds: [doc.measures[1]!.id],
    }).doc;
    expect(times(deleted)).toBe('1/2-3/2');
    expect(validateScore(deleted)).toEqual([]);
    const gone = applyCommand(doc, {
      type: 'measures.delete',
      measureIds: [doc.measures[0]!.id, doc.measures[1]!.id, doc.measures[2]!.id],
    }).doc;
    expect(gone.spanners).toEqual([]);
    doc = applyCommand(doc, {
      type: 'measure.setTimeSig',
      measureId: doc.measures[0]!.id,
      timeSig: { beats: 3, beatType: 4 },
      newMeasureIds: ['m_x1', 'm_x2'],
    }).doc;
    expect(times(doc)).toBe('1/2-5/2');
    expect(validateScore(doc)).toEqual([]);
  });

  it('removes lines inside a cleared range and with a removed instrument', () => {
    const t = setup(4, 'string-quartet');
    const doc0 = t.doc();
    const staves = allStaves(doc0).map((s) => s.staff.id);
    let doc = applyCommands(doc0, [
      { type: 'spanner.add', spanner: hairpin(staves[0]!, doc0, 'sp_1', [0, '0'], [0, '1']) },
      { type: 'spanner.add', spanner: hairpin(staves[1]!, doc0, 'sp_2', [0, '0'], [1, '1/2']) },
    ]);
    doc = applyCommand(doc, {
      type: 'range.clear',
      staffIds: staves,
      from: { measureId: doc.measures[0]!.id, offset: rat(0) },
      to: { measureId: doc.measures[0]!.id, offset: rat(1) },
    }).doc;
    expect(doc.spanners.map((s) => s.id)).toEqual(['sp_2']);
    doc = applyCommand(doc, { type: 'part.remove', partId: doc.parts[1]!.id }).doc;
    expect(doc.spanners).toEqual([]);
  });

  it('checks new ids against every element and refuses unknown kinds', () => {
    const t = withNotes();
    const slur: Spanner = {
      id: t.ev[0]!,
      kind: 'slur',
      staffId: t.staff,
      from: t.ev[0]!,
      to: t.ev[1]!,
    };
    expect(() => applyCommand(t.doc(), { type: 'spanner.add', spanner: slur })).toThrow(
      /already exists/,
    );
    const bar = t.doc().measures[0]!.id;
    expect(() =>
      applyCommand(t.doc(), { type: 'spanner.add', spanner: { ...slur, id: bar } }),
    ).toThrow(/already exists/);
    const doc = applyCommand(t.doc(), {
      type: 'spanner.add',
      spanner: { ...slur, id: 'sp_1' },
    }).doc;
    expect(() =>
      applyCommand(doc, {
        type: 'note.enter',
        at: t.at(1, '0'),
        duration: r('1/4'),
        pitches: [parsePitch('C5')],
        eventId: 'sp_1',
        noteIds: ['n_fresh'],
      }),
    ).toThrow(/already exists/);
    expect(() =>
      applyCommand(t.doc(), {
        type: 'spanner.add',
        spanner: { ...slur, id: 'sp_2', kind: 'glissando' } as unknown as Spanner,
      }),
    ).toThrow(/kind/);
  });

  it('reads version 1 files', () => {
    const t = withNotes();
    const v1 = serializeScore(t.doc())
      .replace('"version": 2', '"version": 1')
      .replace(/,\n {2}"spanners": \[\]/, '');
    expect(v1).not.toContain('spanners');
    const back = parseScore(v1);
    expect(back.version).toBe(2);
    expect(back.spanners).toEqual([]);
    expect(validateScore(back)).toEqual([]);
  });
});
