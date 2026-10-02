import type { Draft } from 'immer';
import { barLength } from '../time/meter';
import { type Rational, add, cmp, floorDiv, lt, mulInt, rat, sub, ZERO } from '../time/rational';
import {
  allStaves,
  hasMeasure,
  hasStaff,
  measureIndexOf,
  measureInfo,
  measureInfos,
  scoreLength,
} from '../model/query';
import type {
  ChordSymbol,
  ClefChange,
  DynamicMark,
  ID,
  Measure,
  NoteEvent,
  ScoreDoc,
  Spanner,
  StaffMeasure,
  TempoMark,
  TupletSpan,
} from '../model/types';
import { type DraftDoc, draftStaffMeasure, pruneEmpty } from './draft';
import { spannersAfterMeasureDelete, spannersAfterRebar } from './spanners';
import { type Command, CommandError } from './types';

type Cmd<T extends Command['type']> = Extract<Command, { type: T }>;

function fail(cmd: Command, message: string): never {
  throw new CommandError(cmd, message);
}

function draftMeasure(
  draft: DraftDoc,
  base: ScoreDoc,
  cmd: Command,
  measureId: ID,
): Draft<Measure> {
  if (!hasMeasure(base, measureId)) fail(cmd, `unknown measure ${measureId}`);
  return draft.measures[measureIndexOf(base, measureId)]!;
}

// ------------------------------------------------------------------------------- insert / delete

/** Truncate every event that sounds across absolute time `t` so it ends at `t`. */
function truncateAcross(draft: DraftDoc, base: ScoreDoc, t: Rational): void {
  for (const m of measureInfos(base)) {
    if (cmp(m.start, t) >= 0) break;
    for (const staff of allStaves(base)) {
      const sm = base.content[staff.staff.id]?.[m.measure.id];
      if (!sm) continue;
      sm.voices.forEach((events, voice) => {
        events.forEach((e, i) => {
          const start = add(m.start, e.offset);
          if (lt(start, t) && lt(t, add(start, e.duration))) {
            const d = draft.content[staff.staff.id]![m.measure.id]!.voices[voice]![i]!;
            d.duration = sub(t, start);
            for (const n of d.notes) delete n.tieForward;
          }
        });
      });
    }
  }
}

export function measuresInsert(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'measures.insert'>): void {
  const { index, ids } = cmd;
  if (!Number.isInteger(index) || index < 0 || index > base.measures.length)
    fail(cmd, 'index out of range');
  if (ids.length === 0) return;
  for (const id of ids) if (hasMeasure(base, id)) fail(cmd, `measure id ${id} already exists`);
  const infos = measureInfos(base);
  if (index < base.measures.length) truncateAcross(draft, base, infos[index]!.start);
  const fresh: Measure[] = ids.map((id) => ({ id }));
  if (index === 0 && base.measures.length > 0) {
    // The score's initial signatures and tempo stay at the very beginning.
    const first = base.measures[0]!;
    const moved: Measure = {
      id: fresh[0]!.id,
      ...(first.timeSig ? { timeSig: first.timeSig } : {}),
      ...(first.keySig ? { keySig: first.keySig } : {}),
      ...(first.tempo ? { tempo: first.tempo } : {}),
    };
    fresh[0] = moved;
    const old = draft.measures[0]!;
    delete old.tempo;
    // Keep the old first bar's signatures explicit only if they would otherwise change.
    if (ids.length > 0) {
      delete old.timeSig;
      delete old.keySig;
    }
  }
  if (index === base.measures.length && base.measures.length > 0) {
    // Appending: the final barline moves to the new last measure.
    const last = draft.measures[base.measures.length - 1]!;
    if (last.barline === 'final') {
      delete last.barline;
      fresh[fresh.length - 1] = { ...fresh[fresh.length - 1]!, barline: 'final' };
    }
  }
  draft.measures.splice(index, 0, ...(fresh as Draft<Measure>[]));
}

