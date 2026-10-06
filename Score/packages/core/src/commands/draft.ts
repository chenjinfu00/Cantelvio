/** Helpers for mutating an immer draft of a ScoreDoc. Queries always run on the immutable base. */
import type { Draft } from 'immer';
import { comparePitch } from '../pitch/pitch';
import { type LocatedEvent, eventsOverlapping, measureInfos } from '../model/query';
import type { ID, NoteEvent, ScoreDoc, StaffMeasure } from '../model/types';
import { VOICES_PER_STAFF } from '../model/types';
import { type Rational, cmp, eq, lt, sub } from '../time/rational';

export type DraftDoc = Draft<ScoreDoc>;
export type DraftEvent = Draft<NoteEvent>;

export function draftStaffMeasure(
  draft: DraftDoc,
  staffId: ID,
  measureId: ID,
): Draft<StaffMeasure> {
  const staff = (draft.content[staffId] ??= {});
  return (staff[measureId] ??= { voices: [] });
}

export function draftVoice(
  draft: DraftDoc,
  staffId: ID,
  measureId: ID,
  voice: number,
): Draft<NoteEvent>[] {
  if (voice < 0 || voice >= VOICES_PER_STAFF) throw new RangeError(`voice ${voice} out of range`);
  const sm = draftStaffMeasure(draft, staffId, measureId);
  while (sm.voices.length <= voice) sm.voices.push([]);
  return sm.voices[voice]!;
}

/** Locate a draft event by its (base) location. */
export function draftEventAt(
  draft: DraftDoc,
  loc: Pick<LocatedEvent, 'staffId' | 'measureId' | 'voice' | 'event'>,
): DraftEvent | null {
  const list = draft.content[loc.staffId]?.[loc.measureId]?.voices[loc.voice];
  return list?.find((e) => e.id === loc.event.id) ?? null;
}

export function removeDraftEvent(
  draft: DraftDoc,
  loc: Pick<LocatedEvent, 'staffId' | 'measureId' | 'voice' | 'event'>,
): void {
  const list = draft.content[loc.staffId]?.[loc.measureId]?.voices[loc.voice];
  if (!list) return;
  const i = list.findIndex((e) => e.id === loc.event.id);
  if (i >= 0) list.splice(i, 1);
  pruneEmpty(draft, loc.staffId, loc.measureId);
}

/** Remove empty trailing voices and empty staff-measure entries to keep files minimal. */
export function pruneEmpty(draft: DraftDoc, staffId: ID, measureId: ID): void {
  const staff = draft.content[staffId];
  const sm = staff?.[measureId];
  if (!staff || !sm) return;
  while (sm.voices.length > 0 && sm.voices[sm.voices.length - 1]!.length === 0) sm.voices.pop();
  const empty =
    sm.voices.length === 0 &&
    !(sm.tuplets && sm.tuplets.length) &&
    !(sm.clefChanges && sm.clefChanges.length) &&
    !(sm.dynamics && sm.dynamics.length);
  if (empty) delete staff[measureId];
}

export function insertDraftEvent(
  draft: DraftDoc,
  staffId: ID,
  measureId: ID,
  voice: number,
  event: NoteEvent,
): void {
  const list = draftVoice(draft, staffId, measureId, voice);
  let i = 0;
  while (i < list.length && cmp(list[i]!.offset, event.offset) <= 0) i++;
  // Newly inserted values are not drafted by immer in this producer. Copy the notes array
  // before handlers sort it, so immutable/replayed command payloads remain reusable.
  list.splice(i, 0, { ...event, notes: [...event.notes] } as Draft<NoteEvent>);
}

export function sortNotes(event: DraftEvent): void {
  event.notes.sort((a, b) => comparePitch(a.pitch, b.pitch));
}

function clearTies(event: DraftEvent): void {
  for (const n of event.notes) delete n.tieForward;
}

/**
 * Overwrite semantics for one voice: after this, nothing in the voice sounds during [from, to).
 * Events starting before `from` are shortened; events starting inside are removed (their tails
 * become rests, as in MuseScore and Sibelius). Ties into the cleared range are dropped.
 */
export function clearVoiceRange(
  draft: DraftDoc,
  base: ScoreDoc,
  staffId: ID,
  voice: number,
  from: Rational,
  to: Rational,
): void {
  if (!lt(from, to)) return;
  for (const o of eventsOverlapping(base, staffId, voice, from, to)) {
    const d = draftEventAt(draft, o);
    if (!d) continue;
    if (lt(o.start, from)) {
      d.duration = sub(from, o.start);
      clearTies(d);
    } else {
      removeDraftEvent(draft, o);
    }
  }
  for (const e of eventsEndingAt(base, staffId, voice, from)) {
    const d = draftEventAt(draft, e);
    if (d) clearTies(d);
  }
}

export function eventsEndingAt(
  base: ScoreDoc,
  staffId: ID,
  voice: number,
  t: Rational,
): LocatedEvent[] {
  // An event ending at t overlaps [t - tiny, t); search the measure before and the one containing t.
  const tiny: Rational = { n: 1, d: 1 << 20 };
  return eventsOverlapping(base, staffId, voice, sub(t, tiny), t).filter((e) => eq(e.end, t));
}

export function measureIdsAfter(base: ScoreDoc, index: number): ID[] {
  return measureInfos(base)
    .slice(index)
    .map((m) => m.measure.id);
}
