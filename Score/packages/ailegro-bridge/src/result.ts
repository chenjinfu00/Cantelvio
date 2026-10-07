/**
 * Import an ailegro.compose-result/1 into a score as commands (one undoable step).
 * Generated music is marked with AI provenance (drawn as suggestions until accepted).
 */
import {
  type Command,
  type DynamicValue,
  type IdGenerator,
  type KeySignature,
  type NoteEvent,
  type Provenance,
  type Rational,
  type ScoreDoc,
  type StaffInfo,
  add,
  allStaves,
  cmp,
  divInt,
  eq,
  getInstrument,
  isDyadic,
  le,
  lt,
  measureInfos,
  parseRational,
  rat,
  sub,
  barLength,
  toNumber,
} from '@cantelvio-score/core';
import { keyFromTonic, spellNote, spellRoot } from './spelling';
import { qualityOf } from './qualities';
import {
  planPerformance,
  type PerformanceNote,
  type PerformanceOptions,
  type PerformanceReport,
} from './performance';
import {
  AILEGRO_GROUPS,
  type AilegroGroup,
  type ComposeResult,
  RESULT_SCHEMA,
  type TargetMapping,
} from './schemas';

export interface ImportOptions {
  readonly ids: IdGenerator;
  /** Run id stored in provenance; default `result.requestId`. */
  readonly runId?: string;
  /** Group -> parts mapping (from the request); default: parts of the score by instrument group. */
  readonly targets?: readonly TargetMapping[];
  /** 'notation' snaps onsets/durations to a readable grid; 'exact' keeps Cantelvio's values. */
  readonly quantize?: 'notation' | 'exact';
  /** Mark as AI suggestion (default true). */
  readonly suggestion?: boolean;
  /** Clear the target staves in the written bars first (default true). */
  readonly clearTargets?: boolean;
  readonly importChords?: boolean;
  /** Optional local instrument-aware realization; absent preserves the raw exchange. */
  readonly performance?: PerformanceOptions;
}

export interface ImportPlan {
  readonly performance?: PerformanceReport;
  readonly commands: Command[];
  readonly warnings: string[];
  readonly runId: string;
  readonly stats: {
    readonly notes: number;
    readonly events: number;
    readonly chords: number;
    readonly skipped: number;
  };
}

const DYNAMIC_VALUES = new Set<string>([
  'pppp',
  'ppp',
  'pp',
  'p',
  'mp',
  'mf',
  'f',
  'ff',
  'fff',
  'ffff',
  'sf',
  'sfz',
  'sffz',
  'fz',
  'fp',
  'sfp',
  'rf',
  'rfz',
]);

/** Snap a quarter-note time to a notation grid: 1/12 quarter when it is triplet-based, else 1/8. */
function snapQuarter(value: Rational): Rational {
  if (isDyadic(value) && value.d <= 8) return value;
  const tri = Math.round(toNumber(value) * 12);
  if (Math.abs(toNumber(value) - tri / 12) < 1 / 96) return rat(tri, 12);
  return rat(Math.round(toNumber(value) * 8), 8);
}

type Placed = PerformanceNote;

