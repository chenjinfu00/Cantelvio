/**
 * Keypad and shortcut actions for marks, grace notes, lines and dynamics (MuseScore semantics:
 * they apply to the selection, or to the note just entered during note input). Lines started
 * during note input grow with every note entered until they are ended.
 */
import {
  type Arpeggio,
  type Articulation,
  type Breath,
  type Command,
  type DynamicValue,
  EXCLUSIVE_ARTICULATIONS,
  type LocatedEvent,
  type NoteEvent,
  type NoteValue,
  type Ornament,
  type Pitch,
  type Rational,
  type ScoreDoc,
  type Spanner,
  type TimeSpan,
  absoluteTime,
  add,
  allStaves,
  applyCommands,
  cmp,
  endAnchor,
  eventsOverlapping,
  findEvent,
  findNote,
  hasStaff,
  le,
  lt,
  measureInfos,
  min,
  scoreLength,
  spannerTimes,
  startAnchor,
  staffInfo,
  voiceTimeline,
  writtenFromLength,
} from '@cantelvio-score/core';
import { translate } from '../i18n';
import { type PendingLine, type Selection, getStore } from './store';

const st = () => getStore().getState();

// ------------------------------------------------------------------------------- selection

/** Events of the selection: selected notes, the note just entered, or every event of a range. */
export function selectedEvents(doc: ScoreDoc = st().doc, selection: Selection = st().selection) {
  const s = st();
  const out = new Map<string, LocatedEvent>();
  if (selection.kind === 'notes') {
    for (const id of selection.noteIds) {
      const loc = findNote(doc, id)?.loc;
      if (loc) out.set(loc.event.id, loc);
    }
  } else if (selection.kind === 'range') {
    const infos = measureInfos(doc);
    const from = infos[selection.measureFrom]!.start;
    const last = infos[selection.measureTo]!;
    const to = add(last.start, last.length);
    for (const staff of allStaves(doc).slice(selection.staffFrom, selection.staffTo + 1))
      for (let v = 0; v < 4; v++)
        for (const loc of eventsOverlapping(doc, staff.staff.id, v, from, to))
          if (!lt(loc.start, from)) out.set(loc.event.id, loc);
  }
  if (!out.size && s.input.active && s.lastEntered) {
    const loc = findEvent(doc, s.lastEntered);
    if (loc) out.set(loc.event.id, loc);
  }
  return [...out.values()].sort((a, b) => cmp(a.start, b.start));
}

export function selectedEventIds(): string[] {
  return selectedEvents().map((l) => l.event.id);
}

/** Selected grace notes (their grace chords), if the selection is made of grace notes only. */
function selectedGraces(): { eventId: string; graceId: string; index: number; pitch: Pitch }[] {
  const s = st();
  if (s.selection.kind !== 'notes') return [];
  const out = new Map<string, { eventId: string; graceId: string; index: number; pitch: Pitch }>();
  for (const id of s.selection.noteIds) {
    const n = findNote(s.doc, id);
    if (!n?.grace) return [];
    const top = n.grace.notes[n.grace.notes.length - 1]!.pitch;
    out.set(n.grace.id, {
      eventId: n.loc.event.id,
      graceId: n.grace.id,
      index: n.graceIndex,
      pitch: top,
    });
  }
  return [...out.values()];
}

export function onlyGracesSelected(): boolean {
  return selectedGraces().length > 0;
}

function nothingSelected(): void {
  const s = st();
  s.notify(translate(s.view.lang, 'marks.selectFirst'), 'error');
}

// ------------------------------------------------------------------------------- event marks

export function toggleArticulation(articulation: Articulation): void {
  const s = st();
  const events = selectedEvents();
  if (!events.length) return nothingSelected();
  const eventIds = events.map((l) => l.event.id);
  const on = events.some((l) => !l.event.articulations?.includes(articulation));
  const cmds: Command[] = [];
  if (on) {
    // one fermata, one bowing, stopped or open
    const group = EXCLUSIVE_ARTICULATIONS.find((g) => g.includes(articulation)) ?? [];
    for (const other of group)
      if (other !== articulation)
        cmds.push({ type: 'events.setArticulation', eventIds, articulation: other, on: false });
  }
  cmds.push({ type: 'events.setArticulation', eventIds, articulation, on });
  s.apply(cmds, 'articulation');
}

type PropKey = 'ornament' | 'tremolo' | 'arpeggio' | 'breath';

