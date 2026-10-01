import type { Draft } from 'immer';
import { midiOf } from '../pitch/pitch';
import {
  findEvent,
  findEventOfNote,
  hasMeasure,
  hasStaff,
  measureInfo,
  measureInfos,
  scoreLength,
  tupletsIn,
} from '../model/query';
import type { NoteEvent, ScorePosition, TupletSpan } from '../model/types';
import { VOICES_PER_STAFF } from '../model/types';
import { type Rational, add, cmp, isPositive, le, lt, min, sub } from '../time/rational';
import {
  type DraftDoc,
  clearVoiceRange,
  draftEventAt,
  draftStaffMeasure,
  eventsEndingAt,
  insertDraftEvent,
  pruneEmpty,
  removeDraftEvent,
  sortNotes,
} from './draft';
import { type Command, CommandError } from './types';
import type { ScoreDoc } from '../model/types';

type Cmd<T extends Command['type']> = Extract<Command, { type: T }>;

function fail(cmd: Command, message: string): never {
  throw new CommandError(cmd, message);
}

function checkPosition(
  cmd: Command,
  base: ScoreDoc,
  at: ScorePosition,
): { start: Rational; measureEnd: Rational } {
  if (!hasStaff(base, at.staffId)) fail(cmd, `unknown staff ${at.staffId}`);
  if (!hasMeasure(base, at.measureId)) fail(cmd, `unknown measure ${at.measureId}`);
  if (!Number.isInteger(at.voice) || at.voice < 0 || at.voice >= VOICES_PER_STAFF)
    fail(cmd, `invalid voice ${at.voice}`);
  const info = measureInfo(base, at.measureId);
  if (lt(at.offset, { n: 0, d: 1 }) || !lt(at.offset, info.length))
    fail(cmd, 'offset outside the measure');
  return { start: add(info.start, at.offset), measureEnd: add(info.start, info.length) };
}

/** The tuplet of this voice that contains the position, if any. */
function tupletAt(base: ScoreDoc, at: ScorePosition): TupletSpan | undefined {
  return tupletsIn(base, at.staffId, at.measureId, at.voice).find(
    (t) => le(t.offset, at.offset) && lt(at.offset, add(t.offset, t.length)),
  );
}

/**
 * End time of an input of `duration` starting at `at`: clipped to the end of the score and, inside
 * a tuplet, to the end of the tuplet.
 */
export function inputEnd(base: ScoreDoc, at: ScorePosition, duration: Rational): Rational {
  const info = measureInfo(base, at.measureId);
  const start = add(info.start, at.offset);
  let end = min(add(start, duration), scoreLength(base));
  const tuplet = tupletAt(base, at);
  if (tuplet) end = min(end, add(info.start, add(tuplet.offset, tuplet.length)));
  return end;
}

/** Remove tuplet spans of a voice that partially intersect [from, to), plus their events. */
function dissolveIntersectedTuplets(
  draft: DraftDoc,
  base: ScoreDoc,
  at: ScorePosition,
  from: Rational,
  to: Rational,
): Rational[] {
  const covered: Rational[] = [from, to];
  const inside = tupletAt(base, at);
  for (const m of measureInfos(base)) {
    if (cmp(m.start, to) >= 0) break;
    const tuplets = base.content[at.staffId]?.[m.measure.id]?.tuplets ?? [];
    for (const t of tuplets) {
      if (t.voice !== at.voice || t.id === inside?.id) continue;
      const ts = add(m.start, t.offset);
      const te = add(ts, t.length);
      if (lt(ts, to) && lt(from, te)) {
        const sm = draftStaffMeasure(draft, at.staffId, m.measure.id);
        sm.tuplets = (sm.tuplets ?? []).filter((x) => x.id !== t.id);
        if (sm.tuplets.length === 0) delete sm.tuplets;
        covered.push(ts, te);
      }
    }
  }
  const lo = covered.reduce((a, b) => (lt(b, a) ? b : a));
  const hi = covered.reduce((a, b) => (lt(a, b) ? b : a));
  return [lo, hi];
}

