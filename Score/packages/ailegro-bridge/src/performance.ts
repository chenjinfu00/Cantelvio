/** Instrument-aware realization of generated notes, before notation/preview/playback diverge. */
import {
  type Rational,
  type ScoreDoc,
  type StaffInfo,
  add,
  allStaves,
  cmp,
  divInt,
  floorDiv,
  getInstrument,
  lt,
  min,
  mulInt,
  parseRational,
  rat,
  sub,
  toNumber,
  midiOf,
  isMultipleOf,
} from '@ailegro-score/core';
import type { ComposeResult, ComposeTask, ResultNote } from './schemas';
import { qualityOf } from './qualities';

export const DIFFICULTIES = ['easy', 'medium', 'advanced'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export type PianoTexture = 'broken' | 'chords' | 'model';
export interface PerformanceOptions {
  readonly difficulty: Difficulty;
  /** Optional player-specific reach, in semitones; independent of technical difficulty. */
  readonly maxHandSpan?: number;
  readonly pianoTexture?: PianoTexture;
  readonly task?: ComposeTask;
  readonly seed?: number;
  readonly useScoreChords?: boolean;
}
export const PERFORMANCE_PROFILES = {
  easy: {
    grid: rat(1, 4),
    handSpan: 9,
    rightNotes: 3,
    leftNotes: 1,
    leap: 7,
    minSeconds: 0.3,
    breathSeconds: 6,
  },
  medium: {
    grid: rat(1, 8),
    handSpan: 12,
    rightNotes: 3,
    leftNotes: 2,
    leap: 12,
    minSeconds: 0.18,
    breathSeconds: 8,
  },
  advanced: {
    grid: rat(1, 16),
    handSpan: 12,
    rightNotes: 4,
    leftNotes: 2,
    leap: 16,
    minSeconds: 0.1,
    breathSeconds: 12,
  },
} as const;

export interface PerformanceNote {
  readonly staff: StaffInfo;
  readonly voice: number;
  readonly slot: string;
  readonly start: Rational;
  readonly end: Rational;
  readonly midi: number | null;
  readonly note: ResultNote;
  readonly bar: number;
}
export interface PerformanceMetrics {
  readonly notes: number;
  readonly outOfRange: number;
  readonly maxSimultaneous: number;
  /** Per staff across every voice, including notes held from previous bars. */
  readonly maxHandSpan: number;
}
export interface PerformanceReport {
  readonly difficulty: Difficulty;
  readonly handSpanLimit: number;
  readonly pianoTexture: PianoTexture;
  readonly arrangedPianoParts: number;
  readonly before: PerformanceMetrics;
  readonly after: PerformanceMetrics;
}

const pc = (n: number) => ((n % 12) + 12) % 12;
function pitchesIn(pc0: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let p = lo; p <= hi; p++) if (pc(p) === pc(pc0)) out.push(p);
  return out;
}
function nearest(xs: readonly number[], target: number): number | undefined {
  return [...xs].sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)[0];
}
function quarterTempo(doc: ScoreDoc, bar: number): number {
  let tempo = doc.settings.defaultTempo;
  const qpm = (mark: NonNullable<ScoreDoc['measures'][number]['tempo']>[number]) =>
    mark.bpm * (mark.beatUnit ? toNumber(mark.beatUnit) * 4 : 1);
  for (const m of doc.measures.slice(0, bar)) for (const mark of m.tempo ?? []) tempo = qpm(mark);
  // The fastest tempo within the bar sets a conservative subdivision envelope.
  return Math.max(20, tempo, ...(doc.measures[bar]?.tempo ?? []).map(qpm));
}

function gridAt(doc: ScoreDoc, bar: number, options: PerformanceOptions): Rational {
  const profile = PERFORMANCE_PROFILES[options.difficulty];
  let grid: Rational = profile.grid;
  while ((toNumber(grid) * 240) / quarterTempo(doc, bar) < profile.minSeconds)
    grid = mulInt(grid, 2);
  return grid;
}
function handSpan(options: PerformanceOptions): number {
  const value = options.maxHandSpan ?? PERFORMANCE_PROFILES[options.difficulty].handSpan;
  if (!Number.isInteger(value) || value < 5 || value > 16)
    throw new Error('hand span must be 5–16 semitones');
  return value;
}