export function measuresDelete(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'measures.delete'>): void {
  const doomed = new Set(cmd.measureIds);
  for (const id of doomed) if (!hasMeasure(base, id)) fail(cmd, `unknown measure ${id}`);
  if (doomed.size >= base.measures.length) fail(cmd, 'a score needs at least one measure');
  const infos = measureInfos(base);
  // Events sounding into a deleted measure from before it are cut at its start.
  for (const info of infos)
    if (doomed.has(info.measure.id)) truncateAcross(draft, base, info.start);

  // Carry signature changes from deleted measures to the next surviving one.
  let pendingTime = undefined as Measure['timeSig'];
  let pendingKey = undefined as Measure['keySig'];
  let pendingTempo = undefined as Measure['tempo'];
  let pendingFinal = false;
  const kept: Draft<Measure>[] = [];
  infos.forEach((info, i) => {
    const m = info.measure;
    if (doomed.has(m.id)) {
      if (m.timeSig) pendingTime = m.timeSig;
      if (m.keySig) pendingKey = m.keySig;
      if (m.tempo && m.tempo.length)
        pendingTempo = [
          ...(pendingTempo ?? []),
          ...m.tempo.map((t) => ({ ...t, offset: ZERO })),
        ].slice(-1);
      if (m.barline === 'final') pendingFinal = true;
      return;
    }
    const d = draft.measures[i]!;
    if (pendingTime && !d.timeSig)
      d.timeSig = pendingTime as Draft<NonNullable<Measure['timeSig']>>;
    if (pendingKey && !d.keySig) d.keySig = pendingKey;
    if (pendingTempo && !(d.tempo && d.tempo.length)) d.tempo = pendingTempo as Draft<TempoMark>[];
    pendingTime = undefined;
    pendingKey = undefined;
    pendingTempo = undefined;
    kept.push(d);
  });
  if (pendingFinal) kept[kept.length - 1]!.barline = 'final';
  draft.measures = kept;
  for (const staffId of Object.keys(draft.content)) {
    for (const id of doomed) delete draft.content[staffId]![id];
  }
  draft.harmony = draft.harmony.filter((c) => !doomed.has(c.measureId));
  if (base.spanners.length)
    draft.spanners = spannersAfterMeasureDelete(base, doomed) as Draft<Spanner>[];
}

// ------------------------------------------------------------------------------- signatures

interface Anchored<T> {
  readonly t: Rational;
  readonly item: T;
}

/**
 * Change the time signature from a measure up to the next explicit time signature, re-barring
 * the content (like Sibelius' "rewrite bars"): every event keeps its absolute position and
 * duration; only the barlines move.
 */
