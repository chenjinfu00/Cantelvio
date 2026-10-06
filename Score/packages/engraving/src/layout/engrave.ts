/**
 * Score layout: measure columns -> systems (line breaking + justification) -> vertical spacing ->
 * pages. Produces positioned graphics plus the geometry the editor needs for hit-testing.
 */
import {
  type ClefType,
  type KeySignature,
  type Rational,
  type ScoreDoc,
  type StaffInfo,
  add,
  allStaves,
  findInstrument,
  keyTonic,
  lt,
  measureInfos,
} from '@ailegro-score/core';
import { extentOf } from '../bbox';
import { type Graphic, translate } from '../graphics';
import { type LayoutOptions, STYLE, defaultOptions } from '../options';
import { glyphBox, glyphWidth } from '../smufl/glyphs';
import { type Column, buildColumn, columnWidth, segmentPositions } from './columns';
import { type PlacedChord, beamGroup, drawChord, drawRest, drawTie, drawTupletMark } from './draw';
import {
  type MeasureGeometry,
  type SegmentGeometry,
  offsetToX,
  xAtOffset,
  xToOffset,
} from './geometry';
import { type NMeasure, buildStaffNotation } from './notation';
import { type SystemChord, type SystemDynamic, drawSystemSpanners } from './spanners';
import {
  CHANGE_CLEF_SCALE,
  clefWidth,
  drawClef,
  drawKeySignature,
  drawTimeSignature,
  keySignatureGlyphs,
  keySignatureWidth,
  timeSignatureWidth,
} from './signatures';

export { type MeasureGeometry, type SegmentGeometry, offsetToX, xAtOffset, xToOffset };

export interface StaffGeometry {
  readonly staffId: string;
  readonly partId: string;
  /** y of the top staff line (page coordinates, sp). */
  readonly y: number;
  readonly lines: number;
}

export interface SystemGeometry {
  readonly index: number;
  readonly page: number;
  readonly x: number;
  readonly width: number;
  readonly top: number;
  readonly bottom: number;
  readonly staves: readonly StaffGeometry[];
  readonly measures: readonly MeasureGeometry[];
}

export interface PageLayout {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly graphics: readonly Graphic[];
  readonly systems: readonly SystemGeometry[];
}

export interface ScoreLayout {
  readonly pages: readonly PageLayout[];
  readonly systems: readonly SystemGeometry[];
  /** Millimetres per staff space. */
  readonly staffSpaceMm: number;
  readonly options: LayoutOptions;
}

interface SystemPlan {
  readonly first: number;
  readonly last: number;
}

interface Built {
  readonly staffGraphics: Graphic[][];
  readonly systemGraphics: (staffY: number[]) => Graphic[];
  readonly measures: (Omit<MeasureGeometry, 'segments'> & { segments: SegmentGeometry[] })[];
  readonly width: number;
}

