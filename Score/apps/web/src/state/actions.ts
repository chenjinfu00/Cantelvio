/**
 * Editing actions (MuseScore/Sibelius-style input) built on core commands.
 * Each action reads the current state, builds commands with fresh ids and applies them as one
 * undoable step.
 */
import {
  type Articulation,
  type Command,
  type NoteEvent,
  type Pitch,
  type Rational,
  type ScoreDoc,
  type ScorePosition,
  type Step,
  add,
  allStaves,
  clefAt,
  cmp,
  findEvent,
  findEventOfNote,
  findInstrument,
  inputDurationAt,
  interval,
  invertInterval,
  isUnison,
  keyAt,
  locate,
  lengthOf,
  measureInfo,
  measureInfos,
  middleLinePitch,
  midiOf,
  moveBySemitone,
  nearestPitchForStep,
  pitchAtPosition,
  pitchBefore,
  rat,
  scoreLength,
  staffInfo,
  sub,
  transpose,
  transposeKey,
  keyAlter,
  tupletContaining,
  voiceEvents,
} from '@ailegro-score/core';
import { type Selection, getStore } from './store';
import { previewMidi } from '../playback/player';

const st = () => getStore().getState();

// ------------------------------------------------------------------------------- positions

export function absTime(doc: ScoreDoc, at: ScorePosition): Rational {
  return add(measureInfo(doc, at.measureId).start, at.offset);
}

export function positionAt(
  doc: ScoreDoc,
  staffId: string,
  voice: number,
  t: Rational,
): ScorePosition | null {
  const loc = locate(doc, t);
  if (!loc) return null;
  return { staffId, voice, measureId: doc.measures[loc.measureIndex]!.id, offset: loc.offset };
}

/** Where note input starts: the selection, or the first bar of the first staff. */
export function cursorFromSelection(
  doc: ScoreDoc,
  selection: Selection,
  voice: number,
): ScorePosition {
  if (selection.kind === 'notes' && selection.noteIds.length) {
    const loc = findEventOfNote(doc, selection.noteIds[0]!);
    if (loc)
      return {
        staffId: loc.staffId,
        voice: loc.voice,
        measureId: loc.measureId,
        offset: loc.event.offset,
      };
  }
  if (selection.kind === 'rest') return selection.at;
  const staves = allStaves(doc);
  if (selection.kind === 'range') {
    return {
      staffId: staves[selection.staffFrom]!.staff.id,
      voice,
      measureId: doc.measures[selection.measureFrom]!.id,
      offset: rat(0),
    };
  }
  return { staffId: staves[0]!.staff.id, voice, measureId: doc.measures[0]!.id, offset: rat(0) };
}

// ------------------------------------------------------------------------------- written pitch

function transpositionOf(doc: ScoreDoc, staffId: string) {
  const part = staffInfo(doc, staffId).part;
  const t = part.transposition ?? findInstrument(part.instrument)?.transposition;
  return t && !isUnison(t) ? t : null;
}

/** Pitch for a letter typed at `at`: nearest octave, key signature applied (written key when transposed). */
export function pitchForLetter(
  doc: ScoreDoc,
  at: ScorePosition,
  step: Step,
  concertView: boolean,
): Pitch {
  const info = measureInfo(doc, at.measureId);
  const t = absTime(doc, at);
  const concertKey = keyAt(doc, info.index);
  const transposition = concertView ? null : transpositionOf(doc, at.staffId);
  const prev = pitchBefore(doc, at.staffId, at.voice, t) ?? pitchBefore(doc, at.staffId, 0, t);
  if (transposition) {
    const toWritten = invertInterval(transposition);
    const key = transposeKey(concertKey, toWritten);
    const ref = prev
      ? transpose(prev, toWritten)
      : middleLinePitch(clefAt(doc, at.staffId, info.index, at.offset));
    const written = nearestPitchForStep(step, ref, key);
    return transpose(written, transposition);
  }
  const ref = prev ?? middleLinePitch(clefAt(doc, at.staffId, info.index, at.offset));
  return nearestPitchForStep(step, ref, concertKey);
}

