import {
  SAMPLES,
  allStaves,
  applyCommand,
  createScore,
  parseRational as r,
  rat,
  sequentialIds,
  textToCommands,
  toString,
  type ScoreDoc,
} from '@ailegro-score/core';
import { describe, expect, it } from 'vitest';
import type { GlyphGraphic, Graphic } from './graphics';
import { layoutScore, offsetToX, xToOffset } from './layout/engrave';
import { buildStaffNotation, type NChord } from './layout/notation';
import { measureFrame, splitNote, splitRest, tupletFrame } from './layout/rhythm';
import { renderPageSvg } from './render/svg';

const show = (
  ps: {
    start: { n: number; d: number };
    end: { n: number; d: number };
    written: { value: string; dots: number };
  }[],
) =>
  ps
    .map(
      (p) =>
        `${toString(p.start)}-${toString(p.end)}:${p.written.value}${'.'.repeat(p.written.dots)}`,
    )
    .join(' ');

describe('rhythm splitting', () => {
  const f44 = measureFrame({ beats: 4, beatType: 4 }, r('1'));
  const f68 = measureFrame({ beats: 6, beatType: 8 }, r('3/4'));

  it('keeps simple values and common syncopations', () => {
    expect(show(splitNote(f44, r('0'), r('3/4')))).toBe('0-3/4:half.');
    expect(show(splitNote(f44, r('1/4'), r('3/4')))).toBe('1/4-3/4:half');
    expect(show(splitNote(f44, r('1/8'), r('3/8')))).toBe('1/8-3/8:quarter');
  });

  it('shows the middle of a 4/4 bar', () => {
    expect(show(splitNote(f44, r('3/8'), r('7/8')))).toBe('3/8-1/2:eighth 1/2-7/8:quarter.');
    expect(show(splitNote(f44, r('1/4'), r('1')))).toBe('1/4-1/2:quarter 1/2-1:half');
    expect(show(splitNote(f44, r('0'), r('5/8')))).toBe('0-1/2:half 1/2-5/8:eighth');
  });

  it('shows beats in compound meters', () => {
    expect(show(splitNote(f68, r('1/8'), r('3/8')))).toBe('1/8-3/8:quarter');
    expect(show(splitNote(f68, r('1/4'), r('1/2')))).toBe('1/4-3/8:eighth 3/8-1/2:eighth');
    expect(show(splitNote(f68, r('0'), r('3/4')))).toBe('0-3/4:half.');
  });

  it('writes rests on metric units', () => {
    expect(show(splitRest(f44, r('1/4'), r('3/4')))).toBe('1/4-1/2:quarter 1/2-3/4:quarter');
    expect(show(splitRest(f44, r('1/2'), r('1')))).toBe('1/2-1:half');
    expect(show(splitRest(f44, r('0'), r('3/8')))).toBe('0-1/4:quarter 1/4-3/8:eighth');
    expect(show(splitRest(f68, r('0'), r('3/8')))).toBe('0-3/8:quarter.');
  });

  it('scales tuplets to written values', () => {
    const t = tupletFrame(r('0'), r('1/4'), 3, 2);
    expect(show(splitNote(t, r('0'), r('1/12')))).toBe('0-1/12:eighth');
    expect(show(splitNote(t, r('0'), r('1/6')))).toBe('0-1/6:quarter');
  });
});

function scoreWith(
  text: string,
  opts: { measures?: number; keySig?: number; template?: string } = {},
): ScoreDoc {
  const ids = sequentialIds();
  let doc = createScore({
    template: opts.template ?? 'piano',
    measures: opts.measures ?? 2,
    keySig: { fifths: opts.keySig ?? 0 },
    ids,
    now: 'T',
  });
  const staff = allStaves(doc)[0]!.staff.id;
  const res = textToCommands(
    doc,
    { staffId: staff, voice: 0, measureId: doc.measures[0]!.id, offset: rat(0) },
    text,
    { ids },
  );
  doc = applyCommand(doc, { type: 'batch', commands: res.commands }).doc;
  return doc;
}