export function measureSetTimeSig(
  draft: DraftDoc,
  base: ScoreDoc,
  cmd: Cmd<'measure.setTimeSig'>,
): void {
  if (!hasMeasure(base, cmd.measureId)) fail(cmd, `unknown measure ${cmd.measureId}`);
  const { beats, beatType } = cmd.timeSig;
  if (!Number.isInteger(beats) || beats < 1 || ![1, 2, 4, 8, 16, 32, 64].includes(beatType))
    fail(cmd, 'invalid time signature');
  const infos = measureInfos(base);
  const i0 = measureIndexOf(base, cmd.measureId);
  let i1 = i0 + 1;
  while (i1 < infos.length && !infos[i1]!.measure.timeSig) i1++;
  const regionStart = infos[i0]!.start;
  const regionEnd = i1 < infos.length ? infos[i1]!.start : scoreLength(base);
  const L = barLength(cmd.timeSig);
  const span = sub(regionEnd, regionStart);
  const k = Math.max(1, Math.ceil((span.n * L.d) / (span.d * L.n)));
  const oldIds = infos.slice(i0, i1).map((m) => m.measure.id);
  const newIds = [...oldIds.slice(0, k)];
  for (let j = newIds.length, x = 0; j < k; j++, x++) {
    const id = cmd.newMeasureIds[x];
    if (!id) fail(cmd, `needs ${k - oldIds.length} new measure ids`);
    if (hasMeasure(base, id)) fail(cmd, `measure id ${id} already exists`);
    newIds.push(id);
  }

  // Collect everything anchored inside the region with absolute times.
  const events = new Map<ID, { voice: number; items: Anchored<NoteEvent>[] }[]>();
  const tuplets = new Map<ID, Anchored<TupletSpan>[]>();
  const clefs = new Map<ID, Anchored<ClefChange>[]>();
  const dynamics = new Map<ID, Anchored<DynamicMark>[]>();
  const tempos: Anchored<TempoMark>[] = [];
  const keys: Anchored<NonNullable<Measure['keySig']>>[] = [];
  const harmony: Anchored<ChordSymbol>[] = [];
  const attrs = new Map<ID, Measure>();
  for (let i = i0; i < i1; i++) {
    const info = infos[i]!;
    const m = info.measure;
    attrs.set(m.id, m);
    for (const t of m.tempo ?? []) tempos.push({ t: add(info.start, t.offset), item: t });
    if (m.keySig && i > i0) keys.push({ t: info.start, item: m.keySig });
    for (const staff of allStaves(base)) {
      const sid = staff.staff.id;
      const sm: StaffMeasure | undefined = base.content[sid]?.[m.id];
      if (!sm) continue;
      sm.voices.forEach((list, voice) => {
        const perStaff = events.get(sid) ?? [];
        events.set(sid, perStaff);
        let slot = perStaff.find((s) => s.voice === voice);
        if (!slot) perStaff.push((slot = { voice, items: [] }));
        for (const e of list) slot.items.push({ t: add(info.start, e.offset), item: e });
      });
      for (const t of sm.tuplets ?? [])
        (tuplets.get(sid) ?? tuplets.set(sid, []).get(sid)!).push({
          t: add(info.start, t.offset),
          item: t,
        });
      for (const c of sm.clefChanges ?? [])
        (clefs.get(sid) ?? clefs.set(sid, []).get(sid)!).push({
          t: add(info.start, c.offset),
          item: c,
        });
      for (const d of sm.dynamics ?? [])
        (dynamics.get(sid) ?? dynamics.set(sid, []).get(sid)!).push({
          t: add(info.start, d.offset),
          item: d,
        });
    }
  }
  for (const c of base.harmony) {
    if (oldIds.includes(c.measureId))
      harmony.push({ t: add(measureInfo(base, c.measureId).start, c.offset), item: c });
  }

  const place = (t: Rational) => {
    const rel = sub(t, regionStart);
    const idx = Math.min(k - 1, floorDiv(rel, L));
    return { id: newIds[idx]!, offset: sub(rel, mulInt(L, idx)) };
  };

  // Rebuild the measures of the region.
  const lastOld = attrs.get(oldIds[oldIds.length - 1]!)!;
  const rebuilt: Measure[] = newIds.map((id, j) => {
    const old = attrs.get(id);
    const m: { -readonly [K in keyof Measure]: Measure[K] } = { id };
    if (j === 0) m.timeSig = cmd.timeSig;
    if (j === 0 && infos[i0]!.measure.keySig) m.keySig = infos[i0]!.measure.keySig;
    if (old?.repeatStart) m.repeatStart = true;
    if (old?.rehearsalMark) m.rehearsalMark = old.rehearsalMark;
    if (old?.breakAfter) m.breakAfter = old.breakAfter;
    if (j < k - 1 && old?.barline && old.barline !== 'final') m.barline = old.barline;
    if (j === k - 1) {
      if (lastOld.barline) m.barline = lastOld.barline;
      if (lastOld.repeatEnd) m.repeatEnd = true;
    }
    return m;
  });
  for (const key of keys) {
    const p = place(key.t);
    const j = newIds.indexOf(p.id);
    if (j > 0) rebuilt[j] = { ...rebuilt[j]!, keySig: key.item };
  }
  for (const tempo of tempos) {
    const p = place(tempo.t);
    const j = newIds.indexOf(p.id);
    rebuilt[j] = {
      ...rebuilt[j]!,
      tempo: [...(rebuilt[j]!.tempo ?? []), { ...tempo.item, offset: p.offset }],
    };
  }
  draft.measures.splice(i0, i1 - i0, ...(rebuilt as Draft<Measure>[]));

  // Re-anchor content.
  for (const staff of allStaves(base)) {
    const sid = staff.staff.id;
    const target = draft.content[sid];
    if (!target) continue;
    for (const id of oldIds) delete target[id];
    for (const slot of events.get(sid) ?? []) {
      for (const { t, item } of slot.items) {
        const p = place(t);
        const sm = draftStaffMeasure(draft, sid, p.id);
        while (sm.voices.length <= slot.voice) sm.voices.push([]);
        sm.voices[slot.voice]!.push({ ...item, offset: p.offset } as Draft<NoteEvent>);
      }
    }
    for (const { t, item } of tuplets.get(sid) ?? []) {
      const p = place(t);
      const room = sub(L, p.offset);
      if (cmp(item.length, room) > 0) continue; // would cross a new barline: dissolve
      const sm = draftStaffMeasure(draft, sid, p.id);
      sm.tuplets = [...(sm.tuplets ?? []), { ...item, offset: p.offset } as Draft<TupletSpan>];
    }
    for (const { t, item } of clefs.get(sid) ?? []) {
      const p = place(t);
      const sm = draftStaffMeasure(draft, sid, p.id);
      sm.clefChanges = [
        ...(sm.clefChanges ?? []),
        { ...item, offset: p.offset } as Draft<ClefChange>,
      ];
    }
    for (const { t, item } of dynamics.get(sid) ?? []) {
      const p = place(t);
      const sm = draftStaffMeasure(draft, sid, p.id);
      sm.dynamics = [...(sm.dynamics ?? []), { ...item, offset: p.offset } as Draft<DynamicMark>];
    }
    for (const id of newIds) {
      const sm = target[id];
      if (!sm) continue;
      for (const list of sm.voices) list.sort((a, b) => cmp(a.offset, b.offset));
      pruneEmpty(draft, sid, id);
    }
  }
  draft.harmony = draft.harmony.filter((c) => !oldIds.includes(c.measureId));
  for (const { t, item } of harmony) {
    const p = place(t);
    draft.harmony.push({ ...item, measureId: p.id, offset: p.offset } as Draft<ChordSymbol>);
  }
  if (base.spanners.length) {
    const before = i0 > 0 ? infos[i0 - 1]! : null;
    draft.spanners = spannersAfterRebar(
      base,
      new Set(oldIds),
      newIds.map((id, j) => ({ id, start: add(regionStart, mulInt(L, j)), length: L })),
      before ? { id: before.measure.id, start: before.start, length: before.length } : null,
    ) as Draft<Spanner>[];
  }
}

