/**
 * Placement of what spans time inside one system, after its notes are drawn: slurs, trill lines
 * and octave lines above the notes; octave-down lines, dynamics with their hairpins (one baseline
 * per connected group) and pedal marks below. A spanner crossing a system break is drawn as one
 * segment per system. Everything is placed against the system's skyline, so later items stack
 * outside earlier ones.
 */
import {
  type DynamicMark,
  type MeasureInfo,
  type Rational,
  type ScoreDoc,
  type Spanner,
  type StaffInfo,
  type TimeSpan,
  add,
  eq,
  findEvent,
  le,
  lt,
  spannerTimes,
  sub,
  toNumber,
} from '@cantelvio-score/core';
import type { Extent } from '../bbox';
import type { Graphic } from '../graphics';
import { glyphBox } from '../smufl/glyphs';
import { placeMarks } from './chord';
import { type PlacedChord, drawDynamic, dynamicWidth } from './draw';
import { type MeasureGeometry, offsetToX } from './geometry';
import {
  HAIRPIN_OPENING,
  OTTAVA_HEIGHT,
  drawHairpin,
  drawOttava,
  drawPedal,
  drawSlur,
  drawTrillLine,
  slurShape,
} from './lines';
import type { NMeasure } from './notation';

export interface SystemChord {
  readonly staff: number;
  readonly p: PlacedChord;
  /** Absolute start time of the chord. */
  readonly t: Rational;
  readonly measure: number;
}

export interface SystemDynamic {
  readonly staff: number;
  readonly x: number;
  readonly t: Rational;
  readonly mark: DynamicMark;
}

export interface SpannerContext {
  readonly doc: ScoreDoc;
  readonly staves: readonly StaffInfo[];
  readonly notation: NMeasure[][];
  readonly infos: readonly MeasureInfo[];
  readonly measures: readonly MeasureGeometry[];
  readonly chords: readonly SystemChord[];
  readonly dynamics: readonly SystemDynamic[];
  readonly systemEnd: number;
  readonly sky: readonly (readonly { readonly g: Graphic; readonly e: Extent }[])[];
  push(k: number, g: Graphic): void;
  skyTop(k: number, x0: number, x1: number, base: number): number;
  skyBottom(k: number, x0: number, x1: number, base: number): number;
}

interface Segment {
  readonly sp: TimeSpan;
  readonly k: number;
  readonly start: Rational;
  readonly end: Rational;
  /** Starts in an earlier system / continues in a later one. */
  readonly continued: boolean;
  readonly continues: boolean;
}

const ghostOf = (sp: { source?: Spanner['source'] }) =>
  sp.source?.kind === 'ai' && !sp.source.accepted ? ' ghost' : '';

