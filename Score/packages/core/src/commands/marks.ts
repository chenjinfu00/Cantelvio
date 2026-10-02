/** Event marks (ornaments, tremolo, arpeggio, cue size, breath marks) and grace notes. */
import type { Draft } from 'immer';
import { type Pitch, comparePitch } from '../pitch/pitch';
import { NOTE_VALUES } from '../time/duration';
import { findEvent, findGrace, findNote, isContentId } from '../model/query';
import { ARPEGGIOS, BREATHS, ORNAMENTS, type GraceNote } from '../model/types';
import type { ScoreDoc } from '../model/types';
import { type DraftDoc, draftEventAt } from './draft';
import { type Command, CommandError } from './types';

type Cmd<T extends Command['type']> = Extract<Command, { type: T }>;

function fail(cmd: Command, message: string): never {
  throw new CommandError(cmd, message);
}

export function eventsSetProps(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'events.setProps'>): void {
  const p = cmd.props;
  if (p.ornament != null && !ORNAMENTS.includes(p.ornament)) fail(cmd, 'unknown ornament');
  if (p.arpeggio != null && !ARPEGGIOS.includes(p.arpeggio)) fail(cmd, 'unknown arpeggio');
  if (p.breath != null && !BREATHS.includes(p.breath)) fail(cmd, 'unknown breath mark');
  if (p.tremolo != null && !(Number.isInteger(p.tremolo) && p.tremolo >= 1 && p.tremolo <= 4))
    fail(cmd, 'tremolo needs 1–4 strokes');
  for (const id of cmd.eventIds) {
    const loc = findEvent(base, id);
    if (!loc) continue;
    const d = draftEventAt(draft, loc)!;
    if (p.ornament !== undefined) {
      if (p.ornament === null) delete d.ornament;
      else d.ornament = p.ornament;
    }
    if (p.tremolo !== undefined) {
      if (p.tremolo === null) delete d.tremolo;
      else d.tremolo = p.tremolo;
    }
    if (p.arpeggio !== undefined) {
      // a single note cannot be rolled
      if (p.arpeggio === null || loc.event.notes.length < 2) delete d.arpeggio;
      else d.arpeggio = p.arpeggio;
    }
    if (p.cue !== undefined) {
      if (p.cue) d.cue = true;
      else delete d.cue;
    }
    if (p.breath !== undefined) {
      if (p.breath === null) delete d.breath;
      else d.breath = p.breath;
    }
  }
}

function sortGraceNotes(g: Draft<GraceNote>): void {
  g.notes.sort((a, b) => comparePitch(a.pitch, b.pitch));
}

export function graceAdd(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'grace.add'>): void {
  const loc = findEvent(base, cmd.eventId) ?? fail(cmd, `unknown event ${cmd.eventId}`);
  const g = cmd.grace;
  if (g.notes.length === 0) fail(cmd, 'a grace note needs at least one note');
  if (!NOTE_VALUES.includes(g.value)) fail(cmd, 'unknown note value');
  const ids = [g.id, ...g.notes.map((n) => n.id)];
  if (new Set(ids).size !== ids.length) fail(cmd, 'duplicate ids');
  for (const id of ids) if (isContentId(base, id)) fail(cmd, `id ${id} already exists`);
  const count = loc.event.graces?.length ?? 0;
  if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index > count)
    fail(cmd, 'grace index out of range');
  const d = draftEventAt(draft, loc)!;
  const grace: GraceNote = {
    id: g.id,
    ...(g.slash ? { slash: true } : {}),
    value: g.value,
    notes: g.notes.map((n) => ({ id: n.id, pitch: n.pitch })),
  };
  const list = (d.graces ??= []);
  list.splice(cmd.index, 0, grace as Draft<GraceNote>);
  sortGraceNotes(list[cmd.index]!);
}

/** Remove one note of a grace chord (the grace goes when its last note goes). */
export function removeGraceNote(draft: DraftDoc, base: ScoreDoc, noteId: string): boolean {
  const found = findNote(base, noteId);
  if (!found?.grace) return false;
  const d = draftEventAt(draft, found.loc);
  const graces = d?.graces;
  const gi = graces?.findIndex((g) => g.id === found.grace!.id) ?? -1;
  if (!d || !graces || gi < 0) return true;
  const g = graces[gi]!;
  g.notes = g.notes.filter((n) => n.id !== noteId);
  if (g.notes.length === 0) graces.splice(gi, 1);
  if (graces.length === 0) delete d.graces;
  return true;
}

/** Set the pitch of a grace note; false when the id is not a grace note. */
export function setGracePitch(
  draft: DraftDoc,
  base: ScoreDoc,
  noteId: string,
  pitch: Pitch,
): boolean {
  const found = findNote(base, noteId);
  if (!found?.grace) return false;
  const g = draftEventAt(draft, found.loc)?.graces?.find((x) => x.id === found.grace!.id);
  const note = g?.notes.find((n) => n.id === noteId);
  if (g && note) {
    note.pitch = pitch;
    sortGraceNotes(g);
  }
  return true;
}

/** Add a note to a grace chord; false when `graceId` is not a grace note. */
export function addToGraceChord(
  draft: DraftDoc,
  base: ScoreDoc,
  graceId: string,
  note: { readonly id: string; readonly pitch: Pitch },
): boolean {
  const found = findGrace(base, graceId);
  if (!found) return false;
  const g = draftEventAt(draft, found.loc)?.graces?.find((x) => x.id === graceId);
  if (!g || g.notes.some((n) => comparePitch(n.pitch, note.pitch) === 0)) return true;
  g.notes.push({ id: note.id, pitch: note.pitch });
  sortGraceNotes(g);
  return true;
}