/** Pitch at a staff position (mouse input), with the key signature applied. */
export function pitchForPosition(
  doc: ScoreDoc,
  at: ScorePosition,
  position: number,
  concertView: boolean,
): Pitch {
  const info = measureInfo(doc, at.measureId);
  const clef = clefAt(doc, at.staffId, info.index, at.offset);
  const concertKey = keyAt(doc, info.index);
  const transposition = concertView ? null : transpositionOf(doc, at.staffId);
  const natural = pitchAtPosition(position, clef);
  if (transposition) {
    const key = transposeKey(concertKey, invertInterval(transposition));
    return transpose({ ...natural, alter: keyAlter(key.fifths, natural.step) }, transposition);
  }
  return { ...natural, alter: keyAlter(concertKey.fifths, natural.step) };
}

// ------------------------------------------------------------------------------- note input

function writtenLength(): Rational {
  const { value, dots } = st().input;
  return lengthOf(value, dots);
}

/** Commands appending measures so that a note ending at `end` fits in the score. */
function growFor(doc: ScoreDoc, end: Rational): Command[] {
  const total = scoreLength(doc);
  if (cmp(end, total) <= 0) return [];
  const infos = measureInfos(doc);
  const lastLength = infos[infos.length - 1]!.length;
  const missing = sub(end, total);
  const count = Math.min(64, Math.ceil((missing.n * lastLength.d) / (missing.d * lastLength.n)));
  const ids = Array.from({ length: count }, () => st().ids.next('m'));
  return [{ type: 'measures.insert', index: doc.measures.length, ids }];
}

/** Actual length of the current input duration at a position (scaled inside tuplets). */
function actualLength(doc: ScoreDoc, at: ScorePosition): Rational {
  const written = writtenLength();
  const tuplet = tupletContaining(doc, at);
  return tuplet ? rat(written.n * tuplet.normal, written.d * tuplet.actual) : written;
}

/** After an entry ending at `end`: next cursor, appending a bar when input reached the end. */
function advanceCursor(at: ScorePosition, end: Rational): void {
  const doc = st().doc;
  const next = positionAt(doc, at.staffId, at.voice, end);
  if (next) {
    getStore().setState({ cursor: next });
    return;
  }
  const grow = growFor(doc, add(end, rat(1, 1024)));
  if (grow.length && st().apply(grow, 'add measure')) {
    getStore().setState({ cursor: positionAt(st().doc, at.staffId, at.voice, end) ?? at });
  }
}

export function toggleNoteInput(): void {
  const s = st();
  if (s.input.active) {
    s.setInput({ active: false });
    s.setCursor(null);
    return;
  }
  const cursor = cursorFromSelection(s.doc, s.selection, s.input.voice);
  s.setInput({ active: true, voice: cursor.voice });
  s.setCursor(cursor);
}

function ensureCursor(): ScorePosition {
  const s = st();
  if (s.cursor) return s.cursor;
  const cursor = cursorFromSelection(s.doc, s.selection, s.input.voice);
  s.setInput({ active: true });
  s.setCursor(cursor);
  return cursor;
}

/** Enter a note (letter) or add it to the last chord (Shift+letter). */
export function enterLetter(step: Step, addToChord: boolean): void {
  const s = st();
  if (addToChord && s.lastEntered) {
    const loc = findEvent(s.doc, s.lastEntered);
    if (loc) {
      const top = loc.event.notes[loc.event.notes.length - 1]!.pitch;
      // MuseScore: Shift+letter adds the letter above the top note of the chord
      let p = nearestPitchForStep(step, top, keyAt(s.doc, loc.measureIndex));
      while (midiOf(p) <= midiOf(top)) p = { ...p, octave: p.octave + 1 };
      const noteId = s.ids.next('n');
      s.apply(
        { type: 'note.addToChord', eventId: loc.event.id, pitch: p, noteId },
        'add to chord',
        { selection: { kind: 'notes', noteIds: [noteId] } },
      );
      return;
    }
  }
  const at = ensureCursor();
  const doc = st().doc;
  const pitch = pitchForLetter(doc, at, step, st().view.concertPitch);
  if (enterPitches(at, [pitch])) void previewMidi([midiOf(pitch)], programOf(doc, at.staffId));
}