export function drawSystemSpanners(c: SpannerContext): void {
  const { doc, infos, measures } = c;
  if (!measures.length || !doc.spanners.length) {
    drawDynamicsAndHairpins(c, []);
    return;
  }
  const first = measures[0]!;
  const last = measures[measures.length - 1]!;
  const sysStart = infos[first.index]!.start;
  const sysEnd = add(infos[last.index]!.start, infos[last.index]!.length);
  const staffIndex = new Map(c.staves.map((s, k) => [s.staff.id, k]));

  const segments: Segment[] = [];
  const slurs: { sp: Extract<Spanner, { kind: 'slur' }>; k: number }[] = [];
  for (const sp of doc.spanners) {
    const k = staffIndex.get(sp.staffId);
    if (k === undefined) continue;
    if (sp.kind === 'slur') {
      slurs.push({ sp, k });
      continue;
    }
    const t = spannerTimes(doc, sp);
    if (!t || !lt(t.start, sysEnd) || !lt(sysStart, t.end)) continue;
    segments.push({
      sp,
      k,
      start: t.start,
      end: t.end,
      continued: lt(t.start, sysStart),
      continues: lt(sysEnd, t.end),
    });
  }
  const x = new SystemX(c, sysStart, sysEnd);

  for (const { sp, k } of slurs) drawSlurSegment(c, x, sp, k, sysStart, sysEnd);

  // trill lines, then octave lines above the staff
  for (const s of segments) {
    if (s.sp.kind !== 'trill') continue;
    const x1 = s.continued ? x.lineStart : x.at(s.start) - 0.1;
    const x2 = s.continues ? c.systemEnd - 0.3 : Math.max(x1 + 2.2, x.until(s.end) - 0.6);
    const baseline = Math.min(-0.9, c.skyTop(s.k, x1, x2, 0) - 0.45);
    c.push(
      s.k,
      drawTrillLine(x1, x2, baseline, s.continued, `trill-line${ghostOf(s.sp)}`, `sp:${s.sp.id}`),
    );
  }
  for (const s of segments) {
    if (s.sp.kind !== 'ottava') continue;
    const octaves = s.sp.octaves;
    const x1 = s.continued ? x.lineStart : x.at(s.start) - 0.4;
    let x2: number;
    if (s.continues) x2 = c.systemEnd - 0.3;
    else {
      // to the end of the last covered note
      const covered = c.chords.filter(
        (ch) => ch.staff === s.k && le(s.start, ch.t) && lt(ch.t, s.end),
      );
      x2 = covered.length
        ? Math.max(...covered.map((ch) => ch.p.x + ch.p.geom.right)) + 0.3
        : x.until(s.end) - 0.6;
    }
    x2 = Math.max(x2, x1 + 4);
    const baseline =
      octaves > 0
        ? Math.min(-1.2, c.skyTop(s.k, x1, x2, 0) - 0.5)
        : Math.max(5.2, c.skyBottom(s.k, x1, x2, 4) + 0.5) + OTTAVA_HEIGHT;
    c.push(
      s.k,
      drawOttava(
        octaves,
        x1,
        x2,
        baseline,
        s.continued,
        s.continues,
        `ottava${ghostOf(s.sp)}`,
        `sp:${s.sp.id}`,
      ),
    );
  }

  drawDynamicsAndHairpins(
    c,
    segments.filter((s) => s.sp.kind === 'hairpin'),
    x,
  );

  // pedal marks lowest, on one baseline per staff in the system
  const pedals = segments.filter((s) => s.sp.kind === 'pedal');
  const byStaff = new Map<number, { s: Segment; x1: number; x2: number; line: boolean }[]>();
  for (const s of pedals) {
    const line = s.sp.kind === 'pedal' && s.sp.style === 'line';
    const x1 = s.continued ? x.lineStart : x.at(s.start) - 0.5;
    const x2 = s.continues
      ? c.systemEnd - 0.3
      : Math.max(x1 + 1.5, x.until(s.end) - (line ? 0.4 : 0.8));
    const list = byStaff.get(s.k) ?? [];
    list.push({ s, x1, x2, line });
    byStaff.set(s.k, list);
  }
  for (const [k, list] of byStaff) {
    let baseline = 7.6;
    for (const p of list)
      baseline = Math.max(
        baseline,
        c.skyBottom(k, p.x1 - 0.3, p.x2 + 0.9, 4) + (p.line ? 1.5 : 2.6),
      );
    for (const p of list)
      c.push(
        k,
        drawPedal(
          p.line ? 'line' : 'text',
          p.x1,
          p.x2,
          baseline,
          p.s.continued,
          p.s.continues,
          `pedal${ghostOf(p.s.sp)}`,
          `sp:${p.s.sp.id}`,
        ),
      );
  }
}

/** Time -> x inside one system. */
class SystemX {
  /** Where lines continued from the previous system begin. */
  readonly lineStart: number;
  constructor(
    private readonly c: SpannerContext,
    private readonly sysStart: Rational,
    private readonly sysEnd: Rational,
  ) {
    this.lineStart = c.measures[0]!.x + 0.4;
  }

  private geomAt(t: Rational): MeasureGeometry | undefined {
    return this.c.measures.find((mg) => {
      const info = this.c.infos[mg.index]!;
      return le(info.start, t) && lt(t, add(info.start, info.length));
    });
  }

  /** x of a time position (a note's position when one starts there). */
  at(t: Rational): number {
    if (!lt(t, this.sysEnd)) return this.c.systemEnd;
    if (lt(t, this.sysStart)) return this.lineStart;
    const mg = this.geomAt(t);
    return mg ? offsetToX(mg, sub(t, this.c.infos[mg.index]!.start)) : this.lineStart;
  }