export function planComposeImport(
  doc: ScoreDoc,
  result: ComposeResult,
  options: ImportOptions,
): ImportPlan {
  if (result.schema !== RESULT_SCHEMA) throw new Error(`expected ${RESULT_SCHEMA}`);
  const ids = options.ids;
  const runId = options.runId ?? result.requestId;
  const warnings: string[] = [...(result.warnings ?? [])];
  const commands: Command[] = [];
  const quantize = options.quantize ?? 'notation';
  const provenance: Provenance = {
    kind: 'ai',
    model: result.model.name,
    runId,
    accepted: options.suggestion === false,
  };

  // ---- measures: append if the result runs past the end of the score
  const infos = measureInfos(doc);
  const measureIds = infos.map((m) => m.measure.id);
  const lengths = infos.map((m) => m.length);
  const starts = infos.map((m) => m.start);
  const needed = result.startBar + result.bars.length - infos.length;
  if (needed > 0) {
    const fresh = Array.from({ length: needed }, () => ids.next('m'));
    commands.push({ type: 'measures.insert', index: infos.length, ids: fresh });
    const lastLen = barLength(infos[infos.length - 1]!.timeSig);
    for (const id of fresh) {
      const prevEnd = add(starts[starts.length - 1]!, lengths[lengths.length - 1]!);
      measureIds.push(id);
      starts.push(prevEnd);
      lengths.push(lastLen);
    }
  }

  // ---- target staves per group
  const staves = allStaves(doc);
  const groupParts = new Map<AilegroGroup, string[]>();
  if (options.targets) for (const t of options.targets) groupParts.set(t.group, [...t.parts]);
  else {
    for (const g of AILEGRO_GROUPS) {
      groupParts.set(
        g,
        doc.parts.filter((p) => getInstrument(p.instrument).ailegroGroup === g).map((p) => p.id),
      );
    }
  }
  // voice slots of each group, ordered by median pitch (highest first)
  const slotPitches = new Map<string, number[]>();
  for (const b of result.bars) {
    for (const n of b.notes) {
      if (!n.group) continue;
      const key = `${n.group}:${n.voice}`;
      const list = slotPitches.get(key) ?? [];
      list.push(n.pitch ?? 60);
      slotPitches.set(key, list);
    }
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 60;
  // Slots of a group go round-robin to its parts, highest slot first.
  const slotTarget = new Map<string, { partId: string; rank: number }>();
  for (const g of AILEGRO_GROUPS) {
    const parts = groupParts.get(g) ?? [];
    const slots = [...slotPitches.keys()]
      .filter((k) => k.startsWith(`${g}:`))
      .sort((a, b) => median(slotPitches.get(b)!) - median(slotPitches.get(a)!));
    slots.forEach((slot, i) => {
      if (!parts.length) return;
      slotTarget.set(slot, { partId: parts[i % parts.length]!, rank: i });
    });
  }
  const staffFor = (partId: string, midi: number | null): StaffInfo => {
    const ss = staves.filter((s) => s.part.id === partId);
    if (ss.length === 1 || midi === null) return ss[0]!;
    // keyboard-style parts: split at middle C
    return midi >= 60 ? ss[0]! : ss[ss.length - 1]!;
  };

  // ---- place notes
  let skipped = 0;
  let placed: Placed[] = [];
  const chordsByBar: { bar: number; onset: Rational; root: number; quality: string }[] = [];
  const touchedBars = new Set<number>();
  result.bars.forEach((b, k) => {
    const bar = result.startBar + k;
    touchedBars.add(bar);
    const mStart = starts[bar]!;
    const mLen = lengths[bar]!;
    const len = divInt(parseRational(b.length), 4);
    if (!eq(len, mLen))
      warnings.push(
        `bar ${bar + 1}: generated length ${b.length} quarters differs from the score's measure`,
      );
    for (const c of b.chords) {
      const quality = typeof c.quality === 'number' ? qualityOf(c.quality).id : c.quality;
      chordsByBar.push({ bar, onset: divInt(parseRational(c.onset), 4), root: c.root, quality });
    }
    for (const n of b.notes) {
      const target = n.group ? slotTarget.get(`${n.group}:${n.voice}`) : undefined;
      if (!target) {
        skipped++;
        continue;
      }
      let onQ = parseRational(n.onset);
      let durQ = parseRational(n.duration);
      if (quantize === 'notation') {
        const endQ = snapQuarter(add(onQ, durQ));
        onQ = snapQuarter(onQ);
        durQ = sub(endQ, onQ);
        if (durQ.n <= 0) durQ = rat(1, 8);
      }
      const start = add(mStart, divInt(onQ, 4));
      let end = add(start, divInt(durQ, 4));
      const scoreEnd = add(starts[starts.length - 1]!, lengths[lengths.length - 1]!);
      if (cmp(end, scoreEnd) > 0) end = scoreEnd;
      if (!lt(start, end) || !lt(start, add(mStart, mLen))) {
        skipped++;
        continue;
      }
      placed.push({
        staff: staffFor(target.partId, n.pitch),
        voice: 0, // assigned per staff below
        slot: `${n.group}:${n.voice}`,
        start,
        end,
        midi: n.pitch,
        note: n,
        bar,
      });
    }
  });
  if (skipped)
    warnings.push(
      `${skipped} generated note(s) had no target part or fell outside the bars and were skipped`,
    );

  let performance: PerformanceReport | undefined;
  if (options.performance) {
    const plan = planPerformance(doc, result, placed, starts, lengths, options.performance);
    placed = plan.notes;
    performance = plan.report;
  }

  // ---- voices: rank the slots that landed on each staff, highest first (a piano's left-hand
  // slot is voice 1 of its part's slots but voice 1 of the bass staff would be wrong)
  const staffSlots = new Map<string, Map<string, number[]>>();
  for (const p of placed) {
    const slots = staffSlots.get(p.staff.staff.id) ?? new Map<string, number[]>();
    staffSlots.set(p.staff.staff.id, slots);
    const pitches = slots.get(p.slot) ?? [];
    pitches.push(p.midi ?? 60);
    slots.set(p.slot, pitches);
  }
  const voiceOf = new Map<string, number>();
  for (const [staffId, slots] of staffSlots) {
    [...slots.entries()]
      .sort(
        (a, b) =>
          median(b[1]) - median(a[1]) ||
          (slotTarget.get(a[0])?.rank ?? 0) - (slotTarget.get(b[0])?.rank ?? 0),
      )
      .forEach(([slot], i) => voiceOf.set(`${staffId}|${slot}`, Math.min(3, i)));
  }
  placed.forEach((p, i) => {
    placed[i] = { ...p, voice: voiceOf.get(`${p.staff.staff.id}|${p.slot}`) ?? 0 };
  });

  // ---- clear targets (existing bars only; appended bars are empty)
  const sortedBars = [...touchedBars].sort((a, b) => a - b);
  if ((options.clearTargets ?? true) && sortedBars.length) {
    const first = sortedBars[0]!;
    const last = Math.min(sortedBars[sortedBars.length - 1]!, infos.length - 1);
    const targetStaves = new Set<string>();
    for (const parts of groupParts.values())
      for (const id of parts)
        for (const s of staves) if (s.part.id === id) targetStaves.add(s.staff.id);
    if (targetStaves.size && first <= last) {
      commands.push({
        type: 'range.clear',
        staffIds: [...targetStaves],
        from: { measureId: measureIds[first]!, offset: rat(0) },
        to: { measureId: measureIds[last]!, offset: lengths[last]! },
      });
    }
  }

  // ---- spelling context
  const keyAtBar = (bar: number): KeySignature => {
    const k = result.bars[bar - result.startBar]?.key;
    const scoreKey = infos[Math.min(bar, infos.length - 1)]!.keySig;
    return k ? keyFromTonic(k.tonic, k.mode, scoreKey) : scoreKey;
  };
  const chordAt = (bar: number, t: Rational) => {
    let best: (typeof chordsByBar)[number] | undefined;
    for (const c of chordsByBar) {
      const ct = add(starts[c.bar]!, c.onset);
      if (cmp(ct, t) <= 0) best = c;
    }
    return best && best.bar <= bar ? best : undefined;
  };

  // ---- build events per staff/voice, avoiding overlaps by moving to free voices
  const lanes = new Map<string, { start: Rational; end: Rational; notes: Placed[] }[]>();
  placed.sort((a, b) => cmp(a.start, b.start) || (a.midi ?? 0) - (b.midi ?? 0));
  for (const p of placed) {
    let assigned = false;
    for (let v = p.voice; v < 4 && !assigned; v++) {
      const key = `${p.staff.staff.id}:${v}`;
      const lane = lanes.get(key) ?? [];
      const same = lane.find((e) => eq(e.start, p.start) && eq(e.end, p.end));
      if (same) {
        if (!same.notes.some((n) => n.midi === p.midi)) same.notes.push(p);
        assigned = true;
      } else if (!lane.some((e) => lt(e.start, p.end) && lt(p.start, e.end))) {
        lane.push({ start: p.start, end: p.end, notes: [p] });
        lanes.set(key, lane);
        assigned = true;
      }
    }
    if (!assigned) {
      // truncate the overlapping event in the original voice (legato overlap)
      const key = `${p.staff.staff.id}:${p.voice}`;
      const lane = lanes.get(key)!;
      const prev = lane.find((e) => lt(e.start, p.start) && lt(p.start, e.end));
      if (prev) {
        prev.end = p.start;
        lane.push({ start: p.start, end: p.end, notes: [p] });
        warnings.push('overlapping notes in one voice were shortened');
      } else skipped++;
    }
  }

  let noteCount = 0;
  let eventCount = 0;
  const lastDynamic = new Map<string, string>();
  // hairpins: runs of voice-1 notes that carry the same generated wedge
  const hairpins: {
    staffId: string;
    wedge: 'crescendo' | 'diminuendo';
    start: Rational;
    end: Rational;
  }[] = [];
  for (const [key, lane] of lanes) {
    const [staffId, voiceText] = key.split(':') as [string, string];
    const voice = Number(voiceText);
    lane.sort((a, b) => cmp(a.start, b.start));
    const byMeasure = new Map<number, NoteEvent[]>();
    let run: (typeof hairpins)[number] | null = null;
    const flush = () => {
      if (run) hairpins.push(run);
      run = null;
    };
    for (const e of lane) {
      const wedge = e.notes[0]!.note.wedge;
      if (voice === 0 && (wedge === 'crescendo' || wedge === 'diminuendo')) {
        if (run && run.wedge === wedge) run.end = e.end;
        else {
          flush();
          run = { staffId, wedge, start: e.start, end: e.end };
        }
      } else if (voice === 0) flush();
      // locate measure
      let mi = 0;
      while (mi + 1 < starts.length && cmp(starts[mi + 1]!, e.start) <= 0) mi++;
      const offset = sub(e.start, starts[mi]!);
      const key0 = keyAtBar(mi);
      const chord = chordAt(mi, e.start);
      const pitched = e.notes.filter((n) => n.midi !== null);
      const notes = pitched.length
        ? pitched.map((n) => ({
            id: ids.next('n'),
            pitch: spellNote(
              n.midi!,
              key0,
              chord ? { root: chord.root, quality: chord.quality } : undefined,
            ),
            ...(n.note.velocity
              ? { velocity: Math.max(1, Math.min(127, Math.round(n.note.velocity))) }
              : {}),
          }))
        : // unpitched percussion: one note on the staff's middle line
          [{ id: ids.next('n'), pitch: { step: 'C' as const, alter: 0, octave: 5 } }];
      const accent = Math.max(...e.notes.map((n) => n.note.accent));
      const event: NoteEvent = {
        id: ids.next('e'),
        kind: 'note',
        offset,
        duration: sub(e.end, e.start),
        notes,
        ...(accent >= 2
          ? { articulations: ['marcato' as const] }
          : accent === 1
            ? { articulations: ['accent' as const] }
            : {}),
        source: provenance,
      };
      const list = byMeasure.get(mi) ?? [];
      list.push(event);
      byMeasure.set(mi, list);
      noteCount += event.notes.length;
      eventCount++;
      // dynamics: when the generated mark changes
      const dyn = e.notes[0]!.note.dynamic;
      if (dyn && DYNAMIC_VALUES.has(dyn) && lastDynamic.get(staffId) !== dyn && voice === 0) {
        lastDynamic.set(staffId, dyn);
        commands.push({
          type: 'dynamic.set',
          staffId,
          measureId: measureIds[mi]!,
          mark: { id: ids.next('dy'), offset, value: dyn as DynamicValue, source: provenance },
        });
      }
    }
    for (const [mi, events] of byMeasure) {
      for (const span of detectTriplets(events, lengths[mi]!)) {
        commands.push({
          type: 'tuplet.create',
          at: { staffId, voice, measureId: measureIds[mi]!, offset: span.offset },
          length: span.length,
          actual: 3,
          normal: 2,
          id: ids.next('tu'),
        });
      }
      commands.push({ type: 'events.insert', staffId, measureId: measureIds[mi]!, voice, events });
    }
    flush();
  }
  const barAt = (t: Rational, asEnd: boolean): number => {
    let mi = 0;
    while (mi + 1 < starts.length && (asEnd ? lt(starts[mi + 1]!, t) : le(starts[mi + 1]!, t)))
      mi++;
    return mi;
  };
  for (const h of hairpins) {
    const a = barAt(h.start, false);
    const b = barAt(h.end, true);
    commands.push({
      type: 'spanner.add',
      spanner: {
        id: ids.next('sp'),
        kind: 'hairpin',
        staffId: h.staffId,
        direction: h.wedge,
        start: { measureId: measureIds[a]!, offset: sub(h.start, starts[a]!) },
        end: { measureId: measureIds[b]!, offset: sub(h.end, starts[b]!) },
        source: provenance,
      },
    });
  }

  let chordCount = 0;
  if (options.importChords ?? true) {
    for (const c of chordsByBar) {
      const key = keyAtBar(c.bar);
      commands.push({
        type: 'harmony.set',
        chord: {
          id: ids.next('ch'),
          measureId: measureIds[c.bar]!,
          offset: c.onset,
          root: spellRoot(c.root, key),
          quality: c.quality,
          source: provenance,
        },
      });
      chordCount++;
    }
  }
  return {
    commands,
    warnings,
    runId,
    stats: { notes: noteCount, events: eventCount, chords: chordCount, skipped },
    ...(performance ? { performance } : {}),
  };
}

/**
 * Triplet spans for imported events: a quarter (or half) span of the measure becomes a 3:2 tuplet
 * when events inside it use triplet values and none of them crosses its boundaries.
 */
export function detectTriplets(
  events: readonly NoteEvent[],
  measureLength: Rational,
): { offset: Rational; length: Rational }[] {
  const triplet = (r: Rational) => r.d % 3 === 0;
  const spans: { offset: Rational; length: Rational }[] = [];
  const overlaps = (a: Rational, b: Rational) =>
    spans.some((sp) => lt(sp.offset, b) && lt(a, add(sp.offset, sp.length)));
  for (const e of events) {
    if (!triplet(e.offset) && !triplet(e.duration)) continue;
    if (
      spans.some((sp) => cmp(sp.offset, e.offset) <= 0 && lt(e.offset, add(sp.offset, sp.length)))
    )
      continue;
    for (const unit of [rat(1, 4), rat(1, 2)]) {
      const k = Math.floor(toNumber(e.offset) / toNumber(unit) + 1e-9);
      const a = rat(unit.n * k, unit.d);
      const b = add(a, unit);
      if (cmp(b, measureLength) > 0) continue;
      const inside = events.filter((x) => cmp(x.offset, a) >= 0 && lt(x.offset, b));
      const fits = inside.every((x) => cmp(add(x.offset, x.duration), b) <= 0);
      const crossing = events.some((x) => lt(x.offset, a) && lt(a, add(x.offset, x.duration)));
      if (fits && !crossing && !overlaps(a, b)) {
        spans.push({ offset: a, length: unit });
        break;
      }
    }
  }
  return spans.sort((x, y) => cmp(x.offset, y.offset));
}