/** General MIDI program used to preview notes of a staff. */
export function programOf(doc: ScoreDoc, staffId: string): number {
  const part = staffInfo(doc, staffId).part;
  return part.midiProgram ?? findInstrument(part.instrument)?.gmProgram ?? 0;
}

export function enterPitches(
  at: ScorePosition,
  pitches: Pitch[],
  tieFromPrevious = false,
): string | null {
  const s = st();
  const doc = s.doc;
  const duration = actualLength(doc, at);
  const start = absTime(doc, at);
  const grow = tupletContaining(doc, at) ? [] : growFor(doc, add(start, duration));
  const eventId = s.ids.next('e');
  const noteIds = pitches.map(() => s.ids.next('n'));
  const cmds: Command[] = [
    ...grow,
    {
      type: 'note.enter',
      at,
      duration,
      pitches,
      eventId,
      noteIds,
      ...(tieFromPrevious ? { tieFromPrevious: true } : {}),
    },
  ];
  if (!s.apply(cmds, 'enter note')) return null;
  const loc = findEvent(st().doc, eventId);
  getStore().setState({ selection: { kind: 'notes', noteIds }, lastEntered: eventId });
  advanceCursor(at, loc?.end ?? add(start, duration));
  return eventId;
}

export function enterRest(): void {
  const at = ensureCursor();
  const s = st();
  const doc = s.doc;
  const duration = actualLength(doc, at);
  const start = absTime(doc, at);
  const grow = tupletContaining(doc, at) ? [] : growFor(doc, add(start, duration));
  if (!s.apply([...grow, { type: 'rest.enter', at, duration }], 'enter rest')) return;
  getStore().setState({ lastEntered: null, selection: { kind: 'rest', at } });
  const clipped = inputDurationAt(st().doc, at, duration);
  advanceCursor(at, add(start, clipped));
}

/** Tie: in input mode enter the same pitches tied; otherwise toggle ties on the selection. */
export function tie(): void {
  const s = st();
  if (s.input.active && s.cursor && s.lastEntered) {
    const loc = findEvent(s.doc, s.lastEntered);
    if (loc) {
      enterPitches(
        s.cursor,
        loc.event.notes.map((n) => n.pitch),
        true,
      );
      return;
    }
  }
  const noteIds = selectedNoteIds();
  if (!noteIds.length) return;
  const doc = s.doc;
  const anyUntied = noteIds.some(
    (id) => !findEventOfNote(doc, id)?.event.notes.find((n) => n.id === id)?.tieForward,
  );
  s.apply({ type: 'notes.setTie', noteIds, tie: anyUntied }, 'tie');
}

export function createTriplet(): void {
  const at = ensureCursor();
  const s = st();
  const written = writtenLength();
  // A triplet of the current value spans two of them: three eighths in the time of two.
  s.apply(
    {
      type: 'tuplet.create',
      at,
      length: rat(written.n * 2, written.d),
      actual: 3,
      normal: 2,
      id: s.ids.next('tu'),
    },
    'triplet',
    { cursor: at },
  );
}

// ------------------------------------------------------------------------------- selection editing

export function selectedNoteIds(): string[] {
  const s = st();
  if (s.selection.kind === 'notes') return [...s.selection.noteIds];
  if (s.input.active && s.lastEntered) {
    const loc = findEvent(s.doc, s.lastEntered);
    if (loc) return loc.event.notes.map((n) => n.id);
  }
  return [];
}