/** Audit actual sounding overlap, not just individual printed chords or model voice slots. */
export function performanceMetrics(notes: readonly PerformanceNote[]): PerformanceMetrics {
  const staffs = new Map<string, PerformanceNote[]>();
  let outOfRange = 0,
    maxSimultaneous = 0,
    maxHandSpan = 0;
  for (const note of notes) {
    const inst = getInstrument(note.staff.part.instrument);
    if (note.midi !== null && (note.midi < inst.range[0] || note.midi > inst.range[1]))
      outOfRange++;
    const xs = staffs.get(note.staff.staff.id) ?? [];
    xs.push(note);
    staffs.set(note.staff.staff.id, xs);
  }
  for (const xs of staffs.values()) {
    for (const note of xs) {
      const active = xs.filter((n) => cmp(n.start, note.start) <= 0 && lt(note.start, n.end));
      maxSimultaneous = Math.max(maxSimultaneous, active.length);
      if (getInstrument(note.staff.part.instrument).family === 'keyboards') {
        const ps = active.flatMap((n) => (n.midi === null ? [] : [n.midi]));
        if (ps.length) maxHandSpan = Math.max(maxHandSpan, Math.max(...ps) - Math.min(...ps));
      }
    }
  }
  return { notes: notes.length, outOfRange, maxSimultaneous, maxHandSpan };
}

/** Search inversions in a compact register and minimize voice motion, preserving chord identity. */
function voicing(
  pcs: readonly number[],
  maxNotes: number,
  span: number,
  previous: readonly number[],
): number[] {
  // Third/suspension and seventh take precedence over a doubled root or extra fifth/extension.
  const selected = [...new Set(pcs)].slice(0, maxNotes);
  const candidates: number[][] = [];
  const visit = (i: number, chosen: number[]) => {
    if (i === selected.length) {
      const sorted = [...chosen].sort((a, b) => a - b);
      if (sorted[sorted.length - 1]! - sorted[0]! <= span) candidates.push(sorted);
      return;
    }
    for (const p of pitchesIn(selected[i]!, 59, 79)) visit(i + 1, [...chosen, p]);
  };
  visit(0, []);
  if (!candidates.length) {
    if (selected.length > 1) return voicing(selected.slice(0, -1), maxNotes, span, previous);
    return [nearest(pitchesIn(selected[0] ?? 0, 60, 76), previous[0] ?? 67)!];
  }
  const cost = (ns: number[]) =>
    ns.reduce((s, p, i) => s + Math.abs(p - (previous[i] ?? 64 + i * 4)), 0) +
    Math.abs(ns.reduce((s, p) => s + p, 0) / ns.length - 68) / 4;
  return candidates.sort((a, b) => cost(a) - cost(b) || a[0]! - b[0]!)[0]!;
}

interface HarmonyPoint {
  readonly time: Rational;
  readonly root: number;
  readonly pcs: readonly number[];
  readonly bass?: number;
}
function harmonyPoints(
  doc: ScoreDoc,
  result: ComposeResult,
  starts: readonly Rational[],
  useScore: boolean,
): HarmonyPoint[] {
  const chordPCs = (root: number, quality: string | number) => {
    const intervals = qualityOf(quality).intervals;
    // Root, defining third/suspension, seventh/sixth, fifth, extensions.
    const ordered = [
      intervals[0]!,
      intervals[1]!,
      ...(intervals[3] === undefined ? [] : [intervals[3]]),
      intervals[2],
      ...intervals.slice(4),
    ];
    return [
      ...new Set(ordered.filter((n): n is number => n !== undefined).map((n) => pc(root + n))),
    ];
  };
  const points: HarmonyPoint[] = [];
  if (useScore) {
    const indices = new Map(doc.measures.map((m, i) => [m.id, i]));
    for (const h of doc.harmony) {
      const bar = indices.get(h.measureId);
      if (bar === undefined) continue;
      const root = pc(midiOf({ ...h.root, octave: 4 }));
      points.push({
        time: add(starts[bar]!, h.offset),
        root,
        pcs: chordPCs(root, h.quality),
        ...(h.bass ? { bass: pc(midiOf({ ...h.bass, octave: 4 })) } : {}),
      });
    }
  } else {
    result.bars.forEach((b, i) => {
      for (const h of b.chords)
        points.push({
          time: add(starts[result.startBar + i]!, divInt(parseRational(h.onset), 4)),
          root: h.root,
          pcs: chordPCs(h.root, h.quality),
        });
    });
  }
  return points.sort((a, b) => cmp(a.time, b.time));
}