export function measureSetKeySig(
  draft: DraftDoc,
  base: ScoreDoc,
  cmd: Cmd<'measure.setKeySig'>,
): void {
  const m = draftMeasure(draft, base, cmd, cmd.measureId);
  if (!Number.isInteger(cmd.keySig.fifths) || Math.abs(cmd.keySig.fifths) > 7)
    fail(cmd, 'fifths must be -7..7');
  m.keySig = cmd.keySig;
}

export function measureSetBarline(
  draft: DraftDoc,
  base: ScoreDoc,
  cmd: Cmd<'measure.setBarline'>,
): void {
  const m = draftMeasure(draft, base, cmd, cmd.measureId);
  if (cmd.barline === 'single') delete m.barline;
  else m.barline = cmd.barline;
}

export function measureSetRepeat(
  draft: DraftDoc,
  base: ScoreDoc,
  cmd: Cmd<'measure.setRepeat'>,
): void {
  const m = draftMeasure(draft, base, cmd, cmd.measureId);
  if (cmd.start !== undefined) {
    if (cmd.start) m.repeatStart = true;
    else delete m.repeatStart;
  }
  if (cmd.end !== undefined) {
    if (cmd.end) m.repeatEnd = true;
    else delete m.repeatEnd;
  }
}

export function measureSetTempo(
  draft: DraftDoc,
  base: ScoreDoc,
  cmd: Cmd<'measure.setTempo'>,
): void {
  const m = draftMeasure(draft, base, cmd, cmd.measureId);
  if (!cmd.tempo) {
    delete m.tempo;
    return;
  }
  if (!(cmd.tempo.bpm > 0 && cmd.tempo.bpm < 1000)) fail(cmd, 'bpm out of range');
  const others = (m.tempo ?? []).filter(
    (t) => t.id !== cmd.tempo!.id && cmp(t.offset, cmd.tempo!.offset) !== 0,
  );
  m.tempo = [...others, cmd.tempo as Draft<TempoMark>].sort((a, b) => cmp(a.offset, b.offset));
}