export function transposeSelection(semitones: number): void {
  const s = st();
  const ids = selectedNoteIds();
  if (!ids.length) return;
  const cmds: Command[] = [];
  for (const id of ids) {
    const loc = findEventOfNote(s.doc, id);
    const note = loc?.event.notes.find((n) => n.id === id);
    if (!loc || !note) continue;
    let p = note.pitch;
    if (Math.abs(semitones) === 12) p = transpose(p, interval(semitones > 0 ? 7 : -7, semitones));
    else p = moveBySemitone(p, semitones > 0 ? 1 : -1, keyAt(s.doc, loc.measureIndex));
    cmds.push({ type: 'note.setPitch', noteId: id, pitch: p });
  }
  s.apply(cmds, 'transpose', { selection: { kind: 'notes', noteIds: ids } });
}

export function setAccidental(alter: number): void {
  const s = st();
  const ids = selectedNoteIds();
  const cmds: Command[] = [];
  for (const id of ids) {
    const note = findEventOfNote(s.doc, id)?.event.notes.find((n) => n.id === id);
    if (!note) continue;
    const target = note.pitch.alter === alter ? 0 : alter;
    cmds.push({ type: 'note.setPitch', noteId: id, pitch: { ...note.pitch, alter: target } });
  }
  if (cmds.length) s.apply(cmds, 'accidental', { selection: { kind: 'notes', noteIds: ids } });
}

export function toggleArticulation(articulation: Articulation): void {
  const s = st();
  const eventIds = [
    ...new Set(
      selectedNoteIds()
        .map((id) => findEventOfNote(s.doc, id)?.event.id)
        .filter((x): x is string => !!x),
    ),
  ];
  if (!eventIds.length) return;
  const on = eventIds.some(
    (id) => !findEvent(s.doc, id)?.event.articulations?.includes(articulation),
  );
  s.apply({ type: 'events.setArticulation', eventIds, articulation, on }, 'articulation');
}

export function setSelectedDuration(): void {
  // Selecting a duration with notes selected (not in input mode) changes their duration.
  const s = st();
  if (s.input.active || s.selection.kind !== 'notes') return;
  const eventIds = [
    ...new Set(
      s.selection.noteIds
        .map((id) => findEventOfNote(s.doc, id)?.event.id)
        .filter((x): x is string => !!x),
    ),
  ];
  const cmds: Command[] = eventIds.map((eventId) => ({
    type: 'event.setDuration',
    eventId,
    duration: writtenLength(),
  }));
  if (cmds.length) s.apply(cmds, 'duration');
}

export function deleteSelection(): void {
  const s = st();
  const sel = s.selection;
  if (sel.kind === 'notes') {
    s.apply({ type: 'notes.delete', noteIds: sel.noteIds }, 'delete', {
      selection: { kind: 'none' },
    });
  } else if (sel.kind === 'range') {
    const staves = allStaves(s.doc)
      .slice(sel.staffFrom, sel.staffTo + 1)
      .map((x) => x.staff.id);
    const last = measureInfos(s.doc)[sel.measureTo]!;
    s.apply(
      {
        type: 'range.clear',
        staffIds: staves,
        from: { measureId: s.doc.measures[sel.measureFrom]!.id, offset: rat(0) },
        to: { measureId: last.measure.id, offset: last.length },
      },
      'clear range',
    );
  }
}