function pianoAccompaniment(
  doc: ScoreDoc,
  result: ComposeResult,
  raw: readonly PerformanceNote[],
  starts: readonly Rational[],
  lengths: readonly Rational[],
  options: PerformanceOptions,
): PerformanceNote[] {
  const staffs = allStaves(doc).filter((s) => s.part.id === raw[0]!.staff.part.id);
  const profile = PERFORMANCE_PROFILES[options.difficulty],
    span = handSpan(options);
  const harmony = harmonyPoints(doc, result, starts, options.useScoreChords ?? false);
  const out: PerformanceNote[] = [];
  let previous: number[] = [],
    previousBass = 43;
  const patterns = [
    [0, 1, 2, 1],
    [0, 2, 1, 2],
    [2, 1, 0, 1],
  ];
  const pattern =
    patterns[(((options.seed ?? 0) % patterns.length) + patterns.length) % patterns.length]!;
  const template = raw[0]!;
  const emit = (
    staff: StaffInfo,
    start: Rational,
    end: Rational,
    midi: number,
    bar: number,
    velocity: number,
  ) => {
    if (!lt(start, end)) return;
    out.push({
      ...template,
      staff,
      start,
      end,
      midi,
      bar,
      voice: 0,
      slot: `performance:${staff.staff.id}`,
      note: {
        ...template.note,
        pitch: midi,
        voice: staff.staffIndex,
        velocity,
        dynamic: 'mp',
        accent: 0,
        wedge: null,
      },
    });
  };
  result.bars.forEach((b, k) => {
    const bar = result.startBar + k,
      begin = starts[bar]!,
      finish = add(begin, lengths[bar]!);
    const rawBar = raw.filter((n) => n.bar === bar);
    // An empty model bar remains a rest; do not manufacture music from stale context harmony.
    if (!rawBar.length) return;
    const changes = harmony.filter((h) => lt(begin, h.time) && lt(h.time, finish));
    const cuts = [begin, ...changes.map((h) => h.time), finish];
    let stepIndex = 0;
    for (let c = 0; c + 1 < cuts.length; c++) {
      const a = cuts[c]!,
        end = cuts[c + 1]!;
      const chord = [...harmony].reverse().find((h) => cmp(h.time, a) <= 0);
      const fallback = [...new Set(rawBar.filter((n) => n.midi !== null).map((n) => pc(n.midi!)))];
      if (!chord && !fallback.length) continue;
      const pcs = chord?.pcs ?? fallback;
      const right = voicing(pcs, profile.rightNotes, span, previous);
      previous = right;
      const root = chord?.bass ?? chord?.root ?? pcs[0]!;
      const bass = nearest(pitchesIn(root, 36, 53), previousBass)!;
      previousBass = bass;
      const compound = b.meter[1] === 8 && b.meter[0] >= 6 && b.meter[0] % 3 === 0;
      const grid = gridAt(doc, bar, options);
      // At slow compound meters retain the notated eighth-note pulse.
      const rightGrid = compound && cmp(grid, rat(1, 8)) > 0 ? rat(3, 8) : grid;
      const pulse = compound ? rat(3, 8) : rat(1, 2);
      for (let t = a; lt(t, end); t = add(t, rightGrid)) {
        const until = min(add(t, rightGrid), end);
        if (options.pianoTexture === 'chords') {
          // Chordal texture uses one attack per beat (easy: half notes).
          const chordGrid =
            options.difficulty === 'easy' ? pulse : compound ? rat(3, 8) : rat(1, 4);
          if (!isMultipleOf(sub(t, a), chordGrid)) continue;
          for (const p of right) emit(staffs[0]!, t, min(add(t, chordGrid), end), p, bar, 65);
        } else {
          const fourTonePatterns = [
            [0, 2, 1, 3],
            [0, 1, 3, 2],
            [3, 2, 1, 0],
          ];
          const sequence =
            right.length === 4 ? fourTonePatterns[(((options.seed ?? 0) % 3) + 3) % 3]! : pattern;
          const p = right[sequence[stepIndex % sequence.length]! % right.length]!;
          emit(staffs[0]!, t, until, p, bar, stepIndex % 4 === 0 ? 66 : 59);
        }
        stepIndex++;
      }
      for (let t = a; lt(t, end); t = add(t, pulse)) {
        const until = min(add(t, pulse), end);
        emit(staffs[1]!, t, until, bass, bar, 56);
        if (options.difficulty === 'advanced' && span >= 12 && profile.leftNotes > 1)
          emit(staffs[1]!, t, until, bass + 12, bar, 48);
      }
    }
  });
  return out;
}