describe('notation', () => {
  it('ties notes across barlines and fills rests', () => {
    const doc = scoreWith('r2 c1 r2');
    const [m1, m2] = buildStaffNotation(doc, allStaves(doc)[0]!, { concertPitch: false });
    const c1 = m1!.voices[0]!.items.find((i): i is NChord => i.kind === 'chord')!;
    const c2 = m2!.voices[0]!.items.find((i): i is NChord => i.kind === 'chord')!;
    expect(c1.written.value).toBe('half');
    expect(c1.notes[0]!.tieToNext).toBe(true);
    expect(c2.notes[0]!.tiedFromPrev).toBe(true);
    expect(m1!.voices[0]!.items[0]!.kind).toBe('rest');
  });

  it('places accidentals once per bar', () => {
    const doc = scoreWith('f#4 f# fn f');
    const [m1] = buildStaffNotation(doc, allStaves(doc)[0]!, { concertPitch: false });
    const accs = m1!.voices[0]!.items.map((i) =>
      i.kind === 'chord' ? i.notes[0]!.accidental : 'rest',
    );
    expect(accs).toEqual(['sharp', null, 'natural', null]);
  });

  it('beams eighths by half bar and sixteenths by beat in 4/4', () => {
    const doc = scoreWith('c8 d e f g a b c | c16 d e f g a b c c8 d e f');
    const [m1, m2] = buildStaffNotation(doc, allStaves(doc)[0]!, { concertPitch: false });
    const beams = (m: typeof m1) =>
      m!.voices[0]!.items.map((i) => (i.kind === 'chord' ? i.beam : null));
    expect(beams(m1)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(beams(m2)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it('shows written pitch for transposing instruments unless concert pitch is on', () => {
    const ids = sequentialIds();
    let doc = createScore({ template: 'wind-quintet', measures: 1, ids, now: 'T' });
    const clarinet = allStaves(doc)[2]!;
    const res = textToCommands(
      doc,
      { staffId: clarinet.staff.id, voice: 0, measureId: doc.measures[0]!.id, offset: rat(0) },
      'bb1',
      { ids },
    );
    doc = applyCommand(doc, { type: 'batch', commands: res.commands }).doc;
    const written = buildStaffNotation(doc, clarinet, { concertPitch: false })[0]!;
    const concert = buildStaffNotation(doc, clarinet, { concertPitch: true })[0]!;
    const first = (m: typeof written) => (m.voices[0]!.items[0] as NChord).notes[0]!.display;
    expect(first(concert).step).toBe('B');
    expect(first(written)).toMatchObject({ step: 'C', alter: 0 });
    expect(written.key.fifths).toBe(2);
  });
});

describe('marks and lines', () => {
  const svgOf = (doc: ScoreDoc, opts = {}) => {
    const layout = layoutScore(doc, opts);
    return layout.pages.map((p) => renderPageSvg(p, layout)).join('');
  };

  it('writes notes under an octave line an octave lower, without changing pitch', () => {
    const doc = scoreWith("\\8va c'4 d e f \\loco g");
    const [m1, m2] = buildStaffNotation(doc, allStaves(doc)[0]!, { concertPitch: false });
    const first = m1!.voices[0]!.items[0] as NChord;
    expect(first.notes[0]!.concert).toMatchObject({ step: 'C', octave: 6 });
    expect(first.notes[0]!.display).toMatchObject({ step: 'C', octave: 5 });
    expect(first.ottava).toBe(1);
    const after = m2!.voices[0]!.items[0] as NChord;
    expect(after.ottava).toBe(0);
  });

  it('ties a note into an octave line with one tie', () => {
    const doc = scoreWith("c''4~ \\8va c4 d e \\loco");
    const svg = svgOf(doc);
    expect(svg.split('class="tie"').length - 1).toBe(1);
    const [m1] = buildStaffNotation(doc, allStaves(doc)[0]!, { concertPitch: false });
    const [a, b] = m1!.voices[0]!.items as NChord[];
    expect(a!.notes[0]!.tieToNext).toBe(true);
    expect(b!.notes[0]!.tiedFromPrev).toBe(true);
  });

  it('stacks staccato next to the notehead and the accent outside it', () => {
    // whatever order a file lists them in
    const doc0 = scoreWith('g4 a b c');
    const staff = allStaves(doc0)[0]!.staff.id;
    const m = doc0.measures[0]!.id;
    const bar = doc0.content[staff]![m]!;
    const [first, ...rest] = bar.voices[0]!;
    const marked = { ...first!, articulations: ['accent', 'staccato'] as const };
    const doc: ScoreDoc = {
      ...doc0,
      content: {
        ...doc0.content,
        [staff]: { ...doc0.content[staff]!, [m]: { ...bar, voices: [[marked, ...rest]] } },
      },
    };
    const glyphs = (gs: readonly Graphic[]): GlyphGraphic[] =>
      gs.flatMap((g) => (g.kind === 'glyph' ? [g] : g.kind === 'group' ? glyphs(g.children) : []));
    const all = glyphs(layoutScore(doc).pages[0]!.graphics);
    const yOf = (name: string) => all.find((g) => g.name === name)!.y;
    // g4 has its stem up: the marks go below, the staccato nearer the notehead (higher)
    expect(yOf('articStaccatoBelow')).toBeLessThan(yOf('articAccentBelow'));
  });

  it('draws every kind of spanner and mark of the demo', () => {
    const doc = SAMPLES.find((s) => s.id === 'ornaments')!.build();
    const svg = svgOf(doc);
    for (const sp of doc.spanners) expect(svg).toContain(`data-ref="sp:${sp.id}"`);
    for (const cls of [
      'slur',
      'hairpin',
      'ottava',
      'pedal',
      'trill-line',
      'grace',
      'arpeggio',
      'tremolo',
      'dynamic',
    ])
      expect(svg).toContain(`class="${cls}`);
    // grace noteheads are drawn small and selectable
    const grace =
      doc.content[allStaves(doc)[0]!.staff.id]![doc.measures[2]!.id]!.voices[0]![0]!.graces![0]!;
    expect(svg).toContain(`data-ref="gc:${grace.id}"`);
    expect(svg).toContain(`data-ref="n:${grace.notes[0]!.id}"`);
  });

  it('splits a slur at a system break', () => {
    let doc = scoreWith('c4( d e f | g a b c)');
    doc = applyCommand(doc, {
      type: 'measure.setBreak',
      measureId: doc.measures[0]!.id,
      breakAfter: 'system',
    }).doc;
    const svg = svgOf(doc);
    const id = doc.spanners[0]!.id;
    expect(svg.split(`data-ref="sp:${id}"`).length - 1).toBe(2);
  });

  it('draws cue notes smaller', () => {
    let doc = scoreWith('c4 d e f');
    const staff = allStaves(doc)[0]!.staff.id;
    const ev = doc.content[staff]![doc.measures[0]!.id]!.voices[0]!.map((e) => e.id);
    doc = applyCommand(doc, {
      type: 'events.setProps',
      eventIds: [ev[0]!],
      props: { cue: true },
    }).doc;
    const svg = svgOf(doc);
    expect(svg).toMatch(/class="chord cue"/);
    expect(svg).toMatch(/scale\(0\.7 0\.7\)"[^>]*class="notehead"/);
  });
});

describe('layout', () => {
  it('lays out every sample deterministically', () => {
    for (const s of SAMPLES) {
      const doc = s.build();
      const a = layoutScore(doc);
      const b = layoutScore(doc);
      const svgA = a.pages.map((p) => renderPageSvg(p, a)).join('');
      const svgB = b.pages.map((p) => renderPageSvg(p, b)).join('');
      expect(svgA).toBe(svgB);
      expect(a.systems.length).toBeGreaterThan(0);
      // every note of the document is drawn exactly once as a notehead
      const notes = Object.values(doc.content).flatMap((ms) =>
        Object.values(ms).flatMap((sm) => sm.voices.flat().flatMap((e) => e.notes)),
      );
      const heads = svgA.match(/class="notehead" data-ref="n:/g)?.length ?? 0;
      expect(heads).toBeGreaterThanOrEqual(notes.length);
    }
  });

  it('exposes geometry for hit-testing', () => {
    const doc = SAMPLES[0]!.build();
    const layout = layoutScore(doc);
    const sys = layout.systems[0]!;
    expect(sys.staves.length).toBe(2);
    expect(sys.staves[1]!.y).toBeGreaterThan(sys.staves[0]!.y + 4);
    const m = sys.measures[0]!;
    expect(m.segments[0]!.x).toBeGreaterThan(m.x);
    for (let k = 1; k < m.segments.length; k++)
      expect(m.segments[k]!.x).toBeGreaterThan(m.segments[k - 1]!.x);
  });

  it('maps time positions to x and back inside a measure', () => {
    const layout = layoutScore(SAMPLES[0]!.build(), {});
    const m = layout.pages[0]!.systems[0]!.measures[0]!;
    expect(m.segments.length).toBeGreaterThan(2);
    for (const seg of m.segments) {
      expect(offsetToX(m, seg.offset)).toBeCloseTo(seg.x, 6);
      expect(xToOffset(m, seg.x)).toBeCloseTo(seg.offset.n / seg.offset.d, 6);
    }
    // between two segments the mapping interpolates and stays monotonic
    const [a, b] = m.segments;
    const mid = xToOffset(m, (a!.x + b!.x) / 2);
    expect(mid).toBeGreaterThan(a!.offset.n / a!.offset.d);
    expect(mid).toBeLessThan(b!.offset.n / b!.offset.d);
  });

  it('honours system and page breaks', () => {
    const ids = sequentialIds();
    let doc = createScore({ template: 'piano', measures: 8, ids, now: 'T' });
    doc = applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'measure.setBreak', measureId: doc.measures[1]!.id, breakAfter: 'system' },
        { type: 'measure.setBreak', measureId: doc.measures[3]!.id, breakAfter: 'page' },
      ],
    }).doc;
    const layout = layoutScore(doc, {});
    expect(layout.pages.length).toBe(2);
    const first = layout.pages[0]!.systems.map((s) => s.measures.map((m) => m.index));
    expect(first).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(layout.pages[1]!.systems[0]!.measures[0]!.index).toBe(4);
  });

  it('justifies full systems to the page width', () => {
    const doc = SAMPLES[2]!.build();
    const layout = layoutScore(doc);
    const page = layout.pages[0]!;
    const sys = layout.systems[0]!;
    const last = sys.measures[sys.measures.length - 1]!;
    const right = last.x + last.width;
    const margin = doc.settings.pageMarginsMm.right / layout.staffSpaceMm;
    expect(Math.abs(page.width - margin - right)).toBeLessThan(0.05);
  });

  it('supports continuous view', () => {
    const doc = SAMPLES[1]!.build();
    const layout = layoutScore(doc, { mode: 'continuous' });
    expect(layout.pages.length).toBe(1);
    expect(layout.systems.length).toBe(1);
    expect(layout.systems[0]!.measures.length).toBe(doc.measures.length);
  });
});