  /** x where something ending at t stops: the barline when t is at one. */
  until(t: Rational): number {
    if (!lt(t, this.sysEnd)) return this.c.systemEnd;
    const mg = this.c.measures.find((m) => eq(this.c.infos[m.index]!.start, t));
    return mg ? mg.x : this.at(t);
  }
}

// ------------------------------------------------------------------------------- slurs

function drawSlurSegment(
  c: SpannerContext,
  x: SystemX,
  sp: Extract<Spanner, { kind: 'slur' }>,
  k: number,
  sysStart: Rational,
  sysEnd: Rational,
): void {
  const a = findEvent(c.doc, sp.from);
  const b = findEvent(c.doc, sp.to);
  if (!a || !b || !lt(a.start, sysEnd) || lt(b.start, sysStart)) return;
  const pick = (id: string) =>
    c.chords.find((ch) => ch.staff === k && ch.p.chord.eventId === id && ch.p.chord.firstPiece);
  const startChord = pick(sp.from);
  const endChord = pick(sp.to);
  const voice = a.voice;
  const inRange = c.chords.filter(
    (ch) => ch.staff === k && ch.p.chord.voice === voice && le(a.start, ch.t) && le(ch.t, b.start),
  );
  let above: boolean;
  if (sp.placement) above = sp.placement === 'above';
  else if (c.notation[k]![a.measureIndex]?.multiVoice) above = voice % 2 === 0;
  else above = !(inRange.length && inRange.every((ch) => ch.p.chord.stem === 'up'));
  const dir: 1 | -1 = above ? -1 : 1;

  const endpoint = (ch: SystemChord, isStart: boolean): { x: number; y: number } => {
    const g = ch.p.geom;
    const up = ch.p.chord.stem === 'up';
    const ys = g.noteheads.map((h) => h.y);
    const topY = Math.min(...ys);
    const bottomY = Math.max(...ys);
    let px = ch.p.x + g.noteheadWidth / 2;
    let py: number;
    const atStem = g.stem && (above ? up : !up);
    if (atStem) {
      px = ch.p.x + g.stem!.x + (isStart ? 0.2 : -0.2);
      py = g.stem!.yTip + dir * 0.5;
    } else py = above ? topY - 0.85 : bottomY + 0.85;
    // stay outside staccato dots, accents and the like on that side
    for (const m of placeMarks(ch.p.chord, g)) {
      if (!m.glyph.startsWith('artic')) continue;
      const box = glyphBox(m.glyph, m.scale ?? 1);
      if (above && m.y + box.bottom <= topY) py = Math.min(py, m.y + box.top - 0.25);
      if (!above && m.y + box.top >= bottomY) py = Math.max(py, m.y + box.bottom + 0.25);
    }
    return { x: px, y: py };
  };

  const s = startChord ? endpoint(startChord, true) : null;
  const e = endChord ? endpoint(endChord, false) : null;
  const edgeY = (other: { y: number } | null) =>
    above ? Math.min(-1.0, (other?.y ?? -1.0) - 0.5) : Math.max(5.0, (other?.y ?? 5.0) + 0.5);
  const x1 = s ? s.x : x.lineStart - 0.2;
  const y1 = s ? s.y : edgeY(e);
  let x2 = e ? e.x : c.systemEnd - 0.3;
  const y2 = e ? e.y : edgeY(s);
  if (x2 < x1 + 1) x2 = x1 + 1;

  // the notes, beams, ties and marks under the slur
  const own = new Set([`e:${sp.from}`, `e:${sp.to}`]);
  const obstacles: { x: number; y: number }[] = [];
  for (const { g, e: box } of c.sky[k]!) {
    if (box.maxX <= x1 || box.minX >= x2 || (g.ref && own.has(g.ref))) continue;
    if (g.cls === 'staff-line') continue;
    const oy = above ? box.minY : box.maxY;
    for (const ox of [
      Math.max(box.minX, x1 + 0.3),
      (box.minX + box.maxX) / 2,
      Math.min(box.maxX, x2 - 0.3),
    ])
      obstacles.push({ x: ox, y: oy });
  }
  const shape = slurShape(x1, y1, x2, y2, dir, obstacles);
  c.push(
    k,
    drawSlur(x1, shape.y1, x2, shape.y2, dir, shape.h, `slur${ghostOf(sp)}`, `sp:${sp.id}`),
  );
}