export function layoutScore(doc: ScoreDoc, overrides: Partial<LayoutOptions> = {}): ScoreLayout {
  const opts = defaultOptions(doc, overrides);
  const staves = allStaves(doc);
  const infos = measureInfos(doc);
  const notation: NMeasure[][] = staves.map((s) =>
    buildStaffNotation(doc, s, {
      concertPitch: opts.concertPitch,
      ...(opts.ghostEvents ? { ghostEvents: opts.ghostEvents } : {}),
    }),
  );
  const columns: Column[] = infos.map((info, i) =>
    buildColumn(
      info,
      notation.map((n) => n[i]!),
      opts.spacing,
    ),
  );

  const spMm = opts.staffSpaceMm ?? doc.settings.staffSpaceMm;
  const pageW = (opts.pageWidthMm ?? doc.settings.pageSize.widthMm) / spMm;
  const pageH = (opts.pageHeightMm ?? doc.settings.pageSize.heightMm) / spMm;
  const m = doc.settings.pageMarginsMm;
  const margin = {
    top: m.top / spMm,
    bottom: m.bottom / spMm,
    left: m.left / spMm,
    right: m.right / spMm,
  };

  // ---- left indents: instrument names, brackets and braces
  const hasBrace = doc.groups.some((g) => g.kind === 'brace');
  const hasBracket = doc.groups.some((g) => g.kind === 'bracket' || g.kind === 'square');
  const bracketSpace = (hasBrace ? 1.3 : 0) + (hasBracket ? 1.5 : 0) + 0.4;
  const nameWidth = (abbr: boolean) =>
    Math.max(
      0,
      ...doc.parts.map((p) =>
        opts.measureText(abbr ? p.abbreviation : p.name, STYLE.instrumentNameSize, 'serif'),
      ),
    );
  const showNames = doc.parts.length > 1 || doc.parts.some((p) => p.staves.length === 1);
  const indentFirst = (showNames ? nameWidth(false) + 1.2 : 0) + bracketSpace;
  const indentOther = (showNames ? nameWidth(true) + 1.2 : 0) + bracketSpace;

  // ---- prefixes (signature changes inside a system) and headers (system starts)
  const clefAtEnd = (s: number, i: number): ClefType => {
    const nm = notation[s]![i]!;
    return nm.clefChanges.length ? nm.clefChanges[nm.clefChanges.length - 1]!.clef : nm.clef;
  };
  const prefixWidth = (i: number): number => {
    if (i === 0) return 0;
    const info = infos[i]!;
    let w = 0;
    staves.forEach((_s, s) => {
      let sw = 0;
      if (notation[s]![i]!.clef !== clefAtEnd(s, i - 1))
        sw += clefWidth(notation[s]![i]!.clef, CHANGE_CLEF_SCALE) + 0.5;
      if (info.keySigChange)
        sw +=
          keySignatureWidth(
            keySignatureGlyphs(
              notation[s]![i]!.key,
              notation[s]![i]!.clef,
              notation[s]![i - 1]!.key,
            ),
          ) + STYLE.keySigPad;
      w = Math.max(w, sw);
    });
    if (info.timeSigChange) w += timeSignatureWidth(info.timeSig) + STYLE.timeSigPad;
    return w > 0 ? w + 0.4 : 0;
  };
  const headerWidth = (i: number): number => {
    const info = infos[i]!;
    let w = 0;
    staves.forEach((_s, s) => {
      const nm = notation[s]![i]!;
      const kw = keySignatureWidth(keySignatureGlyphs(nm.key, nm.clef));
      w = Math.max(w, STYLE.clefPadLeft + clefWidth(nm.clef) + (kw ? STYLE.keySigPad + kw : 0));
    });
    if (i === 0 || info.timeSigChange) w += STYLE.timeSigPad + timeSignatureWidth(info.timeSig);
    return w + 0.6;
  };
  const prefixes = infos.map((_x, i) => prefixWidth(i));

  // ---- line breaking
  const plans: SystemPlan[] = [];
  if (opts.mode === 'continuous') {
    plans.push({ first: 0, last: infos.length - 1 });
  } else {
    let i = 0;
    while (i < infos.length) {
      const avail =
        pageW - margin.left - margin.right - (plans.length === 0 ? indentFirst : indentOther);
      let w = headerWidth(i) + columnWidth(columns[i]!, 1);
      let j = i;
      while (j + 1 < infos.length && !infos[j]!.measure.breakAfter) {
        const add = prefixes[j + 1]! + columnWidth(columns[j + 1]!, 1);
        if (w + add > avail) break;
        w += add;
        j++;
      }
      plans.push({ first: i, last: j });
      i = j + 1;
    }
  }

  // ---- build systems
  const built = plans.map((plan, sIndex) => {
    const indent = sIndex === 0 ? indentFirst : indentOther;
    const avail =
      opts.mode === 'continuous' ? Infinity : pageW - margin.left - margin.right - indent;
    const widthAt = (s: number) => {
      let w = headerWidth(plan.first);
      for (let k = plan.first; k <= plan.last; k++)
        w += (k === plan.first ? 0 : prefixes[k]!) + columnWidth(columns[k]!, s);
      return w;
    };
    let stretch = 1;
    const natural = widthAt(1);
    const isLast = sIndex === plans.length - 1;
    if (Number.isFinite(avail) && natural < avail && !(isLast && natural < avail * 0.65)) {
      let lo = 1;
      let hi = 2;
      while (widthAt(hi) < avail && hi < 1e4) hi *= 2;
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        if (widthAt(mid) < avail) lo = mid;
        else hi = mid;
      }
      stretch = lo;
    }
    return buildSystem(
      doc,
      staves,
      notation,
      columns,
      plan,
      sIndex,
      stretch,
      margin.left + indent,
      opts,
      prefixes,
      headerWidth(plan.first),
      indent,
    );
  });

  // ---- vertical layout of each system
  interface Placed {
    readonly built: Built;
    readonly staffY: number[];
    readonly top: number;
    readonly bottom: number;
    readonly plan: SystemPlan;
  }
  const placed: Placed[] = built.map((b, idx) => {
    const ext = b.staffGraphics.map((gs) => extentOf(gs));
    const staffY: number[] = [];
    staves.forEach((s, k) => {
      if (k === 0) {
        staffY.push(0);
        return;
      }
      const prev = staves[k - 1]!;
      const samePart = prev.part.id === s.part.id;
      const base = samePart ? STYLE.staffGapInPart : STYLE.staffGapBetweenParts;
      const prevBottom = Math.max(4, Number.isFinite(ext[k - 1]!.maxY) ? ext[k - 1]!.maxY : 4);
      const thisTop = Math.min(0, Number.isFinite(ext[k]!.minY) ? ext[k]!.minY : 0);
      const gap = Math.max(base, prevBottom - 4 + -thisTop + 1.0);
      staffY.push(staffY[k - 1]! + 4 + gap);
    });
    const top = Math.min(-1, Number.isFinite(ext[0]!.minY) ? ext[0]!.minY : 0);
    const lastExt = ext[ext.length - 1]!;
    const bottom =
      staffY[staffY.length - 1]! + Math.max(4, Number.isFinite(lastExt.maxY) ? lastExt.maxY : 4);
    return { built: b, staffY, top, bottom, plan: plans[idx]! };
  });

  // ---- pages
  const pages: { systems: { p: Placed; y: number }[]; forced?: boolean }[] = [];
  const titleHeight = titleBlockHeight(doc);
  if (opts.mode !== 'page') {
    // One canvas with natural system gaps, without page-height constraints or justification.
    let cursor = margin.top + titleHeight;
    const systems = placed.map((p) => {
      const y = cursor - p.top;
      cursor += p.bottom - p.top + STYLE.systemGap;
      return { p, y };
    });
    pages.push({ systems });
  } else {
    let page: { systems: { p: Placed; y: number }[]; forced?: boolean } = { systems: [] };
    let cursor = margin.top + titleHeight;
    for (const p of placed) {
      const height = p.bottom - p.top;
      if (page.systems.length > 0 && cursor + height > pageH - margin.bottom) {
        pages.push(page);
        page = { systems: [] };
        cursor = margin.top;
      }
      page.systems.push({ p, y: cursor - p.top });
      cursor += height + STYLE.systemGap;
      // a page break after the system's last measure starts a new page
      if (infos[p.plan.last]!.measure.breakAfter === 'page' && p !== placed[placed.length - 1]) {
        pages.push({ ...page, forced: true });
        page = { systems: [] };
        cursor = margin.top;
      }
    }
    pages.push(page);
    // vertical justification of full pages (not of pages ended early by a page break)
    pages.forEach((pg, pi) => {
      if (pi === pages.length - 1 || pg.systems.length < 2 || pg.forced) return;
      const last = pg.systems[pg.systems.length - 1]!;
      const used = last.y + last.p.bottom;
      const spare = pageH - margin.bottom - used;
      if (spare <= 0) return;
      const each = Math.min(spare / (pg.systems.length - 1), 12);
      pg.systems.forEach((s, k) => (s.y += each * k));
    });
  }

  const allSystems: SystemGeometry[] = [];
  const pageLayouts: PageLayout[] = pages.map((pg, pi) => {
    const graphics: Graphic[] = [];
    if (pi === 0) graphics.push(...titleBlock(doc, pageW, margin, opts));
    const systems: SystemGeometry[] = [];
    let width = pageW;
    let height = pageH;
    for (const { p, y } of pg.systems) {
      const staffY = p.staffY.map((sy) => sy + y);
      p.built.staffGraphics.forEach((gs, k) => graphics.push(...translate(gs, 0, staffY[k]!)));
      graphics.push(...p.built.systemGraphics(staffY));
      const geom: SystemGeometry = {
        index: allSystems.length,
        page: pi,
        x: p.built.measures[0]?.x ?? 0,
        width: p.built.width,
        top: y + p.top,
        bottom: y + p.bottom,
        staves: staves.map((s, k) => ({
          staffId: s.staff.id,
          partId: s.part.id,
          y: staffY[k]!,
          lines: s.staff.lines,
        })),
        measures: p.built.measures,
      };
      systems.push(geom);
      allSystems.push(geom);
      if (opts.mode !== 'page') {
        width = Math.max(
          width,
          p.built.measures[p.built.measures.length - 1]!.x +
            p.built.measures[p.built.measures.length - 1]!.width +
            margin.right,
        );
        height = y + p.bottom + margin.bottom;
      }
    }
    return { index: pi, width, height, graphics, systems };
  });

  return { pages: pageLayouts, systems: allSystems, staffSpaceMm: spMm, options: opts };
}

