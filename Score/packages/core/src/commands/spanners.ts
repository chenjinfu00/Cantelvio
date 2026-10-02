/** Commands for slurs and lines, and their upkeep when bars are deleted or re-barred. */
import type { Draft } from 'immer';
import { measureInfos } from '../model/query';
import {
  compareSpanners,
  normalizeEndAnchor,
  overlappingOttavas,
  spannerProblem,
  spannerTimes,
} from '../model/spanners';
import type { ID, MeasureAnchor, ScoreDoc, Spanner } from '../model/types';
import { type Rational, add, le, lt, sub, ZERO } from '../time/rational';
import type { DraftDoc } from './draft';
import { type Command, CommandError } from './types';

type Cmd<T extends Command['type']> = Extract<Command, { type: T }>;

function fail(cmd: Command, message: string): never {
  throw new CommandError(cmd, message);
}

/** Canonical form: an end anchor at a barline belongs to the bar before it. */
function normalized(doc: ScoreDoc, s: Spanner): Spanner {
  if (s.kind === 'slur') return s;
  return { ...s, end: normalizeEndAnchor(doc, s.end) };
}

function check(cmd: Command, doc: ScoreDoc, s: Spanner): void {
  if (!s.id) fail(cmd, 'spanner needs an id');
  const problem = spannerProblem(doc, s);
  if (problem) fail(cmd, problem);
  if (overlappingOttavas(doc, s).length) fail(cmd, 'overlaps another octave line on this staff');
}

function store(draft: DraftDoc, base: ScoreDoc, list: Spanner[]): void {
  draft.spanners = [...list].sort(compareSpanners(base)) as Draft<Spanner>[];
}

export function spannerAdd(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'spanner.add'>): void {
  if (base.spanners.some((s) => s.id === cmd.spanner.id))
    fail(cmd, `spanner id ${cmd.spanner.id} already exists`);
  const s = normalized(base, cmd.spanner);
  check(cmd, base, s);
  store(draft, base, [...base.spanners, s]);
}

export function spannerSet(draft: DraftDoc, base: ScoreDoc, cmd: Cmd<'spanner.set'>): void {
  const i = base.spanners.findIndex((s) => s.id === cmd.spanner.id);
  if (i < 0) fail(cmd, `unknown spanner ${cmd.spanner.id}`);
  const s = normalized(base, cmd.spanner);
  check(cmd, base, s);
  const list = [...base.spanners];
  list[i] = s;
  store(draft, base, list);
}

export function spannersDelete(
  draft: DraftDoc,
  _base: ScoreDoc,
  cmd: Cmd<'spanners.delete'>,
): void {
  const ids = new Set(cmd.ids);
  draft.spanners = draft.spanners.filter((s) => !ids.has(s.id));
}

// ------------------------------------------------------------------------------- upkeep

export interface Bar {
  readonly id: ID;
  readonly start: Rational;
  readonly length: Rational;
}

/** Anchors of absolute times in a list of bars (start: containing bar; end: bar before t). */
function anchorIn(bars: readonly Bar[], t: Rational, asEnd: boolean): MeasureAnchor | null {
  for (const b of bars) {
    const e = add(b.start, b.length);
    const inside = asEnd ? lt(b.start, t) && le(t, e) : le(b.start, t) && lt(t, e);
    if (inside) return { measureId: b.id, offset: sub(t, b.start) };
  }
  return null;
}

/**
 * Time spanners after deleting bars: times inside deleted bars move to where the bars were, later
 * times move earlier; lines left without length disappear. Slurs are left to the dangling check.
 */
export function spannersAfterMeasureDelete(base: ScoreDoc, doomed: ReadonlySet<ID>): Spanner[] {
  const infos = measureInfos(base);
  const kept: Bar[] = [];
  let cursor = ZERO;
  for (const info of infos) {
    if (doomed.has(info.measure.id)) continue;
    kept.push({ id: info.measure.id, start: cursor, length: info.length });
    cursor = add(cursor, info.length);
  }
  const mapTime = (t: Rational): Rational => {
    let removed = ZERO;
    for (const info of infos) {
      if (!doomed.has(info.measure.id)) continue;
      const end = add(info.start, info.length);
      if (le(end, t)) removed = add(removed, info.length);
      else if (lt(info.start, t)) return sub(info.start, removed);
    }
    return sub(t, removed);
  };
  const out: Spanner[] = [];
  for (const s of base.spanners) {
    if (s.kind === 'slur') {
      out.push(s);
      continue;
    }
    const t = spannerTimes(base, s);
    if (!t) continue;
    const start = mapTime(t.start);
    const end = mapTime(t.end);
    if (!lt(start, end)) continue;
    const a = anchorIn(kept, start, false);
    const b = anchorIn(kept, end, true);
    if (a && b) out.push({ ...s, start: a, end: b });
  }
  return out;
}

/**
 * Time spanners after re-barring a region (time signature change): anchors inside the region are
 * placed by absolute time into the new bars.
 */
export function spannersAfterRebar(
  base: ScoreDoc,
  oldIds: ReadonlySet<ID>,
  newBars: readonly Bar[],
  barBefore: Bar | null,
): Spanner[] {
  const timeOf = (a: MeasureAnchor): Rational | null => {
    const info = measureInfos(base).find((m) => m.measure.id === a.measureId);
    return info ? add(info.start, a.offset) : null;
  };
  const bars = barBefore ? [barBefore, ...newBars] : newBars;
  return base.spanners.map((s) => {
    if (s.kind === 'slur') return s;
    let start = s.start;
    let end = s.end;
    if (oldIds.has(s.start.measureId)) {
      const t = timeOf(s.start);
      const a = t && anchorIn(newBars, t, false);
      if (a) start = a;
    }
    if (oldIds.has(s.end.measureId)) {
      const t = timeOf(s.end);
      const b = t && anchorIn(bars, t, true);
      if (b) end = b;
    }
    return start === s.start && end === s.end ? s : { ...s, start, end };
  });
}

/** Spanners that no longer fit the document (deleted notes, bars or staves). */
export function danglingSpanners(doc: ScoreDoc): ID[] {
  if (!doc.spanners.length) return [];
  return doc.spanners.filter((s) => spannerProblem(doc, s) !== null).map((s) => s.id);
}