// ------------------------------------------------------------------------------- dynamics

/**
 * Dynamics and hairpins of each staff: items that touch share one baseline (a hairpin running
 * from "p" to "f" sits level with both), clear of everything above them.
 */
function drawDynamicsAndHairpins(c: SpannerContext, hairpins: Segment[], x?: SystemX): void {
  type Item =
    | { kind: 'dyn'; k: number; x0: number; x1: number; d: SystemDynamic }
    | {
        kind: 'pin';
        k: number;
        x0: number;
        x1: number;
        s: Segment;
        open1: number;
        open2: number;
      };
  const items: Item[] = c.dynamics.map((d) => ({
    kind: 'dyn' as const,
    k: d.staff,
    x0: d.x,
    x1: d.x + dynamicWidth(d.mark.value),
    d,
  }));
  if (x && c.measures.length) {
    const first = c.measures[0]!;
    const last = c.measures[c.measures.length - 1]!;
    const sysStart = c.infos[first.index]!.start;
    const sysEnd = add(c.infos[last.index]!.start, c.infos[last.index]!.length);
    for (const s of hairpins) {
      if (s.sp.kind !== 'hairpin') continue;
      const dyns = items.filter(
        (i): i is Extract<Item, { kind: 'dyn' }> => i.kind === 'dyn' && i.k === s.k,
      );
      const atStart = dyns.find((i) => eq(i.d.t, s.start));
      const atEnd = dyns.find((i) => eq(i.d.t, s.end));
      const x1 = s.continued ? x.lineStart : atStart ? atStart.x1 + 0.5 : x.at(s.start) - 0.1;
      let x2 = s.continues ? c.systemEnd - 0.4 : atEnd ? atEnd.x0 - 0.6 : x.until(s.end) - 0.7;
      if (x2 < x1 + 1.2) x2 = x1 + 1.2;
      const span = Math.max(1e-9, toNumber(sub(s.end, s.start)));
      const frac = (t: Rational) => Math.max(0, Math.min(1, toNumber(sub(t, s.start)) / span));
      const fa = frac(s.continued ? sysStart : s.start);
      const fb = frac(s.continues ? sysEnd : s.end);
      const cresc = s.sp.direction === 'crescendo';
      items.push({
        kind: 'pin',
        k: s.k,
        x0: x1,
        x1: x2,
        s,
        open1: HAIRPIN_OPENING * (cresc ? fa : 1 - fa),
        open2: HAIRPIN_OPENING * (cresc ? fb : 1 - fb),
      });
    }
  }
  const staves = new Set(items.map((i) => i.k));
  for (const k of staves) {
    const list = items.filter((i) => i.k === k).sort((a, b) => a.x0 - b.x0);
    let group: Item[] = [];
    const flush = () => {
      if (!group.length) return;
      let baseline = 7.2;
      for (const i of group) {
        const need =
          i.kind === 'dyn'
            ? c.skyBottom(k, i.x0 - 0.3, i.x1 + 0.3, 4) + 2.4
            : c.skyBottom(k, i.x0, i.x1, 4) + 0.75 + HAIRPIN_OPENING / 2 + 0.6;
        baseline = Math.max(baseline, need);
      }
      for (const i of group) {
        if (i.kind === 'dyn')
          c.push(
            k,
            drawDynamic(i.d.mark.value, i.x0, baseline, `dy:${i.d.mark.id}`, ghostOf(i.d.mark)),
          );
        else
          c.push(
            k,
            drawHairpin(
              i.x0,
              i.x1,
              baseline - 0.75,
              i.open1,
              i.open2,
              `hairpin${ghostOf(i.s.sp)}`,
              `sp:${i.s.sp.id}`,
            ),
          );
      }
      group = [];
    };
    let reach = -Infinity;
    for (const i of list) {
      if (group.length && i.x0 > reach + 1.2) flush();
      group.push(i);
      reach = Math.max(reach, i.x1);
    }
    flush();
  }
}
