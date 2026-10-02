// Note-input actions on the real store and core commands (audio preview mocked out).
import { createScore, findEvent, pitchName, randomIds } from '@ailegro-score/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as actions from './actions';
import { getStore, initStore } from './store';

vi.mock('../playback/player', () => ({ previewMidi: async () => {}, stopPlayback: () => {} }));

const st = () => getStore().getState();

describe('note input actions', () => {
  beforeEach(() => {
    initStore(createScore({ template: 'piano', measures: 1, ids: randomIds(), now: 'T' }));
  });

  it('enters letters with the key signature and nearest octave, then undoes them', () => {
    actions.toggleNoteInput();
    for (const step of ['C', 'D', 'E'] as const) actions.enterLetter(step, false);
    actions.enterLetter('G', true); // Shift+G: add G above E
    const last = findEvent(st().doc, st().lastEntered!)!;
    expect(last.event.notes.map((n) => pitchName(n.pitch))).toEqual(['E5', 'G5']);
    expect(st().cursor?.offset).toEqual({ n: 3, d: 4 });
    for (let i = 0; i < 4; i++) st().undo();
    expect(
      Object.keys(st().doc.content).every((k) => !Object.keys(st().doc.content[k]!).length),
    ).toBe(true);
  });

  it('appends the next bar in the same undo step when a note fills the last bar', () => {
    actions.toggleNoteInput();
    st().setInput({ value: 'whole', dots: 0 });
    actions.enterLetter('C', false);
    expect(st().doc.measures.length).toBe(2);
    expect(st().cursor?.measureId).toBe(st().doc.measures[1]!.id);
    st().undo(); // one step removes both the note and the appended bar
    expect(st().doc.measures.length).toBe(1);
    expect(st().session.canUndo).toBe(false);
  });

  it('keeps the input cursor in the score when its bar is deleted', () => {
    actions.appendMeasures(2);
    actions.toggleNoteInput();
    st().setInput({ value: 'whole', dots: 0 });
    actions.enterLetter('C', false);
    actions.enterLetter('D', false); // the cursor is now in bar 3
    expect(st().cursor?.measureId).toBe(st().doc.measures[2]!.id);
    st().select({ kind: 'range', staffFrom: 0, staffTo: 1, measureFrom: 1, measureTo: 2 });
    actions.deleteSelectedMeasures();
    expect(st().doc.measures.length).toBe(1);
    expect(st().cursor?.measureId).toBe(st().doc.measures[0]!.id);
    expect(() => actions.enterLetter('E', false)).not.toThrow();
    expect(st().toast).toBeNull();
  });
});