export function noteEnter(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'note.enter'>): void {
  const { at } = cmd;
  const { start } = checkPosition(cmd, base, at);
  if (!isPositive(cmd.duration)) fail(cmd, 'duration must be positive');
  if (cmd.pitches.length === 0 || cmd.pitches.length !== cmd.noteIds.length)
    fail(cmd, 'pitches and noteIds must match');
  if (findEvent(base, cmd.eventId)) fail(cmd, `event id ${cmd.eventId} already exists`);
  const end = inputEnd(base, at, cmd.duration);
  const [clearFrom, clearTo] = dissolveIntersectedTuplets(draft, base, at, start, end);
  for (const voice of [at.voice])
    clearVoiceRange(draft, base, at.staffId, voice, clearFrom!, clearTo!);
  const event: NoteEvent = {
    id: cmd.eventId,
    kind: 'note',
    offset: at.offset,
    duration: sub(end, start),
    notes: cmd.pitches.map((pitch, i) => ({ id: cmd.noteIds[i]!, pitch })),
  };
  insertDraftEvent(draft, at.staffId, at.measureId, at.voice, event);
  const inserted = draftEventAt(draft, {
    staffId: at.staffId,
    measureId: at.measureId,
    voice: at.voice,
    event,
  });
  if (inserted) sortNotes(inserted);
  if (cmd.tieFromPrevious) {
    const midis = new Set(cmd.pitches.map(midiOf));
    for (const prev of eventsEndingAt(base, at.staffId, at.voice, start)) {
      const d = draftEventAt(draft, prev);
      if (!d) continue;
      for (const n of d.notes) if (midis.has(midiOf(n.pitch))) n.tieForward = true;
    }
  }
}

export function restEnter(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'rest.enter'>): void {
  const { start } = checkPosition(cmd, base, cmd.at);
  if (!isPositive(cmd.duration)) fail(cmd, 'duration must be positive');
  const end = inputEnd(base, cmd.at, cmd.duration);
  clearVoiceRange(draft, base, cmd.at.staffId, cmd.at.voice, start, end);
}

export function noteAddToChord(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'note.addToChord'>): void {
  const loc = findEvent(base, cmd.eventId) ?? fail(cmd, `unknown event ${cmd.eventId}`);
  if (findEventOfNote(base, cmd.noteId)) fail(cmd, `note id ${cmd.noteId} already exists`);
  if (
    loc.event.notes.some(
      (n) => midiOf(n.pitch) === midiOf(cmd.pitch) && n.pitch.step === cmd.pitch.step,
    )
  )
    return;
  const d = draftEventAt(draft, loc)!;
  d.notes.push({ id: cmd.noteId, pitch: cmd.pitch });
  sortNotes(d);
}

export function noteSetPitch(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'note.setPitch'>): void {
  const loc = findEventOfNote(base, cmd.noteId) ?? fail(cmd, `unknown note ${cmd.noteId}`);
  const d = draftEventAt(draft, loc)!;
  const note = d.notes.find((n) => n.id === cmd.noteId)!;
  note.pitch = cmd.pitch;
  sortNotes(d);
}

export function notesDelete(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'notes.delete'>): void {
  for (const noteId of cmd.noteIds) {
    const loc = findEventOfNote(base, noteId);
    if (!loc) continue;
    const d = draftEventAt(draft, loc);
    if (!d) continue;
    d.notes = d.notes.filter((n) => n.id !== noteId);
    if (d.notes.length === 0) removeDraftEvent(draft, loc);
  }
}

export function eventsDelete(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'events.delete'>): void {
  for (const eventId of cmd.eventIds) {
    const loc = findEvent(base, eventId);
    if (loc) removeDraftEvent(draft, loc);
  }
}

export function eventSetDuration(
  draft: DraftDoc,
  base: ScoreDoc,
  cmd: Cmd<'event.setDuration'>,
): void {
  const loc = findEvent(base, cmd.eventId) ?? fail(cmd, `unknown event ${cmd.eventId}`);
  if (!isPositive(cmd.duration)) fail(cmd, 'duration must be positive');
  const at: ScorePosition = {
    staffId: loc.staffId,
    voice: loc.voice,
    measureId: loc.measureId,
    offset: loc.event.offset,
  };
  const end = inputEnd(base, at, cmd.duration);
  if (lt(loc.end, end)) clearVoiceRange(draft, base, loc.staffId, loc.voice, loc.end, end);
  const d = draftEventAt(draft, loc)!;
  d.duration = sub(end, loc.start);
  if (lt(end, loc.end)) for (const n of d.notes) delete n.tieForward;
}

export function notesSetTie(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'notes.setTie'>): void {
  for (const noteId of cmd.noteIds) {
    const loc = findEventOfNote(base, noteId);
    if (!loc) continue;
    const note = draftEventAt(draft, loc)?.notes.find((n) => n.id === noteId);
    if (!note) continue;
    if (cmd.tie) note.tieForward = true;
    else delete note.tieForward;
  }
}