// ------------------------------------------------------------------------------- title

function titleBlockHeight(doc: ScoreDoc): number {
  let h = 0;
  if (doc.meta.title) h += STYLE.titleSize * 1.3;
  if (doc.meta.subtitle) h += STYLE.subtitleSize * 1.4;
  if (doc.meta.composer || doc.meta.arranger || doc.meta.lyricist) h += STYLE.composerSize * 1.6;
  return h > 0 ? h + 3 : 0;
}

function titleBlock(
  doc: ScoreDoc,
  pageW: number,
  margin: { top: number; left: number; right: number },
  _opts: LayoutOptions,
): Graphic[] {
  const out: Graphic[] = [];
  let y = margin.top;
  if (doc.meta.title) {
    y += STYLE.titleSize;
    out.push({
      kind: 'text',
      x: pageW / 2,
      y,
      text: doc.meta.title,
      size: STYLE.titleSize,
      family: 'serif',
      anchor: 'middle',
      cls: 'title',
    });
    y += STYLE.titleSize * 0.3;
  }
  if (doc.meta.subtitle) {
    y += STYLE.subtitleSize * 1.2;
    out.push({
      kind: 'text',
      x: pageW / 2,
      y,
      text: doc.meta.subtitle,
      size: STYLE.subtitleSize,
      family: 'serif',
      anchor: 'middle',
      cls: 'subtitle',
    });
  }
  if (doc.meta.composer || doc.meta.arranger || doc.meta.lyricist) {
    y += STYLE.composerSize * 1.5;
    if (doc.meta.composer)
      out.push({
        kind: 'text',
        x: pageW - margin.right,
        y,
        text: doc.meta.composer,
        size: STYLE.composerSize,
        family: 'serif',
        anchor: 'end',
        cls: 'composer',
      });
    const left = doc.meta.lyricist ?? doc.meta.arranger;
    if (left)
      out.push({
        kind: 'text',
        x: margin.left,
        y,
        text: left,
        size: STYLE.composerSize,
        family: 'serif',
        anchor: 'start',
        cls: 'lyricist',
      });
  }
  return out;
}