/** Conservative single-player envelopes. Special techniques/divisi/fingering need a later solver. */
function constrainPart(
  doc: ScoreDoc,
  raw: readonly PerformanceNote[],
  options: PerformanceOptions,
  starts: readonly Rational[],
  lengths: readonly Rational[],
  keepTiming = false,
): PerformanceNote[] {
  const inst = getInstrument(raw[0]!.staff.part.instrument),
    profile = PERFORMANCE_PROFILES[options.difficulty];
  const span = handSpan(options);
  const keyboard = inst.family === 'keyboards' && inst.id !== 'harp';
  const oneLine =
    ['woodwinds', 'brass', 'strings', 'voices', 'plucked'].includes(inst.family) ||
    inst.id === 'harp';
  const breathing = ['woodwinds', 'brass', 'voices'].includes(inst.family);
  const out: PerformanceNote[] = [];
  const pools = new Map<string, PerformanceNote[]>();
  for (const n of raw) {
    // Mallet players share a two-note limit across their staves. Keyboards have independent hands.
    const key = keyboard || inst.id === 'harp' ? n.staff.staff.id : n.staff.part.id;
    const ns = pools.get(key) ?? [];
    ns.push(n);
    pools.set(key, ns);
  }
  for (const ns of pools.values()) {
    const isPedal = inst.id === 'organ' && ns[0]!.staff.staffIndex === 2;
    const poly =
      oneLine || isPedal
        ? 1
        : keyboard
          ? ns[0]!.staff.staffIndex === 0
            ? profile.rightNotes
            : profile.leftNotes
          : inst.unpitched
            ? 1
            : 2;
    const batches = new Map<string, { start: Rational; bar: number; notes: PerformanceNote[] }>();
    for (const n of ns) {
      const grid = gridAt(doc, n.bar, options),
        offset = sub(n.start, starts[n.bar]!);
      const tick = floorDiv(offset, grid),
        start = keepTiming ? n.start : add(starts[n.bar]!, mulInt(grid, tick));
      const key = `${start.n}/${start.d}`;
      const batch = batches.get(key) ?? { start, bar: n.bar, notes: [] };
      batch.notes.push(n);
      batches.set(key, batch);
    }
    const ordered = [...batches.values()].sort((a, b) => cmp(a.start, b.start));
    let previous: number | undefined,
      phraseStart: Rational | undefined,
      priorEnd: Rational | undefined;
    const drumPitches = new Set<number>();
    ordered.forEach((batch, i) => {
      const grid = gridAt(doc, batch.bar, options);
      const barEnd = add(starts[batch.bar]!, lengths[batch.bar]!);
      const next = ordered[i + 1]?.start ?? barEnd;
      let end = min(barEnd, next);
      // Retain the largest duration in the batch on a readable grid, never overlap the next attack.
      const duration = batch.notes.reduce((a, n) => (cmp(n.end, a) > 0 ? n.end : a), batch.start);
      const ticks = Math.max(1, floorDiv(sub(duration, batch.start), grid));
      end = min(end, keepTiming ? duration : add(batch.start, mulInt(grid, ticks)));
      if (breathing) {
        const naturalGap = priorEnd
          ? (toNumber(sub(batch.start, priorEnd)) * 240) / quarterTempo(doc, batch.bar)
          : Infinity;
        if (!phraseStart || naturalGap >= 0.25) phraseStart = batch.start;
        const phraseSeconds =
          (toNumber(sub(end, phraseStart)) * 240) / quarterTempo(doc, batch.bar);
        if (phraseSeconds >= profile.breathSeconds) {
          const limit = rat(
            Math.max(
              1,
              Math.floor((profile.breathSeconds * quarterTempo(doc, batch.bar) * grid.d) / 240),
            ),
            grid.d,
          );
          end = min(end, sub(add(phraseStart, limit), grid));
          if (!lt(batch.start, end)) {
            phraseStart = undefined;
            priorEnd = batch.start;
            return;
          }
        }
      }
      if (!lt(batch.start, end)) return;
      const center =
        previous ??
        (keyboard
          ? ns[0]!.staff.staffIndex === 0
            ? 68
            : 47
          : (inst.range[0] + inst.range[1]) / 2);
      const candidates = batch.notes
        .map((n) => {
          if (inst.unpitched) return { n, midi: null };
          if (n.midi === null) return { n, midi: undefined };
          const inset =
            keyboard || inst.family === 'percussion'
              ? 0
              : options.difficulty === 'easy'
                ? Math.min(12, Math.floor((inst.range[1] - inst.range[0]) / 6))
                : options.difficulty === 'medium'
                  ? Math.min(6, Math.floor((inst.range[1] - inst.range[0]) / 12))
                  : 0;
          const possibilities = pitchesIn(n.midi, inst.range[0] + inset, inst.range[1] - inset);
          // Stay in a reachable register, using octave equivalence to preserve the harmonic pitch class.
          const rapid = priorEnd !== undefined && cmp(sub(batch.start, priorEnd), rat(1, 4)) < 0;
          const reachable =
            previous !== undefined && rapid
              ? possibilities.filter((p) => Math.abs(p - previous!) <= profile.leap)
              : possibilities;
          return { n, midi: nearest(reachable, reachable.includes(n.midi) ? n.midi : center) };
        })
        .filter((n): n is { n: PerformanceNote; midi: number | null } => n.midi !== undefined)
        .sort(
          (a, b) =>
            Math.abs((a.midi ?? center) - center) - Math.abs((b.midi ?? center) - center) ||
            b.n.note.velocity - a.n.note.velocity,
        );
      const chosen: number[] = [];
      for (const { n, midi } of candidates) {
        if (chosen.length >= poly || chosen.includes(midi ?? -1)) continue;
        if (
          keyboard &&
          midi !== null &&
          chosen.length &&
          Math.max(...chosen, midi) - Math.min(...chosen, midi) > span
        )
          continue;
        if (
          inst.id === 'timpani' &&
          midi !== null &&
          !drumPitches.has(midi) &&
          drumPitches.size >= 4
        )
          continue;
        if (inst.id === 'timpani' && midi !== null) drumPitches.add(midi);
        chosen.push(midi ?? -1);
        out.push({
          ...n,
          start: batch.start,
          end,
          midi,
          voice: 0,
          slot: `performance:${n.staff.staff.id}`,
          note: {
            ...n.note,
            pitch: midi,
            // Range/density constraints must not flatten the model's expression.
            // Explicit chord realizations already supply their own mp/velocity pattern.
            velocity: Math.max(1, Math.min(127, n.note.velocity)),
          },
        });
      }
      if (chosen.length) {
        previous = chosen[0] === -1 ? previous : chosen[0];
        priorEnd = end;
      }
    });
  }
  return out;
}