export function eventsSetArticulation(
  draft: DraftDoc,
  base: ScoreDoc,
  cmd: Cmd<'events.setArticulation'>,
): void {
  for (const id of cmd.eventIds) {
    const loc = findEvent(base, id);
    if (!loc) continue;
    const d = draftEventAt(draft, loc)!;
    const set = new Set(d.articulations ?? []);
    if (cmd.on) set.add(cmd.articulation);
    else set.delete(cmd.articulation);
    if (set.size) d.articulations = [...set].sort();
    else delete d.articulations;
  }
}

export function eventsSetStem(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'events.setStem'>): void {
  for (const id of cmd.eventIds) {
    const loc = findEvent(base, id);
    if (!loc) continue;
    const d = draftEventAt(draft, loc)!;
    if (cmd.stem) d.stem = cmd.stem;
    else delete d.stem;
  }
}

export function rangeClear(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'range.clear'>): void {
  if (!hasMeasure(base, cmd.from.measureId) || !hasMeasure(base, cmd.to.measureId))
    fail(cmd, 'unknown measure');
  const from = add(measureInfo(base, cmd.from.measureId).start, cmd.from.offset);
  const to = add(measureInfo(base, cmd.to.measureId).start, cmd.to.offset);
  const voices = cmd.voices ?? [0, 1, 2, 3];
  for (const staffId of cmd.staffIds) {
    if (!hasStaff(base, staffId)) fail(cmd, `unknown staff ${staffId}`);
    for (const v of voices) clearVoiceRange(draft, base, staffId, v, from, to);
    // Tuplets and dynamics fully inside the range go too.
    for (const m of measureInfos(base)) {
      if (cmp(m.start, to) >= 0) break;
      const sm = base.content[staffId]?.[m.measure.id];
      if (!sm) continue;
      const inside = (offset: Rational, length: Rational = { n: 0, d: 1 }) => {
        const s = add(m.start, offset);
        return le(from, s) && le(add(s, length), to) && lt(s, to);
      };
      const tuplets = (sm.tuplets ?? []).filter(
        (t) => voices.includes(t.voice) && inside(t.offset, t.length),
      );
      const dynamics = (sm.dynamics ?? []).filter((d) => inside(d.offset));
      if (!tuplets.length && !dynamics.length) continue;
      const dsm = draftStaffMeasure(draft, staffId, m.measure.id);
      if (dsm.tuplets) dsm.tuplets = dsm.tuplets.filter((t) => !tuplets.some((x) => x.id === t.id));
      if (dsm.dynamics)
        dsm.dynamics = dsm.dynamics.filter((d) => !dynamics.some((x) => x.id === d.id));
      if (dsm.tuplets?.length === 0) delete dsm.tuplets;
      if (dsm.dynamics?.length === 0) delete dsm.dynamics;
      pruneEmpty(draft, staffId, m.measure.id);
    }
  }
}

export function tupletCreate(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'tuplet.create'>): void {
  const { at } = cmd;
  const { start } = checkPosition(cmd, base, at);
  const info = measureInfo(base, at.measureId);
  if (!isPositive(cmd.length)) fail(cmd, 'tuplet length must be positive');
  if (
    !Number.isInteger(cmd.actual) ||
    !Number.isInteger(cmd.normal) ||
    cmd.actual < 2 ||
    cmd.normal < 1
  ) {
    fail(cmd, 'invalid tuplet ratio');
  }
  if (cmp(add(at.offset, cmd.length), info.length) > 0) fail(cmd, 'tuplets cannot cross a barline');
  const end = add(start, cmd.length);
  for (const t of tupletsIn(base, at.staffId, at.measureId, at.voice)) {
    const ts = t.offset;
    const te = add(t.offset, t.length);
    if (lt(ts, add(at.offset, cmd.length)) && lt(at.offset, te))
      fail(cmd, 'overlaps an existing tuplet');
  }
  clearVoiceRange(draft, base, at.staffId, at.voice, start, end);
  const sm = draftStaffMeasure(draft, at.staffId, at.measureId);
  const tuplet: TupletSpan = {
    id: cmd.id,
    voice: at.voice,
    offset: at.offset,
    length: cmd.length,
    actual: cmd.actual,
    normal: cmd.normal,
  };
  sm.tuplets = [...(sm.tuplets ?? []), tuplet as Draft<TupletSpan>].sort(
    (a, b) => a.voice - b.voice || cmp(a.offset, b.offset),
  );
}
