// Keypad actions (marks, grace notes, lines, dynamics) on the real store and core commands.
import {
  allStaves,
  createScore,
  findEvent,
  pitchName,
  randomIds,
  spannerTimes,
  toString,
  validateScore,
  voiceEvents,
} from '@cantelvio-score/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as actions from './actions';
import * as marks from './marks';
import { getStore, initStore, isDirty } from './store';

vi.mock('../playback/player', () => ({ previewMidi: async () => {}, stopPlayback: () => {} }));

const st = () => getStore().getState();
const events = () => {
  const doc = st().doc;
  const staff = allStaves(doc)[0]!.staff.id;
  return doc.measures.flatMap((m) => voiceEvents(doc, staff, m.id, 0));
};
const times = () =>
  st().doc.spanners.map((sp) => {
    const t = spannerTimes(st().doc, sp)!;
    return `${sp.kind}:${toString(t.start)}-${toString(t.end)}`;
  });

function enter(steps: readonly ('C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B')[]) {
  for (const step of steps) actions.enterLetter(step, false);
}

describe('keypad actions', () => {
  beforeEach(() => {
    initStore(createScore({ template: 'piano', measures: 2, ids: randomIds(), now: 'T' }));
  });

  it('toggles marks on the selected notes, one fermata at a time', () => {
    actions.toggleNoteInput();
    enter(['C', 'D', 'E', 'F']);
    actions.toggleNoteInput();
    const [a, b] = events();
    st().select({ kind: 'notes', noteIds: [a!.notes[0]!.id, b!.notes[0]!.id] });
    marks.toggleOrnament('trill');
    marks.toggleArticulation('fermata');
    marks.toggleArticulation('fermataLong');
    marks.toggleCue();
    expect(
      events()
        .slice(0, 2)
        .map((e) => [e.ornament, e.articulations, e.cue]),
    ).toEqual([
      ['trill', ['fermataLong'], true],
      ['trill', ['fermataLong'], true],
    ]);
    const state = marks.marksState(st().doc, st().selection, null, false);
    expect(state.ornament).toBe('trill');
    expect(state.articulations.has('fermataLong')).toBe(true);
    marks.toggleOrnament('trill');
    expect(events()[0]!.ornament).toBeUndefined();
  });

  it('adds a grace note at the pitch of the note and re-pitches it with a letter', () => {
    actions.toggleNoteInput();
    enter(['C', 'D']);
    actions.toggleNoteInput();
    const target = events()[1]!;
    st().select({ kind: 'notes', noteIds: [target.notes[0]!.id] });
    marks.addGrace('acciaccatura');
    const grace = events()[1]!.graces![0]!;
    expect(grace.slash).toBe(true);
    expect(pitchName(grace.notes[0]!.pitch)).toBe('D5');
    expect(st().selection).toEqual({ kind: 'notes', noteIds: [grace.notes[0]!.id] });
    expect(actions.repitchSelection('E')).toBe(true);
    expect(pitchName(events()[1]!.graces![0]!.notes[0]!.pitch)).toBe('E5');
    actions.deleteSelection();
    expect(events()[1]!.graces).toBeUndefined();
  });

  it('draws a slur over the selection, or to the next note from one note', () => {
    actions.toggleNoteInput();
    enter(['C', 'D', 'E', 'F']);
    actions.toggleNoteInput();
    const evs = events();
    st().select({ kind: 'notes', noteIds: [evs[1]!.notes[0]!.id] });
    marks.addLine('slur');
    expect(times()).toEqual(['slur:1/4-3/4']);
    expect(st().selection.kind).toBe('marks');
    actions.deleteSelection();
    expect(st().doc.spanners).toEqual([]);
  });

  it('grows a line started during note input until it is ended', () => {
    actions.toggleNoteInput();
    enter(['C']);
    marks.addLine('crescendo');
    expect(times()).toEqual(['hairpin:0-1/4']);
    enter(['D', 'E']);
    expect(times()).toEqual(['hairpin:0-3/4']);
    marks.addLine('crescendo'); // the same key ends it
    enter(['F']);
    expect(times()).toEqual(['hairpin:0-3/4']);
    // a slur needs the second note before it exists
    marks.addLine('slur');
    expect(st().doc.spanners.length).toBe(1);
    enter(['G', 'A']);
    expect(times().sort()).toEqual(['hairpin:0-3/4', 'slur:3/4-3/2']);
    marks.endPendingLine();
    expect(validateScore(st().doc)).toEqual([]);
    // undo takes back the note together with the growth of the slur
    st().undo();
    expect(times().sort()).toEqual(['hairpin:0-3/4', 'slur:3/4-5/4']);
  });

  it('ends a line being drawn on undo', () => {
    actions.toggleNoteInput();
    enter(['C']);
    marks.addLine('diminuendo');
    enter(['D']);
    st().undo(); // takes back D with the growth of the hairpin
    expect(times()).toEqual(['hairpin:0-1/4']);
    expect(st().input.pendingLine).toBeNull();
    enter(['E']);
    expect(times()).toEqual(['hairpin:0-1/4']);
    st().undo();
    st().undo(); // the hairpin itself
    expect(st().doc.spanners).toEqual([]);
    enter(['F']);
    expect(st().doc.spanners).toEqual([]);
    expect(events().length).toBe(2);
  });

  it('lets the note win when a line being drawn cannot follow it', () => {
    const steps = () => events().map((e) => e.notes[0]!.pitch.step);
    actions.toggleNoteInput();
    enter(['C', 'D']);
    marks.addLine('slur');
    enter(['E']);
    expect(times()).toEqual(['slur:1/4-3/4']);
    // back over E and enter F instead: the slur follows to F
    actions.moveSelection(-1);
    enter(['F']);
    expect(st().toast).toBeNull();
    expect(steps()).toEqual(['C', 'D', 'F']);
    expect(times()).toEqual(['slur:1/4-3/4']);
    // a note before the slur's start ends it; the note is entered
    for (let i = 0; i < 3; i++) actions.moveSelection(-1);
    enter(['G']);
    expect(st().toast).toBeNull();
    expect(steps()).toEqual(['G', 'D', 'F']);
    expect(st().input.pendingLine).toBeNull();
    expect(times()).toEqual(['slur:1/4-3/4']);
  });

  it('starts a slur on its first note again when that note is re-entered', () => {
    actions.toggleNoteInput();
    enter(['C']);
    marks.addLine('slur');
    actions.moveSelection(-1);
    enter(['D', 'E']);
    expect(events().map((e) => e.notes[0]!.pitch.step)).toEqual(['D', 'E']);
    expect(times()).toEqual(['slur:0-1/2']);
  });

  it('ends a line being drawn where the next line of its kind begins', () => {
    actions.toggleNoteInput();
    enter(['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C']);
    actions.toggleNoteInput();
    const evs = events();
    st().select({ kind: 'notes', noteIds: [evs[6]!.notes[0]!.id, evs[7]!.notes[0]!.id] });
    marks.addLine('8va');
    st().select({ kind: 'notes', noteIds: [evs[0]!.notes[0]!.id] });
    actions.toggleNoteInput();
    enter(['C']);
    marks.addLine('8va');
    for (let i = 0; i < 7; i++) enter(['D']);
    expect(st().toast).toBeNull();
    expect(events().length).toBe(8);
    expect(times().sort()).toEqual(['ottava:0-3/2', 'ottava:3/2-2']);
    expect(st().input.pendingLine).toBeNull();
    expect(validateScore(st().doc)).toEqual([]);
  });

  it('ends a line being drawn when its instrument is removed', () => {
    initStore(createScore({ template: 'string-quartet', measures: 2, ids: randomIds(), now: 'T' }));
    st().select({ kind: 'range', staffFrom: 3, staffTo: 3, measureFrom: 0, measureTo: 0 });
    actions.toggleNoteInput();
    enter(['C']);
    marks.addLine('crescendo');
    st().apply({ type: 'part.remove', partId: st().doc.parts[3]!.id }, 'remove', {
      selection: { kind: 'none' },
      cursor: null,
    });
    expect(() => enter(['D'])).not.toThrow();
    expect(st().input.pendingLine).toBeNull();
    expect(events().length).toBe(1); // entered on the first staff
  });

  it('ends a hairpin being drawn at a dynamic', () => {
    actions.toggleNoteInput();
    enter(['C']);
    marks.addLine('crescendo');
    enter(['D', 'E']);
    expect(times()).toEqual(['hairpin:0-3/4']);
    marks.addDynamic('f'); // on E, the note just entered
    expect(times()).toEqual(['hairpin:0-1/2']);
    enter(['F']);
    expect(times()).toEqual(['hairpin:0-1/2']);
    expect(st().input.pendingLine).toBeNull();
  });

  it('starts note input at a picked line', () => {
    actions.toggleNoteInput();
    enter(['C', 'D', 'E', 'F']);
    actions.toggleNoteInput();
    st().select({ kind: 'notes', noteIds: [events()[2]!.notes[0]!.id] });
    marks.addLine('crescendo');
    expect(st().selection.kind).toBe('marks');
    actions.toggleNoteInput();
    expect(toString(st().cursor!.offset)).toBe('1/2');
  });

  it('sets the value of selected grace notes, not of their note', () => {
    actions.toggleNoteInput();
    enter(['C', 'D', 'E', 'F']);
    actions.toggleNoteInput();
    st().select({ kind: 'notes', noteIds: [events()[1]!.notes[0]!.id] });
    marks.addGrace('acciaccatura');
    expect(marks.marksState(st().doc, st().selection, null, false).written).toEqual({
      value: 'eighth',
      dots: 0,
    });
    st().setInput({ value: 'half', dots: 0 });
    actions.setSelectedDuration();
    expect(events().map((e) => toString(e.duration))).toEqual(['1/4', '1/4', '1/4', '1/4']);
    expect(events()[1]!.graces![0]!.value).toBe('half');
    expect(marks.marksState(st().doc, st().selection, null, false).written?.value).toBe('half');
  });

  it('adds a grace note after each selected grace note, in order', () => {
    actions.toggleNoteInput();
    enter(['C']);
    actions.toggleNoteInput();
    st().select({ kind: 'notes', noteIds: [events()[0]!.notes[0]!.id] });
    const selected = () => (st().selection as { noteIds: readonly string[] }).noteIds[0]!;
    marks.addGrace('grace16');
    const g1 = selected();
    marks.addGrace('grace32');
    const g2 = selected();
    st().select({ kind: 'notes', noteIds: [g1, g2] });
    marks.addGrace('graceQuarter');
    expect(events()[0]!.graces!.map((g) => g.value)).toEqual([
      '16th',
      'quarter',
      '32nd',
      'quarter',
    ]);
  });

  it('replaces the overlapping part of an octave line', () => {
    actions.toggleNoteInput();
    enter(['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C']);
    actions.toggleNoteInput();
    st().select({ kind: 'range', staffFrom: 0, staffTo: 0, measureFrom: 0, measureTo: 1 });
    marks.addLine('8va');
    const [, second] = events();
    st().select({ kind: 'notes', noteIds: [second!.notes[0]!.id] });
    marks.addLine('15ma');
    expect(times().sort()).toEqual(['ottava:0-1/4', 'ottava:1/2-2', 'ottava:1/4-1/2']);
    expect(validateScore(st().doc)).toEqual([]);
  });

  it('puts pedal marks under the lowest staff of the instrument and adds dynamics', () => {
    actions.toggleNoteInput();
    enter(['C', 'D']);
    actions.toggleNoteInput();
    const first = events()[0]!;
    st().select({ kind: 'notes', noteIds: [first.notes[0]!.id] });
    marks.addLine('pedal');
    const lower = allStaves(st().doc)[1]!.staff.id;
    expect(st().doc.spanners[0]!.staffId).toBe(lower);
    st().select({ kind: 'notes', noteIds: [first.notes[0]!.id] });
    marks.addDynamic('mf');
    const staff = allStaves(st().doc)[0]!.staff.id;
    expect(st().doc.content[staff]![st().doc.measures[0]!.id]!.dynamics![0]!.value).toBe('mf');
    expect(isDirty(st())).toBe(true);
    st().markSaved('x.cantelvio.json');
    expect(isDirty(st())).toBe(false);
    st().undo();
    expect(isDirty(st())).toBe(true);
    expect(findEvent(st().doc, first.id)).not.toBeNull();
  });
});