function toggleProp<K extends PropKey>(key: K, value: NonNullable<NoteEvent[K]>, label: string) {
  const s = st();
  const events = selectedEvents();
  if (!events.length) return nothingSelected();
  const on = events.some((l) => l.event[key] !== value);
  s.apply(
    {
      type: 'events.setProps',
      eventIds: events.map((l) => l.event.id),
      props: { [key]: on ? value : null },
    },
    label,
  );
}

export const toggleOrnament = (o: Ornament) => toggleProp('ornament', o, 'ornament');
export const toggleTremolo = (strokes: number) => toggleProp('tremolo', strokes, 'tremolo');
export const toggleArpeggio = (a: Arpeggio) => toggleProp('arpeggio', a, 'arpeggio');
export const toggleBreath = (b: Breath) => toggleProp('breath', b, 'breath');

export function toggleCue(): void {
  const s = st();
  const events = selectedEvents();
  if (!events.length) return nothingSelected();
  const on = events.some((l) => !l.event.cue);
  s.apply(
    { type: 'events.setProps', eventIds: events.map((l) => l.event.id), props: { cue: on } },
    'cue size',
  );
}

export function setStem(stem: 'up' | 'down' | null): void {
  const s = st();
  const events = selectedEvents();
  if (!events.length) return nothingSelected();
  s.apply({ type: 'events.setStem', eventIds: events.map((l) => l.event.id), stem }, 'stem');
}

/** X: flip the stems of the selection (from their drawn direction when not forced). */
export function flipStem(): void {
  const events = selectedEvents();
  if (!events.length) return nothingSelected();
  const anyDown = events.some((l) => l.event.stem === 'down');
  setStem(anyDown ? 'up' : 'down');
}

// ------------------------------------------------------------------------------- grace notes

export type GraceKind = 'acciaccatura' | 'appoggiatura' | 'grace16' | 'grace32' | 'graceQuarter';

const GRACE_KINDS: Record<GraceKind, { slash: boolean; value: NoteValue }> = {
  acciaccatura: { slash: true, value: 'eighth' },
  appoggiatura: { slash: false, value: 'eighth' },
  grace16: { slash: false, value: '16th' },
  grace32: { slash: false, value: '32nd' },
  graceQuarter: { slash: false, value: 'quarter' },
};

/**
 * Add a grace note before each selected note, at its pitch (MuseScore); with a grace note
 * selected, the new one follows it. The new grace notes are selected: ↑/↓ or a letter re-pitches.
 */
export function addGrace(kind: GraceKind): void {
  const s = st();
  const def = GRACE_KINDS[kind];
  const targets: { eventId: string; index: number; pitch: Pitch }[] = [];
  const graces = selectedGraces();
  if (graces.length) {
    for (const g of graces)
      targets.push({ eventId: g.eventId, index: g.index + 1, pitch: g.pitch });
  } else {
    for (const loc of selectedEvents()) {
      targets.push({
        eventId: loc.event.id,
        index: loc.event.graces?.length ?? 0,
        pitch: loc.event.notes[loc.event.notes.length - 1]!.pitch,
      });
    }
  }
  if (!targets.length) return nothingSelected();
  // later places first, so that each insertion leaves the indices of the others valid
  targets.sort((a, b) => b.index - a.index);
  const noteIds: string[] = [];
  const cmds: Command[] = targets.map((t) => {
    const noteId = s.ids.next('n');
    noteIds.push(noteId);
    return {
      type: 'grace.add',
      eventId: t.eventId,
      index: t.index,
      grace: {
        id: s.ids.next('gc'),
        ...(def.slash ? { slash: true } : {}),
        value: def.value,
        notes: [{ id: noteId, pitch: t.pitch }],
      },
    };
  });
  s.apply(cmds, 'grace note', { selection: { kind: 'notes', noteIds } });
}

// ------------------------------------------------------------------------------- lines

export type LineKind =
  | 'slur'
  | 'crescendo'
  | 'diminuendo'
  | '8va'
  | '8vb'
  | '15ma'
  | '15mb'
  | 'trill'
  | 'pedal'
  | 'pedalLine';

const OTTAVAS: Partial<Record<LineKind, number>> = { '8va': 1, '8vb': -1, '15ma': 2, '15mb': -2 };

/** A time spanner of the given kind (without anchors). */
function timeLine(kind: LineKind): Record<string, unknown> {
  if (kind === 'crescendo' || kind === 'diminuendo') return { kind: 'hairpin', direction: kind };
  if (OTTAVAS[kind] !== undefined) return { kind: 'ottava', octaves: OTTAVAS[kind] };
  if (kind === 'trill') return { kind: 'trill' };
  return kind === 'pedalLine' ? { kind: 'pedal', style: 'line' } : { kind: 'pedal' };
}