export function measureSetBreak(
  draft: DraftDoc,
  base: ScoreDoc,
  cmd: Cmd<'measure.setBreak'>,
): void {
  const m = draftMeasure(draft, base, cmd, cmd.measureId);
  if (cmd.breakAfter) m.breakAfter = cmd.breakAfter;
  else delete m.breakAfter;
}

export function measureSetRehearsalMark(
  draft: DraftDoc,
  base: ScoreDoc,
  cmd: Cmd<'measure.setRehearsalMark'>,
): void {
  const m = draftMeasure(draft, base, cmd, cmd.measureId);
  if (cmd.text) m.rehearsalMark = cmd.text;
  else delete m.rehearsalMark;
}

// ------------------------------------------------------------------------------- staff items

export function clefSet(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'clef.set'>): void {
  if (!hasStaff(base, cmd.staffId)) fail(cmd, `unknown staff ${cmd.staffId}`);
  const index = measureIndexOf(base, cmd.measureId);
  if (index === 0 && cmd.offset.n === 0) {
    for (const part of draft.parts) {
      const staff = part.staves.find((s) => s.id === cmd.staffId);
      if (staff) staff.clef = cmd.clef;
    }
    return;
  }
  const sm = draftStaffMeasure(draft, cmd.staffId, cmd.measureId);
  const others = (sm.clefChanges ?? []).filter((c) => cmp(c.offset, cmd.offset) !== 0);
  sm.clefChanges = [...others, { id: cmd.id, offset: cmd.offset, clef: cmd.clef }].sort((a, b) =>
    cmp(a.offset, b.offset),
  );
}

export function dynamicSet(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'dynamic.set'>): void {
  if (!hasStaff(base, cmd.staffId)) fail(cmd, `unknown staff ${cmd.staffId}`);
  if (!hasMeasure(base, cmd.measureId)) fail(cmd, `unknown measure ${cmd.measureId}`);
  const sm = draftStaffMeasure(draft, cmd.staffId, cmd.measureId);
  const others = (sm.dynamics ?? []).filter(
    (d) => d.id !== cmd.mark.id && cmp(d.offset, cmd.mark.offset) !== 0,
  );
  sm.dynamics = [...others, cmd.mark as Draft<DynamicMark>].sort((a, b) => cmp(a.offset, b.offset));
}

export function dynamicDelete(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'dynamic.delete'>): void {
  const ids = new Set(cmd.ids);
  for (const [staffId, measures] of Object.entries(base.content)) {
    for (const [measureId, sm] of Object.entries(measures)) {
      if (!sm.dynamics?.some((d) => ids.has(d.id))) continue;
      const d = draft.content[staffId]![measureId]!;
      d.dynamics = d.dynamics!.filter((x) => !ids.has(x.id));
      if (d.dynamics.length === 0) delete d.dynamics;
      pruneEmpty(draft, staffId, measureId);
    }
  }
}