// ------------------------------------------------------------------------------- one system

const CHORD_SUFFIX: Record<string, string> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: '+',
  sus2: 'sus2',
  sus4: 'sus4',
  power: '5',
  six: '6',
  min6: 'm6',
  six9: '6/9',
  dom7: '7',
  maj7: 'maj7',
  min7: 'm7',
  minmaj7: 'm(maj7)',
  dim7: '°7',
  half: 'ø7',
  sus7: '7sus4',
  sus27: '7sus2',
  add9: 'add9',
  minadd9: 'm(add9)',
  dom9: '9',
  maj9: 'maj9',
  min9: 'm9',
  dom11: '11',
  min11: 'm11',
  dom13: '13',
  maj13: 'maj13',
  min13: 'm13',
  dom7b5: '7♭5',
  dom7s5: '7♯5',
  dom7b9: '7♭9',
  dom7s9: '7♯9',
  dom7s11: '7♯11',
  dom7b13: '7♭13',
};

const ACC_TEXT: Record<number, string> = { [-2]: '𝄫', [-1]: '♭', 0: '', 1: '♯', 2: '𝄪' };

export function chordSymbolText(
  root: { step: string; alter: number },
  quality: string,
  bass?: { step: string; alter: number },
): string {
  const r = `${root.step}${ACC_TEXT[root.alter] ?? ''}`;
  const b = bass ? `/${bass.step}${ACC_TEXT[bass.alter] ?? ''}` : '';
  return `${r}${CHORD_SUFFIX[quality] ?? quality}${b}`;
}