const sameFamily = (a: Spanner, b: Record<string, unknown>) => a.kind === b.kind;

/** Pedal marks go under the lowest staff of the instrument. */
function lineStaff(doc: ScoreDoc, staffId: string, kind: LineKind): string {
  if (kind !== 'pedal' && kind !== 'pedalLine') return staffId;
  const part = staffInfo(doc, staffId).part;
  return part.staves[part.staves.length - 1]!.id;
}

/**
 * Commands adding a time line on a staff over [start, end): lines of the same kind on that
 * staff are trimmed (or split) so the new one replaces them where they overlap.
 */
function timeLineCommands(
  doc: ScoreDoc,
  staffId: string,
  kind: LineKind,
  start: Rational,
  end: Rational,
  id: string,
): Command[] {
  const s = st();
  const line = timeLine(kind);
  const a = startAnchor(doc, start);
  const b = endAnchor(doc, end);
  if (!a || !b || !lt(start, end)) return [];
  const cmds: Command[] = [];
  for (const o of doc.spanners) {
    if (o.kind === 'slur' || o.staffId !== staffId || !sameFamily(o, line)) continue;
    const t = spannerTimes(doc, o);
    if (!t || !lt(t.start, end) || !lt(start, t.end)) continue;
    const before = lt(t.start, start);
    const after = lt(end, t.end);
    if (!before && !after) cmds.push({ type: 'spanners.delete', ids: [o.id] });
    else if (before && after) {
      cmds.push({ type: 'spanner.set', spanner: { ...o, end: endAnchor(doc, start)! } });
      cmds.push({
        type: 'spanner.add',
        spanner: { ...o, id: s.ids.next('sp'), start: startAnchor(doc, end)! },
      });
    } else if (before)
      cmds.push({ type: 'spanner.set', spanner: { ...o, end: endAnchor(doc, start)! } });
    else cmds.push({ type: 'spanner.set', spanner: { ...o, start: startAnchor(doc, end)! } });
  }
  cmds.push({
    type: 'spanner.add',
    spanner: { id, staffId, start: a, end: b, ...line } as unknown as Spanner,
  });
  return cmds;
}

/** The next event of a voice after `loc` (for a slur from a single selected note). */
function nextEvent(doc: ScoreDoc, loc: LocatedEvent): LocatedEvent | null {
  return voiceTimeline(doc, loc.staffId, loc.voice).find((e) => lt(loc.start, e.start)) ?? null;
}

/**
 * Add a line (MuseScore): over the selected notes, over each staff of a range, or — during note
 * input — from the note just entered, growing as more notes are entered (press again to end).
 */