export function moveSelection(direction: 1 | -1): void {
  const s = st();
  const doc = s.doc;
  if (s.input.active && s.cursor) {
    const at = s.cursor;
    const t = absTime(doc, at);
    const stops = new Set<string>();
    const times: Rational[] = [];
    const push = (x: Rational) => {
      const k = `${x.n}/${x.d}`;
      if (!stops.has(k)) {
        stops.add(k);
        times.push(x);
      }
    };
    for (const m of measureInfos(doc)) {
      push(m.start);
      for (const e of voiceEvents(doc, at.staffId, m.measure.id, at.voice)) {
        push(add(m.start, e.offset));
        push(add(add(m.start, e.offset), e.duration));
      }
    }
    times.sort(cmp);
    const target =
      direction > 0
        ? times.find((x) => cmp(x, t) > 0)
        : [...times].reverse().find((x) => cmp(x, t) < 0);
    if (target) {
      const p = positionAt(doc, at.staffId, at.voice, target);
      if (p) getStore().setState({ cursor: p, lastEntered: null });
    }
    return;
  }
  if (s.selection.kind !== 'notes' || !s.selection.noteIds.length) return;
  const loc = findEventOfNote(doc, s.selection.noteIds[0]!);
  if (!loc) return;
  const list: NoteEvent[] = [];
  for (const m of measureInfos(doc))
    list.push(...voiceEvents(doc, loc.staffId, m.measure.id, loc.voice));
  const i = list.findIndex((e) => e.id === loc.event.id);
  const next = list[i + direction];
  if (next) s.select({ kind: 'notes', noteIds: next.notes.map((n) => n.id) });
}

// ------------------------------------------------------------------------------- measures

export function appendMeasures(count = 1): void {
  const s = st();
  const ids = Array.from({ length: count }, () => s.ids.next('m'));
  s.apply({ type: 'measures.insert', index: s.doc.measures.length, ids }, 'append measures');
}

export function insertMeasureBeforeSelection(): void {
  const s = st();
  const sel = s.selection;
  let index = s.doc.measures.length;
  if (sel.kind === 'range') index = sel.measureFrom;
  else if (sel.kind === 'notes' && sel.noteIds.length)
    index = findEventOfNote(s.doc, sel.noteIds[0]!)?.measureIndex ?? index;
  s.apply({ type: 'measures.insert', index, ids: [s.ids.next('m')] }, 'insert measure');
}

export function deleteSelectedMeasures(): void {
  const s = st();
  const sel = s.selection;
  if (sel.kind !== 'range') return;
  const ids = s.doc.measures.slice(sel.measureFrom, sel.measureTo + 1).map((m) => m.id);
  s.apply({ type: 'measures.delete', measureIds: ids }, 'delete measures', {
    selection: { kind: 'none' },
  });
}

// ------------------------------------------------------------------------------- mouse

export function selectMeasure(staffIndex: number, measureIndex: number, extend: boolean): void {
  const s = st();
  const sel = s.selection;
  if (extend && sel.kind === 'range') {
    s.select({
      kind: 'range',
      staffFrom: Math.min(sel.staffFrom, staffIndex),
      staffTo: Math.max(sel.staffTo, staffIndex),
      measureFrom: Math.min(sel.measureFrom, measureIndex),
      measureTo: Math.max(sel.measureTo, measureIndex),
    });
    return;
  }
  s.select({
    kind: 'range',
    staffFrom: staffIndex,
    staffTo: staffIndex,
    measureFrom: measureIndex,
    measureTo: measureIndex,
  });
}

export function selectNote(noteId: string, extend: boolean): void {
  const s = st();
  if (extend && s.selection.kind === 'notes') {
    const ids = s.selection.noteIds.includes(noteId)
      ? s.selection.noteIds.filter((x) => x !== noteId)
      : [...s.selection.noteIds, noteId];
    s.select(ids.length ? { kind: 'notes', noteIds: ids } : { kind: 'none' });
  } else {
    s.select({ kind: 'notes', noteIds: [noteId] });
  }
  if (s.input.active) {
    const loc = findEventOfNote(s.doc, noteId);
    if (loc)
      getStore().setState({
        cursor: {
          staffId: loc.staffId,
          voice: loc.voice,
          measureId: loc.measureId,
          offset: loc.event.offset,
        },
        lastEntered: loc.event.id,
      });
  }
}

/** Mouse input: enter a note at a clicked position (input mode). */
export function enterAtPosition(at: ScorePosition, staffPosition: number): Pitch | null {
  const s = st();
  getStore().setState({ cursor: at });
  const pitch = pitchForPosition(s.doc, at, staffPosition, s.view.concertPitch);
  return enterPitches(at, [pitch]) ? pitch : null;
}