export function planPerformance(
  doc: ScoreDoc,
  result: ComposeResult,
  raw: readonly PerformanceNote[],
  starts: readonly Rational[],
  lengths: readonly Rational[],
  options: PerformanceOptions,
): { readonly notes: PerformanceNote[]; readonly report: PerformanceReport } {
  const parts = new Map<string, PerformanceNote[]>();
  for (const note of raw) {
    const xs = parts.get(note.staff.part.id) ?? [];
    xs.push(note);
    parts.set(note.staff.part.id, xs);
  }
  const notes: PerformanceNote[] = [];
  let arrangedPianoParts = 0;
  for (const xs of parts.values()) {
    if (
      getInstrument(xs[0]!.staff.part.instrument).id === 'piano' &&
      options.task === 'accompany-melody' &&
      options.pianoTexture !== 'model'
    ) {
      const arranged = pianoAccompaniment(doc, result, xs, starts, lengths, options);
      notes.push(...constrainPart(doc, arranged, options, starts, lengths, true));
      arrangedPianoParts++;
    } else notes.push(...constrainPart(doc, xs, options, starts, lengths));
  }
  return {
    notes,
    report: {
      difficulty: options.difficulty,
      handSpanLimit: handSpan(options),
      pianoTexture: options.pianoTexture ?? 'broken',
      arrangedPianoParts,
      before: performanceMetrics(raw),
      after: performanceMetrics(notes),
    },
  };
}