function buildSystem(
  doc: ScoreDoc,
  staves: readonly StaffInfo[],
  notation: NMeasure[][],
  columns: Column[],
  plan: SystemPlan,
  sIndex: number,
  stretch: number,
  sysX: number,
  opts: LayoutOptions,
  prefixes: number[],
  header: number,
  indent: number,
): Built {
  const infos = measureInfos(doc);
  const staffGraphics: Graphic[][] = staves.map(() => []);
  const measures: (Omit<MeasureGeometry, 'segments'> & { segments: SegmentGeometry[] })[] = [];
  const first = plan.first;
  // header
  const timeShown = first === 0 || infos[first]!.timeSigChange;
  let timeX = sysX;
  staves.forEach((_s, k) => {
    const nm = notation[k]![first]!;
    const gs = staffGraphics[k]!;
    gs.push(drawClef(nm.clef, sysX + STYLE.clefPadLeft));
    const keyGlyphs = keySignatureGlyphs(nm.key, nm.clef);
    const kx = sysX + STYLE.clefPadLeft + clefWidth(nm.clef) + STYLE.keySigPad;
    gs.push(...drawKeySignature(keyGlyphs, kx));
    timeX = Math.max(timeX, kx + keySignatureWidth(keyGlyphs));
  });
  if (timeShown) {
    staves.forEach((_s, k) =>
      staffGraphics[k]!.push(
        ...drawTimeSignature(
          infos[first]!.timeSig,
          timeX + STYLE.timeSigPad - STYLE.keySigPad + 0.3,
        ),
      ),
    );
  }

  // measures
  let x = sysX + header;
  const sysChords: SystemChord[] = [];
  const sysDynamics: SystemDynamic[] = [];
  const measureCtx: {
    info: (typeof infos)[number];
    segs: SegmentGeometry[];
    startX: number;
    endX: number;
  }[] = [];
  const pendingTies: Map<string, { x: number; y: number; dir: 1 | -1 }>[] = staves.map(
    () => new Map(),
  );
  const halfTieStart = sysX + header - 0.8;
  for (let i = plan.first; i <= plan.last; i++) {
    const info = infos[i]!;
    const col = columns[i]!;
    const prefix = i === plan.first ? 0 : prefixes[i]!;
    const startX = x;
    // prefix: clef / key / time changes
    if (prefix > 0) {
      let px = startX + 0.5;
      let maxPx = px;
      staves.forEach((_s, k) => {
        const nm = notation[k]![i]!;
        const prevNm = notation[k]![i - 1]!;
        let cx = px;
        const prevClef = prevNm.clefChanges.length
          ? prevNm.clefChanges[prevNm.clefChanges.length - 1]!.clef
          : prevNm.clef;
        if (nm.clef !== prevClef) {
          staffGraphics[k]!.push(drawClef(nm.clef, cx, CHANGE_CLEF_SCALE, 'clef change'));
          cx += clefWidth(nm.clef, CHANGE_CLEF_SCALE) + 0.5;
        }
        if (info.keySigChange) {
          const glyphs = keySignatureGlyphs(nm.key, nm.clef, prevNm.key);
          staffGraphics[k]!.push(...drawKeySignature(glyphs, cx));
          cx += keySignatureWidth(glyphs) + STYLE.keySigPad;
        }
        maxPx = Math.max(maxPx, cx);
      });
      px = maxPx;
      if (info.timeSigChange) {
        staves.forEach((_s, k) => staffGraphics[k]!.push(...drawTimeSignature(info.timeSig, px)));
      }
    }
    const contentX = startX + prefix;
    const width = columnWidth(col, stretch);
    const endX = contentX + width;
    const rel = segmentPositions(col, stretch);
    const segs: SegmentGeometry[] = col.segments.map((s, k) => ({
      offset: s.offset,
      x: contentX + rel[k]!,
    }));
    measures.push({
      measureId: info.measure.id,
      index: i,
      x: startX,
      width: endX - startX,
      contentX,
      segments: segs,
      length: info.length,
    });

    // items
    const firstGraphic = staffGraphics.map((gs) => gs.length);
    const placedChords: { staff: number; p: PlacedChord }[] = [];
    col.segments.forEach((seg, k) => {
      const sx = segs[k]!.x;
      for (const ci of seg.items) {
        if (ci.item.kind === 'chord' && ci.geom.kind === 'chord') {
          placedChords.push({ staff: ci.staff, p: { chord: ci.item, geom: ci.geom, x: sx } });
        } else if (ci.item.kind === 'rest' && ci.geom.kind === 'rest') {
          staffGraphics[ci.staff]!.push(drawRest(ci.item, ci.geom, sx));
        }
      }
    });
    for (const fr of col.fullRests) {
      if (fr.item.kind !== 'rest' || fr.geom.kind !== 'rest') continue;
      const w = glyphWidth(fr.geom.glyph);
      const cx = (contentX + 0.5 + endX - 0.5) / 2 - w / 2;
      staffGraphics[fr.staff]!.push(drawRest(fr.item, fr.geom, cx));
    }
    // beams (adjust stems first)
    const groups = new Map<string, PlacedChord[]>();
    for (const { staff, p } of placedChords) {
      if (p.chord.beam === null) continue;
      const key = `${staff}:${p.chord.voice}:${p.chord.beam}`;
      const g = groups.get(key) ?? [];
      g.push(p);
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      const staff = Number(key.split(':')[0]);
      g.sort((a, b) => a.x - b.x);
      staffGraphics[staff]!.push(...beamGroup(g));
    }
    // chords and ties
    for (const { staff, p } of placedChords.sort((a, b) => a.p.x - b.p.x)) {
      staffGraphics[staff]!.push(drawChord(p));
      const nm = notation[staff]![i]!;
      const sorted = [...p.geom.noteheads].sort((a, b) => a.position - b.position);
      sorted.forEach((h, idx) => {
        const note = p.chord.notes.find((n) => n.noteId === h.noteId)!;
        let dir: 1 | -1;
        if (sorted.length === 1)
          dir = nm.multiVoice ? (p.chord.voice % 2 === 0 ? -1 : 1) : p.chord.stem === 'up' ? 1 : -1;
        else dir = idx < sorted.length / 2 ? -1 : 1;
        // sounding pitch: a tie into or out of an octave line joins notes written an octave apart
        const key = `${p.chord.voice}:${note.concert.step}${note.concert.alter}${note.concert.octave}`;
        const nx = p.x + h.x;
        const nw = p.geom.noteheadWidth;
        if (note.tiedFromPrev) {
          const from = pendingTies[staff]!.get(key);
          const ty = h.y + dir * 0.45;
          if (from) {
            staffGraphics[staff]!.push(drawTie(from.x, from.y, nx + 0.15, ty, from.dir));
            pendingTies[staff]!.delete(key);
          } else if (i === plan.first) {
            staffGraphics[staff]!.push(
              drawTie(Math.min(halfTieStart, nx - 1.5), ty, nx + 0.15, ty, dir),
            );
          }
        }
        if (note.tieToNext) {
          pendingTies[staff]!.set(key, { x: nx + nw - 0.15, y: h.y + dir * 0.45, dir });
        }
      });
    }
    // skyline of what has been drawn in this measure, per staff (for tuplets)
    const boxes = staffGraphics.map((gs, k) => gs.slice(firstGraphic[k]).map((g) => extentOf([g])));
    const topAt = (k: number, x0: number, x1: number, base: number) => {
      let y = base;
      for (const b of boxes[k]!) if (b.maxX >= x0 && b.minX <= x1 && b.minY < y) y = b.minY;
      return y;
    };
    const bottomAt = (k: number, x0: number, x1: number, base: number) => {
      let y = base;
      for (const b of boxes[k]!) if (b.maxX >= x0 && b.minX <= x1 && b.maxY > y) y = b.maxY;
      return y;
    };
    staves.forEach((_s, k) => {
      const nm = notation[k]![i]!;
      // tuplets: number (and bracket when not exactly beamed) on the stem side
      for (const t of nm.tuplets) {
        const voice = nm.voices.find((v) => v.voice === t.voice);
        if (!voice) continue;
        const inside = voice.items.filter((it) => it.tuplet?.id === t.id);
        if (!inside.length) continue;
        const chords = placedChords
          .filter((pc) => pc.staff === k && pc.p.chord.tuplet?.id === t.id)
          .map((pc) => pc.p);
        const xs = inside.map((it) => xAtOffset(segs, info.length, endX, it.offset));
        const x1 = Math.min(...xs) - 0.2;
        const x2 = Math.max(...xs) + 1.4;
        const up = chords.length
          ? chords.filter((c) => c.chord.stem === 'up').length >= chords.length / 2
          : true;
        const beamed =
          chords.length === inside.length &&
          chords.length > 1 &&
          chords.every((c) => c.chord.beam !== null && c.chord.beam === chords[0]!.chord.beam);
        let yy: number;
        if (beamed) {
          const tips = chords.map((c) => c.geom.stem?.yTip ?? 2);
          yy = up ? Math.min(...tips) - 1.0 : Math.max(...tips) + 1.0;
        } else {
          yy = up
            ? Math.min(-0.8, topAt(k, x1, x2, 0) - 0.9)
            : Math.max(4.8, bottomAt(k, x1, x2, 4) + 0.9);
        }
        staffGraphics[k]!.push(...drawTupletMark(t.actual, x1, x2, yy, up, !beamed));
      }
      // dynamics are placed with the hairpins once the whole system is known
      for (const d of nm.dynamics) {
        sysDynamics.push({
          staff: k,
          x: xAtOffset(segs, info.length, endX, d.offset),
          t: add(info.start, d.offset),
          mark: d,
        });
      }
    });
    for (const pc of placedChords)
      sysChords.push({ ...pc, t: add(info.start, pc.p.chord.offset), measure: i });
    measureCtx.push({ info, segs, startX, endX });
    x = endX;
  }
  const systemEnd = x;
  // unresolved ties run to the end of the system
  pendingTies.forEach((map, k) => {
    for (const t of map.values())
      staffGraphics[k]!.push(drawTie(t.x, t.y, Math.max(t.x + 1.5, systemEnd - 0.3), t.y, t.dir));
  });

  // ---- system-wide skyline, spanners, dynamics, texts
  const sky = staffGraphics.map((gs) => gs.map((g) => ({ g, e: extentOf([g]) })));
  const push = (k: number, g: Graphic) => {
    staffGraphics[k]!.push(g);
    sky[k]!.push({ g, e: extentOf([g]) });
  };
  const skyTop = (k: number, x0: number, x1: number, base: number) => {
    let yy = base;
    for (const { e } of sky[k]!) if (e.maxX >= x0 && e.minX <= x1 && e.minY < yy) yy = e.minY;
    return yy;
  };
  const skyBottom = (k: number, x0: number, x1: number, base: number) => {
    let yy = base;
    for (const { e } of sky[k]!) if (e.maxX >= x0 && e.minX <= x1 && e.maxY > yy) yy = e.maxY;
    return yy;
  };
  drawSystemSpanners({
    doc,
    staves,
    notation,
    infos,
    measures,
    chords: sysChords,
    dynamics: sysDynamics,
    systemEnd,
    push,
    skyTop,
    skyBottom,
    sky,
  });

  // texts above the top staff, stacked clear of the notes: chord symbols, then tempo/rehearsal
  for (const { info, segs, startX, endX } of measureCtx) {
    const top = (g: Graphic) => push(0, g);
    let ceiling = 0;
    for (const c of doc.harmony) {
      if (c.measureId !== info.measure.id) continue;
      const cx = xAtOffset(segs, info.length, endX, c.offset);
      const text = chordSymbolText(c.root, c.quality, c.bass);
      const w = opts.measureText(text, STYLE.chordSymbolSize, 'sans');
      const baseline = Math.min(-1.6, skyTop(0, cx - 0.3, cx + w, 0) - 0.9);
      ceiling = Math.min(ceiling, baseline - STYLE.chordSymbolSize * 0.8);
      top({
        kind: 'text',
        x: cx,
        y: baseline,
        text,
        size: STYLE.chordSymbolSize,
        family: 'sans',
        // unaccepted AI suggestions are drawn like ghost notes
        cls: c.source?.kind === 'ai' && !c.source.accepted ? 'chord-symbol ghost' : 'chord-symbol',
        ref: `ch:${c.id}`,
      });
    }
    for (const t of info.measure.tempo ?? []) {
      const tx = xAtOffset(segs, info.length, endX, t.offset);
      const label = `= ${t.bpm}`;
      const ty = Math.min(-2.6, skyTop(0, tx - 0.5, tx + 7, 0) - 1.2, ceiling - 0.6);
      top({
        kind: 'glyph',
        name: 'metNoteQuarterUp',
        x: tx,
        y: ty,
        scale: 0.75,
        cls: 'tempo',
      });
      top({
        kind: 'text',
        x: tx + 1.35,
        y: ty,
        text: label,
        size: STYLE.tempoSize * 0.85,
        family: 'serif',
        cls: 'tempo',
      });
      if (t.text) {
        top({
          kind: 'text',
          x: tx,
          y: ty - 2.6,
          text: t.text,
          size: STYLE.tempoSize,
          family: 'serif',
          weight: 'bold',
          cls: 'tempo-text',
        });
      }
    }
    if (info.measure.rehearsalMark) {
      const text = info.measure.rehearsalMark;
      const w = opts.measureText(text, 2.0, 'sans', 'bold') + 0.8;
      const boxBottom = Math.min(-1.2, skyTop(0, startX - 0.2, startX + w, 0) - 0.8, ceiling - 0.4);
      top({
        kind: 'rect',
        x: startX - 0.2,
        y: boxBottom - 2.6,
        w,
        h: 2.6,
        stroke: 0.16,
        cls: 'rehearsal-box',
      });
      top({
        kind: 'text',
        x: startX - 0.2 + w / 2,
        y: boxBottom - 0.65,
        text,
        size: 2.0,
        family: 'sans',
        weight: 'bold',
        anchor: 'middle',
        cls: 'rehearsal',
      });
    }
  }
  // staff lines
  staves.forEach((s, k) => {
    const lines = s.staff.lines;
    for (let l = 0; l < lines; l++) {
      const ly = lines === 1 ? 2 : l;
      staffGraphics[k]!.unshift({
        kind: 'line',
        x1: sysX,
        y1: ly,
        x2: systemEnd,
        y2: ly,
        width: STYLE.staffLineWidth,
        cls: 'staff-line',
      });
    }
  });
  // measure numbers
  if (opts.measureNumbers && sIndex > 0 && opts.mode !== 'continuous') {
    const number = measureNumber(doc, plan.first);
    staffGraphics[0]!.push({
      kind: 'text',
      x: sysX + 0.2,
      y: -2.0,
      text: String(number),
      size: STYLE.measureNumberSize,
      family: 'serif',
      italic: true,
      cls: 'measure-number',
    });
  }

  const systemGraphics = (staffY: number[]): Graphic[] => {
    const out: Graphic[] = [];
    const topY = staffY[0]!;
    const bottomOf = (k: number) => staffY[k]! + (staves[k]!.staff.lines === 1 ? 2 : 4);
    const topOf = (k: number) => staffY[k]! + (staves[k]!.staff.lines === 1 ? 2 : 0);
    const lastK = staves.length - 1;
    // barline segments: runs of staves joined by barlineThrough groups
    const order = staves.map((s) => s.staff.id);
    const joined = new Array<boolean>(staves.length).fill(false); // joined[k]: barline continues from k to k+1
    for (const g of doc.groups) {
      if (!g.barlineThrough) continue;
      const a = order.indexOf(g.firstStaff);
      const b = order.indexOf(g.lastStaff);
      for (let k = a; k < b; k++) if (k >= 0) joined[k] = true;
    }
    const runs: [number, number][] = [];
    let start = 0;
    for (let k = 0; k < staves.length; k++) {
      if (!joined[k] || k === lastK) {
        runs.push([start, k]);
        start = k + 1;
      }
    }
    const barline = (bx: number, style: string, kind: 'end' | 'start' = 'end') => {
      for (const [a, b] of runs) {
        const y1 = topOf(a);
        const y2 = bottomOf(b);
        const thin = (xx: number) =>
          out.push({
            kind: 'line',
            x1: xx,
            y1,
            x2: xx,
            y2,
            width: STYLE.thinBarline,
            cls: 'barline',
          });
        const thick = (xx: number) =>
          out.push({
            kind: 'line',
            x1: xx,
            y1,
            x2: xx,
            y2,
            width: STYLE.thickBarline,
            cls: 'barline',
          });
        if (style === 'final') {
          thick(bx - STYLE.thickBarline / 2);
          thin(bx - STYLE.thickBarline - STYLE.barlineSeparation);
        } else if (style === 'double') {
          thin(bx);
          thin(bx - STYLE.barlineSeparation - STYLE.thinBarline);
        } else if (style === 'repeatEnd') {
          thick(bx - STYLE.thickBarline / 2);
          thin(bx - STYLE.thickBarline - STYLE.barlineSeparation);
          for (let k = a; k <= b; k++) {
            const dx = bx - STYLE.thickBarline - STYLE.barlineSeparation - 0.6;
            out.push(
              { kind: 'glyph', name: 'repeatDot', x: dx, y: staffY[k]! + 1.5, cls: 'barline' },
              { kind: 'glyph', name: 'repeatDot', x: dx, y: staffY[k]! + 2.5, cls: 'barline' },
            );
          }
        } else if (style === 'repeatStart' && kind === 'start') {
          thick(bx + STYLE.thickBarline / 2);
          thin(bx + STYLE.thickBarline + STYLE.barlineSeparation);
          for (let k = a; k <= b; k++) {
            const dx = bx + STYLE.thickBarline + STYLE.barlineSeparation + 0.35;
            out.push(
              { kind: 'glyph', name: 'repeatDot', x: dx, y: staffY[k]! + 1.5, cls: 'barline' },
              { kind: 'glyph', name: 'repeatDot', x: dx, y: staffY[k]! + 2.5, cls: 'barline' },
            );
          }
        } else if (style === 'dashed') {
          out.push({
            kind: 'line',
            x1: bx,
            y1,
            x2: bx,
            y2,
            width: STYLE.thinBarline,
            dash: [0.5, 0.25],
            cls: 'barline',
          });
        } else if (style !== 'none') {
          thin(bx);
        }
      }
    };
    // system start line
    if (staves.length > 1)
      out.push({
        kind: 'line',
        x1: sysX,
        y1: topY,
        x2: sysX,
        y2: bottomOf(lastK),
        width: STYLE.thinBarline,
        cls: 'barline',
      });
    for (const mg of measures) {
      const meas = infos[mg.index]!.measure;
      if (meas.repeatStart)
        barline(mg.x + (mg.index === plan.first ? 0 : 0.2), 'repeatStart', 'start');
      const style = meas.repeatEnd ? 'repeatEnd' : (meas.barline ?? 'single');
      barline(mg.x + mg.width, style);
    }
    // brackets and braces
    for (const g of doc.groups) {
      const a = order.indexOf(g.firstStaff);
      const b = order.indexOf(g.lastStaff);
      if (a < 0 || b < 0) continue;
      const y1 = topOf(a);
      const y2 = bottomOf(b);
      if (g.kind === 'brace') {
        const h = y2 - y1;
        const scale = h / 3.988;
        const bw = glyphBox('brace', scale).width;
        out.push({ kind: 'glyph', name: 'brace', x: sysX - 0.35 - bw, y: y2, scale, cls: 'brace' });
      } else {
        const bx = sysX - (hasBraceIn(doc) ? 1.6 : 0.9);
        out.push({
          kind: 'line',
          x1: bx,
          y1: y1 - 0.2,
          x2: bx,
          y2: y2 + 0.2,
          width: STYLE.thickBarline,
          cls: 'bracket',
        });
        out.push({
          kind: 'glyph',
          name: 'bracketTop',
          x: bx - STYLE.thickBarline / 2,
          y: y1 - 0.2,
          cls: 'bracket',
        });
        out.push({
          kind: 'glyph',
          name: 'bracketBottom',
          x: bx - STYLE.thickBarline / 2,
          y: y2 + 0.2,
          cls: 'bracket',
        });
      }
    }
    // instrument names
    const showNames = doc.parts.length > 1 || doc.parts.some((p) => p.staves.length === 1);
    if (showNames && indent > 0) {
      const nameX = sysX - bracketSpaceOf(doc) - 0.2;
      doc.parts.forEach((part) => {
        const ks = staves.map((s, k) => (s.part.id === part.id ? k : -1)).filter((k) => k >= 0);
        if (!ks.length) return;
        const cy =
          (topOf(ks[0]!) + bottomOf(ks[ks.length - 1]!)) / 2 + STYLE.instrumentNameSize * 0.3;
        const text = sIndex === 0 ? part.name : part.abbreviation;
        out.push({
          kind: 'text',
          x: nameX,
          y: cy,
          text,
          size: STYLE.instrumentNameSize,
          family: 'serif',
          anchor: 'end',
          cls: 'instrument-name',
          ref: `pt:${part.id}`,
        });
      });
    }
    return out;
  };

  return { staffGraphics, systemGraphics, measures, width: systemEnd - sysX };
}