export function addLine(kind: LineKind): void {
  const s = st();
  const lang = s.view.lang;
  if (s.input.active) {
    const pending = s.input.pendingLine;
    if (pending) {
      endPendingLine();
      if (lineKindOf(pending.spanner) === kind) return;
    }
    const loc = s.lastEntered ? findEvent(s.doc, s.lastEntered) : null;
    if (!loc) {
      s.notify(translate(lang, 'marks.enterNoteFirst'), 'error');
      return;
    }
    startPendingLine(kind, loc);
    return;
  }
  const doc = s.doc;
  const cmds: Command[] = [];
  const created: string[] = [];
  if (s.selection.kind === 'range') {
    const sel = s.selection;
    const infos = measureInfos(doc);
    const from = infos[sel.measureFrom]!.start;
    const last = infos[sel.measureTo]!;
    const to = add(last.start, last.length);
    const staves = allStaves(doc).slice(sel.staffFrom, sel.staffTo + 1);
    const done = new Set<string>();
    for (const staff of staves) {
      if (kind === 'slur') {
        for (let v = 0; v < 4; v++) {
          const evs = eventsOverlapping(doc, staff.staff.id, v, from, to).filter(
            (e) => !lt(e.start, from),
          );
          if (evs.length < 2) continue;
          const id = s.ids.next('sp');
          created.push(id);
          cmds.push({
            type: 'spanner.add',
            spanner: {
              id,
              kind: 'slur',
              staffId: staff.staff.id,
              from: evs[0]!.event.id,
              to: evs[evs.length - 1]!.event.id,
            },
          });
        }
        continue;
      }
      const target = lineStaff(doc, staff.staff.id, kind);
      if (done.has(target)) continue;
      done.add(target);
      const id = s.ids.next('sp');
      const c = timeLineCommands(doc, target, kind, from, to, id);
      if (c.length) {
        created.push(id);
        cmds.push(...c);
      }
    }
  } else {
    const events = selectedEvents();
    if (!events.length) return nothingSelected();
    // one line per staff (and per voice for slurs)
    const groups = new Map<string, LocatedEvent[]>();
    for (const e of events) {
      const key = kind === 'slur' ? `${e.staffId}:${e.voice}` : lineStaff(doc, e.staffId, kind);
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    for (const [key, evs] of groups) {
      const first = evs[0]!;
      const last = evs[evs.length - 1]!;
      const id = s.ids.next('sp');
      if (kind === 'slur') {
        const to = evs.length > 1 ? last : nextEvent(doc, first);
        if (!to) continue;
        created.push(id);
        cmds.push({
          type: 'spanner.add',
          spanner: {
            id,
            kind: 'slur',
            staffId: first.staffId,
            from: first.event.id,
            to: to.event.id,
          },
        });
        continue;
      }
      const end = evs.reduce((m, e) => (lt(m, e.end) ? e.end : m), first.end);
      const c = timeLineCommands(doc, key, kind, first.start, end, id);
      if (c.length) {
        created.push(id);
        cmds.push(...c);
      }
    }
  }
  if (!cmds.length) {
    s.notify(translate(lang, 'marks.noLine'), 'error');
    return;
  }
  s.apply(cmds, 'line', { selection: { kind: 'marks', spanners: created, dynamics: [] } });
}

function lineKindOf(sp: Spanner): LineKind {
  if (sp.kind === 'slur') return 'slur';
  if (sp.kind === 'hairpin') return sp.direction;
  if (sp.kind === 'ottava')
    return sp.octaves === 1
      ? '8va'
      : sp.octaves === -1
        ? '8vb'
        : sp.octaves === 2
          ? '15ma'
          : '15mb';
  if (sp.kind === 'trill') return 'trill';
  return sp.style === 'line' ? 'pedalLine' : 'pedal';
}

export function pendingLineKind(): LineKind | null {
  const p = st().input.pendingLine;
  return p ? lineKindOf(p.spanner) : null;
}

function startPendingLine(kind: LineKind, loc: LocatedEvent): void {
  const s = st();
  const id = s.ids.next('sp');
  if (kind === 'slur') {
    const spanner: Spanner = {
      id,
      kind: 'slur',
      staffId: loc.staffId,
      from: loc.event.id,
      to: loc.event.id,
    };
    s.setInput({ pendingLine: { spanner, created: false, voice: loc.voice } });
    return;
  }
  const staffId = lineStaff(s.doc, loc.staffId, kind);
  const cmds = timeLineCommands(s.doc, staffId, kind, loc.start, loc.end, id);
  if (!cmds.length || !s.apply(cmds, 'line')) return;
  const spanner = st().doc.spanners.find((x) => x.id === id);
  if (spanner) st().setInput({ pendingLine: { spanner, created: true, voice: loc.voice } });
}

export function endPendingLine(): void {
  if (st().input.pendingLine) st().setInput({ pendingLine: null });
}

/** What happens to the pending line with an entry: the commands growing it, and its next state. */
export interface PendingStep {
  readonly commands: Command[];
  /** The pending line after the entry; null when the entry ended it. */
  readonly next: PendingLine | null;
}

/**
 * Commands that extend the pending line over an entry about to be made: `cmds` enter a note
 * (`eventId`) or a rest (`eventId` null) at `start` lasting `duration`. Computed on a preview of
 * the document after the entry, so the line can reach bars the entry appends. The entry always
 * wins: when the line cannot follow it (the cursor went back before the line, the line would run
 * into another line of its kind, its notes or staff are gone), the line ends instead.
 */
export function extendPendingLine(
  cmds: readonly Command[],
  entry: {
    readonly eventId: string | null;
    readonly staffId: string;
    readonly start: Rational;
    readonly duration: Rational;
  },
): PendingStep {
  const s = st();
  const pending = s.input.pendingLine;
  if (!pending) return { commands: [], next: null };
  const keep: PendingStep = { commands: [], next: pending };
  const stop: PendingStep = { commands: [], next: null };
  let preview: ScoreDoc;
  try {
    preview = applyCommands(s.doc, cmds);
  } catch {
    return keep; // the entry itself is refused; the caller reports why
  }
  if (!hasStaff(preview, pending.spanner.staffId)) return stop;
  // the line as the document has it (bars may have been re-barred since it was started)
  const sp = preview.spanners.find((x) => x.id === pending.spanner.id) ?? pending.spanner;
  let next: Spanner;
  if (sp.kind === 'slur') {
    const from = findEvent(preview, sp.from);
    if (!from) {
      // the first note was entered again: the slur starts on the new note
      const old = findEvent(s.doc, sp.from);
      const again =
        !!entry.eventId &&
        !!old &&
        entry.staffId === sp.staffId &&
        findEvent(preview, entry.eventId)?.voice === pending.voice &&
        cmp(old.start, entry.start) === 0;
      if (!again) return stop;
      const restart: Spanner = { ...sp, from: entry.eventId!, to: entry.eventId! };
      return { commands: [], next: { ...pending, spanner: restart, created: false } };
    }
    // slurs join notes of their own staff and voice (rests are skipped)
    if (!entry.eventId || sp.staffId !== entry.staffId) return keep;
    const loc = findEvent(preview, entry.eventId);
    if (!loc || loc.voice !== pending.voice) return keep;
    if (!lt(from.start, loc.start)) return stop; // entered before the slur: it cannot follow
    next = { ...sp, to: entry.eventId };
  } else {
    // time lines grow with notes and rests of the same instrument
    if (!hasStaff(preview, entry.staffId)) return keep;
    if (staffInfo(preview, sp.staffId).part.id !== staffInfo(preview, entry.staffId).part.id)
      return keep;
    const t = spannerTimes(preview, sp);
    if (!t || lt(entry.start, t.start)) return stop;
    const loc = entry.eventId ? findEvent(preview, entry.eventId) : null;
    const until = loc ? loc.end : min(add(entry.start, entry.duration), scoreLength(preview));
    if (le(until, t.end) && inDoc(preview, sp.id)) return keep;
    // it ends where the next line of its kind on the staff begins (a hairpin at the next one…)
    const blocked = preview.spanners.some((o) => {
      if (o.id === sp.id || o.kind !== sp.kind || o.staffId !== sp.staffId) return false;
      const ot = spannerTimes(preview, o);
      return !!ot && lt(ot.start, until) && lt(t.start, ot.end);
    });
    const anchor = endAnchor(preview, until);
    if (blocked || !anchor) return stop;
    next = { ...(sp as TimeSpan), end: anchor } as Spanner;
  }
  // (re)create it when it is not in the document (a slur's second note, or after a prune)
  const command: Command = {
    type: inDoc(preview, sp.id) ? 'spanner.set' : 'spanner.add',
    spanner: next,
  };
  try {
    applyCommands(preview, [command]);
  } catch {
    return stop;
  }
  return { commands: [command], next: { ...pending, spanner: next, created: true } };
}

const inDoc = (doc: ScoreDoc, id: string) => doc.spanners.some((x) => x.id === id);

// ------------------------------------------------------------------------------- dynamics

/** A dynamic at the start of the selection on each of its staves (or at the note just entered). */
export function addDynamic(value: DynamicValue): void {
  const s = st();
  const doc = s.doc;
  const at = new Map<string, { measureId: string; offset: Rational }>();
  if (s.selection.kind === 'range') {
    const m = doc.measures[s.selection.measureFrom]!;
    for (const staff of allStaves(doc).slice(s.selection.staffFrom, s.selection.staffTo + 1))
      at.set(staff.staff.id, { measureId: m.id, offset: { n: 0, d: 1 } });
  } else {
    for (const loc of selectedEvents())
      if (!at.has(loc.staffId))
        at.set(loc.staffId, { measureId: loc.measureId, offset: loc.event.offset });
    if (!at.size && s.input.active && s.cursor)
      at.set(s.cursor.staffId, { measureId: s.cursor.measureId, offset: s.cursor.offset });
  }
  if (!at.size) return nothingSelected();
  const ids: string[] = [];
  const cmds: Command[] = [...at].map(([staffId, p]) => {
    const id = s.ids.next('dy');
    ids.push(id);
    return {
      type: 'dynamic.set',
      staffId,
      measureId: p.measureId,
      mark: { id, offset: p.offset, value },
    };
  });
  // a hairpin being drawn in note input ends at the dynamic (on the note just entered)
  const pending = s.input.active ? s.input.pendingLine : null;
  const hairpin =
    pending?.spanner.kind === 'hairpin'
      ? doc.spanners.find((x) => x.id === pending.spanner.id)
      : undefined;
  const p = hairpin && at.get(hairpin.staffId);
  const span = hairpin && spannerTimes(doc, hairpin);
  if (hairpin && p && span) {
    const t = absoluteTime(doc, p.measureId, p.offset);
    const end = endAnchor(doc, t);
    if (end && lt(span.start, t) && lt(t, span.end))
      cmds.push({ type: 'spanner.set', spanner: { ...(hairpin as TimeSpan), end } as Spanner });
  }
  const ok = s.apply(
    cmds,
    'dynamic',
    s.input.active ? undefined : { selection: { kind: 'marks', spanners: [], dynamics: ids } },
  );
  if (ok && pending?.spanner.kind === 'hairpin') endPendingLine();
}

// ------------------------------------------------------------------------------- state for the keypad

export interface MarksState {
  readonly events: number;
  readonly articulations: ReadonlySet<Articulation>;
  readonly ornament: Ornament | null;
  readonly tremolo: number;
  readonly arpeggio: Arpeggio | null;
  readonly breath: Breath | null;
  readonly cue: boolean;
  readonly stem: 'up' | 'down' | null;
  /** Written value of the selected notes when they share one. */
  readonly written: { value: NoteValue; dots: number } | null;
  readonly alter: number | null;
  readonly graces: boolean;
}

const common = <T>(values: T[]): T | null =>
  values.length && values.every((v) => v === values[0]) ? values[0]! : null;

/** What the selection carries, so keypad buttons can show it (Sibelius). */
export function marksState(
  doc: ScoreDoc,
  selection: Selection,
  lastEntered: string | null,
  inputActive: boolean,
): MarksState {
  const events = selectedEventsFor(doc, selection, inputActive ? lastEntered : null);
  const all = <T>(f: (e: NoteEvent) => T) => common(events.map((l) => f(l.event)));
  const arts = new Set<Articulation>();
  if (events.length) {
    for (const a of events[0]!.event.articulations ?? [])
      if (events.every((l) => l.event.articulations?.includes(a))) arts.add(a);
  }
  const written = all((e) => {
    const w = writtenFromLength(e.duration);
    return w ? `${w.value}:${w.dots}` : null;
  });
  let alter: number | null = null;
  let graces = false;
  let graceValue: NoteValue | null = null;
  if (selection.kind === 'notes') {
    const notes = selection.noteIds.map((id) => findNote(doc, id)).filter((n) => !!n);
    alter = common(notes.map((n) => n!.note.pitch.alter));
    graces = notes.length > 0 && notes.every((n) => !!n!.grace);
    if (graces) graceValue = common(notes.map((n) => n!.grace!.value));
  }
  return {
    events: events.length,
    articulations: arts,
    ornament: all((e) => e.ornament ?? null),
    tremolo: all((e) => e.tremolo ?? 0) ?? 0,
    arpeggio: all((e) => e.arpeggio ?? null),
    breath: all((e) => e.breath ?? null),
    cue: events.length > 0 && events.every((l) => !!l.event.cue),
    stem: all((e) => e.stem ?? null),
    // grace notes show their own value, not the value of the note they lead to
    written: graces
      ? graceValue
        ? { value: graceValue, dots: 0 }
        : null
      : written
        ? { value: written.split(':')[0] as NoteValue, dots: Number(written.split(':')[1]) }
        : null,
    alter,
    graces,
  };
}

function selectedEventsFor(doc: ScoreDoc, selection: Selection, lastEntered: string | null) {
  if (selection.kind === 'notes' || selection.kind === 'range') {
    const out = new Map<string, LocatedEvent>();
    if (selection.kind === 'notes') {
      for (const id of selection.noteIds) {
        const loc = findNote(doc, id)?.loc;
        if (loc) out.set(loc.event.id, loc);
      }
    } else {
      const infos = measureInfos(doc);
      const from = infos[selection.measureFrom]?.start;
      const last = infos[selection.measureTo];
      if (from && last) {
        const to = add(last.start, last.length);
        for (const staff of allStaves(doc).slice(selection.staffFrom, selection.staffTo + 1))
          for (let v = 0; v < 4; v++)
            for (const loc of eventsOverlapping(doc, staff.staff.id, v, from, to))
              if (!lt(loc.start, from)) out.set(loc.event.id, loc);
      }
    }
    if (out.size) return [...out.values()];
  }
  const loc = lastEntered ? findEvent(doc, lastEntered) : null;
  return loc ? [loc] : [];
}