// ------------------------------------------------------------------------------- harmony

export function harmonySet(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'harmony.set'>): void {
  const c = cmd.chord;
  if (!hasMeasure(base, c.measureId)) fail(cmd, `unknown measure ${c.measureId}`);
  const len = measureInfo(base, c.measureId).length;
  if (lt(c.offset, rat(0)) || !lt(c.offset, len)) fail(cmd, 'offset outside the measure');
  const rest = draft.harmony.filter(
    (h) => h.id !== c.id && !(h.measureId === c.measureId && cmp(h.offset, c.offset) === 0),
  );
  rest.push(c as Draft<ChordSymbol>);
  const order = new Map(base.measures.map((m, i) => [m.id, i]));
  rest.sort((a, b) => order.get(a.measureId)! - order.get(b.measureId)! || cmp(a.offset, b.offset));
  draft.harmony = rest;
}

export function harmonyDelete(draft: DraftDoc, _base: ScoreDoc, cmd: Cmd<'harmony.delete'>): void {
  const ids = new Set(cmd.ids);
  draft.harmony = draft.harmony.filter((h) => !ids.has(h.id));
}

// ------------------------------------------------------------------------------- parts

export function partAdd(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'part.add'>): void {
  if (cmd.index < 0 || cmd.index > base.parts.length) fail(cmd, 'index out of range');
  if (base.parts.some((p) => p.id === cmd.part.id))
    fail(cmd, `part id ${cmd.part.id} already exists`);
  for (const s of cmd.part.staves)
    if (hasStaff(base, s.id)) fail(cmd, `staff id ${s.id} already exists`);
  draft.parts.splice(cmd.index, 0, cmd.part as Draft<typeof cmd.part>);
  for (const s of cmd.part.staves) draft.content[s.id] = {};
  if (cmd.part.staves.length > 1 && cmd.braceId) {
    draft.groups.push({
      id: cmd.braceId,
      kind: 'brace',
      firstStaff: cmd.part.staves[0]!.id,
      lastStaff: cmd.part.staves[cmd.part.staves.length - 1]!.id,
      barlineThrough: true,
    });
  }
}

export function partRemove(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'part.remove'>): void {
  const index = base.parts.findIndex((p) => p.id === cmd.partId);
  if (index < 0) fail(cmd, `unknown part ${cmd.partId}`);
  if (base.parts.length === 1) fail(cmd, 'a score needs at least one part');
  const removed = new Set(base.parts[index]!.staves.map((s) => s.id));
  const order = allStaves(base).map((s) => s.staff.id);
  draft.parts.splice(index, 1);
  for (const id of removed) delete draft.content[id];
  draft.spanners = draft.spanners.filter((s) => !removed.has(s.staffId));
  // Shrink or drop groups that referenced removed staves.
  draft.groups = draft.groups.flatMap((g) => {
    const a = order.indexOf(g.firstStaff);
    const b = order.indexOf(g.lastStaff);
    const inside = order.slice(a, b + 1).filter((id) => !removed.has(id));
    if (inside.length === 0) return [];
    if (g.kind === 'brace' && inside.length < 2) return [];
    if (g.kind === 'bracket' && inside.length < 2) return [];
    return [{ ...g, firstStaff: inside[0]!, lastStaff: inside[inside.length - 1]! }];
  });
}

export function partRename(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'part.rename'>): void {
  const i = base.parts.findIndex((p) => p.id === cmd.partId);
  if (i < 0) fail(cmd, `unknown part ${cmd.partId}`);
  draft.parts[i]!.name = cmd.name;
  draft.parts[i]!.abbreviation = cmd.abbreviation;
}