function hasBraceIn(doc: ScoreDoc): boolean {
  return doc.groups.some((g) => g.kind === 'brace');
}

function bracketSpaceOf(doc: ScoreDoc): number {
  const hasBrace = doc.groups.some((g) => g.kind === 'brace');
  const hasBracket = doc.groups.some((g) => g.kind === 'bracket' || g.kind === 'square');
  return (hasBrace ? 1.3 : 0) + (hasBracket ? 1.5 : 0) + 0.4;
}

/** Bar number as printed: a pickup bar counts as 0. */
export function measureNumber(doc: ScoreDoc, index: number): number {
  const first = measureInfos(doc)[0];
  const isPickup =
    !!first?.measure.actualLength &&
    lt(first.measure.actualLength, nominalLength(first.timeSig.beats, first.timeSig.beatType));
  return isPickup ? index : index + 1;
}

function nominalLength(beats: number, beatType: number): Rational {
  return { n: beats, d: beatType };
}

/** Exposed for tools: key name for titles etc. */
export function keyName(key: KeySignature): string {
  const t = keyTonic(key);
  return `${t.step}${t.alter > 0 ? '♯' : t.alter < 0 ? '♭' : ''} ${key.mode === 'minor' ? 'minor' : 'major'}`;
}

/** For the editor: instrument definition lookup without importing the catalog everywhere. */
export const instrumentOf = (id: string) => findInstrument(id);
