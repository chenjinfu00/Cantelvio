/**
 * The score canvas: engraves the document, shows pages as SVG, and turns pointer input into
 * selections or (in note-input mode) notes. Overlays draw the input cursor, the range selection,
 * a shadow note under the pointer and the playback line.
 */
import {
  type Rational,
  type ScoreDoc,
  type ScorePosition,
  allStaves,
  findEventOfNote,
  findGrace,
  findNote,
  lengthOf,
  measureInfos,
  midiOf,
  parseRational,
  rat,
  toNumber,
} from '@ailegro-score/core';
import {
  FONT_STACK,
  type MeasureGeometry,
  type PageLayout,
  type ScoreLayout,
  type SystemGeometry,
  type TextMeasurer,
  layoutScore,
  offsetToX,
  renderPageSvg,
  xToOffset,
} from '@ailegro-score/engraving';
import {
  type ReactElement,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { flushSync } from 'react-dom';
import * as actions from '../state/actions';
import { type Selection, getStore, useEditor } from '../state/store';
import { previewMidi } from '../playback/player';

const PX_PER_MM = 96 / 25.4;
const FLOW_PADDING_PX = 16;

let canvasCtx: CanvasRenderingContext2D | null = null;
const browserMeasure: TextMeasurer = (text, size, family, weight, italic) => {
  canvasCtx ??= document.createElement('canvas').getContext('2d');
  if (!canvasCtx) return text.length * size * 0.5;
  canvasCtx.font = `${italic ? 'italic ' : ''}${weight === 'bold' ? 'bold ' : ''}100px ${FONT_STACK[family]}`;
  return (canvasCtx.measureText(text).width / 100) * size;
};

interface Hit {
  readonly system: SystemGeometry;
  readonly staffIndex: number;
  readonly measure: MeasureGeometry;
  /** Staff position in half spaces from the top line. */
  readonly position: number;
  readonly x: number;
  readonly y: number;
}

function hitTest(page: PageLayout, x: number, y: number): Hit | null {
  for (const system of page.systems) {
    if (y < system.top - 3 || y > system.bottom + 3) continue;
    let best = -1;
    let bestDist = Infinity;
    system.staves.forEach((s, k) => {
      const center = s.y + 2;
      const d = Math.abs(y - center);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    });
    if (best < 0 || bestDist > 9) continue;
    const measure = system.measures.find((m) => x >= m.x && x < m.x + m.width);
    if (!measure) continue;
    const staffY = system.staves[best]!.y;
    return { system, staffIndex: best, measure, position: Math.round((y - staffY) * 2), x, y };
  }
  return null;
}

/** Input position for a click: snap to segments or to the current duration grid. */
function snapOffset(hit: Hit): Rational {
  const m = hit.measure;
  const near = m.segments.find((s) => Math.abs(s.x - hit.x) < 0.9);
  if (near) return near.offset;
  const { value, dots } = getStore().getState().input;
  const grid = lengthOf(value, dots);
  const len = toNumber(m.length);
  const t = Math.max(0, Math.min(len - toNumber(grid), xToOffset(m, hit.x)));
  const k = Math.max(0, Math.floor(t / toNumber(grid) + 1e-6));
  const snapped = rat(grid.n * k, grid.d);
  return toNumber(snapped) < len ? snapped : rat(0);
}

function selectedRefs(doc: ScoreDoc, selection: Selection): string[] {
  if (selection.kind === 'marks')
    return [
      ...selection.spanners.map((id) => `sp:${id}`),
      ...selection.dynamics.map((id) => `dy:${id}`),
    ];
  if (selection.kind === 'notes') {
    const refs = selection.noteIds.map((id) => `n:${id}`);
    const events = new Set<string>();
    for (const id of selection.noteIds) {
      const loc = findEventOfNote(doc, id);
      if (loc && loc.event.notes.every((n) => selection.noteIds.includes(n.id)))
        events.add(loc.event.id);
    }
    return [...refs, ...[...events].map((e) => `e:${e}`)];
  }
  if (selection.kind === 'rest') {
    const a = selection.at;
    return [`rest:${a.staffId}:${a.measureId}:${a.voice}:${a.offset.n}/${a.offset.d}`];
  }
  return [];
}

const PageSvg = memo(function PageSvg({ svg }: { svg: string }) {
  return <div className="page-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
});

export function ScoreView() {
  const doc = useEditor((s) => s.doc);
  const view = useEditor((s) => s.view);
  const selection = useEditor((s) => s.selection);
  const inputActive = useEditor((s) => s.input.active);
  const cursor = useEditor((s) => s.cursor);
  const playhead = useEditor((s) => s.playhead);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ page: number; hit: Hit } | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [printing, setPrinting] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Browser printing always uses paper geometry, including when editing in a flowing view.
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);

  const mode = printing ? 'page' : view.mode;
  const flowWidthMm =
    mode === 'seamless' && viewportWidth > 0
      ? Math.max(40, (viewportWidth - FLOW_PADDING_PX * 2) / (PX_PER_MM * view.zoom))
      : undefined;

  const layout: ScoreLayout = useMemo(
    () =>
      layoutScore(doc, {
        concertPitch: view.concertPitch,
        mode,
        ...(flowWidthMm !== undefined ? { pageWidthMm: flowWidthMm } : {}),
        measureText: browserMeasure,
      }),
    [doc, view.concertPitch, mode, flowWidthMm],
  );
  const svgs = useMemo(
    () =>
      layout.pages.map((p) => renderPageSvg(p, layout, { size: 'none', idPrefix: `p${p.index}-` })),
    [layout],
  );
  const scale = view.zoom * layout.staffSpaceMm * PX_PER_MM;
  // Measure starts depend on the document, not on the animation frame.
  const measureStarts = useMemo(() => measureInfos(doc).map((m) => toNumber(m.start)), [doc]);

  // selection colouring
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    root.querySelectorAll('.sel').forEach((el) => el.classList.remove('sel'));
    for (const ref of selectedRefs(doc, selection)) {
      root
        .querySelectorAll(`[data-ref="${CSS.escape(ref)}"]`)
        .forEach((el) => el.classList.add('sel'));
    }
  }, [doc, selection, svgs]);

  // keep the input cursor in view
  useEffect(() => {
    const el = containerRef.current?.querySelector('.input-cursor');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [cursor, layout]);

  const onPointerDown = (page: PageLayout, e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const store = getStore().getState();
    const extend = e.shiftKey;
    const target = (e.target as Element).closest('[data-ref]');
    const ref = target?.getAttribute('data-ref') ?? '';
    const staves = allStaves(store.doc);
    if (store.input.active && !e.ctrlKey && !e.metaKey) {
      const hit = hitTest(page, x, y);
      if (!hit) return;
      const staff = staves[hit.staffIndex]!;
      const at: ScorePosition = {
        staffId: staff.staff.id,
        voice: store.input.voice,
        measureId: hit.measure.measureId,
        offset: snapOffset(hit),
      };
      const pitch = actions.enterAtPosition(at, hit.position);
      if (pitch)
        void previewMidi(
          [midiOf(pitch)],
          actions.programOf(store.doc, staff.staff.id),
          actions.drumNoteOf(store.doc, staff.staff.id),
        );
      return;
    }
    if (ref.startsWith('n:')) {
      actions.selectNote(ref.slice(2), extend);
      const found = findNote(store.doc, ref.slice(2));
      if (found)
        void previewMidi(
          [midiOf(found.note.pitch)],
          actions.programOf(store.doc, found.loc.staffId),
          actions.drumNoteOf(store.doc, found.loc.staffId),
        );
      return;
    }
    if (ref.startsWith('e:')) {
      const loc = store.doc && findEventByRef(store.doc, ref.slice(2));
      if (loc) store.select({ kind: 'notes', noteIds: loc });
      return;
    }
    if (ref.startsWith('gc:')) {
      const grace = findGrace(store.doc, ref.slice(3));
      if (grace) store.select({ kind: 'notes', noteIds: grace.grace.notes.map((n) => n.id) });
      return;
    }
    if (ref.startsWith('sp:') || ref.startsWith('dy:')) {
      const id = ref.slice(3);
      const isLine = ref.startsWith('sp:');
      const sel = store.selection;
      const prev =
        extend && sel.kind === 'marks'
          ? sel
          : { kind: 'marks' as const, spanners: [], dynamics: [] };
      store.select({
        kind: 'marks',
        spanners: isLine ? [...new Set([...prev.spanners, id])] : prev.spanners,
        dynamics: isLine ? prev.dynamics : [...new Set([...prev.dynamics, id])],
      });
      return;
    }
    if (ref.startsWith('rest:')) {
      const [, staffId, measureId, voice, off] = ref.split(':');
      const at: ScorePosition = {
        staffId: staffId!,
        measureId: measureId!,
        voice: Number(voice),
        offset: parseRational(off!),
      };
      store.select({ kind: 'rest', at });
      return;
    }
    const hit = hitTest(page, x, y);
    if (hit)
      actions.selectMeasure(
        hit.staffIndex,
        measureInfos(store.doc).findIndex((m) => m.measure.id === hit.measure.measureId),
        extend,
      );
    else store.select({ kind: 'none' });
  };

  const onPointerMove = (page: PageLayout, e: ReactPointerEvent<HTMLDivElement>) => {
    if (!getStore().getState().input.active) {
      if (hover) setHover(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = hitTest(page, (e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
    setHover(hit ? { page: page.index, hit } : null);
  };

  return (
    <div
      className={`score-scroll ${mode === 'seamless' ? 'seamless' : ''} ${inputActive ? 'input-mode' : ''}`}
      ref={containerRef}
    >
      <div className={`pages mode-${mode}`}>
        {layout.pages.map((page) => (
          <div
            key={page.index}
            className="page"
            style={{ width: page.width * scale, height: page.height * scale }}
            onPointerDown={(e) => onPointerDown(page, e)}
            onPointerMove={(e) => onPointerMove(page, e)}
            onPointerLeave={() => setHover(null)}
          >
            <PageSvg svg={svgs[page.index]!} />
            <Overlay
              page={page}
              layout={layout}
              doc={doc}
              selection={selection}
              cursor={inputActive ? cursor : null}
              playhead={playhead}
              measureStarts={measureStarts}
              hover={hover?.page === page.index ? hover.hit : null}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function findEventByRef(doc: ScoreDoc, eventId: string): string[] | null {
  for (const measures of Object.values(doc.content)) {
    for (const sm of Object.values(measures)) {
      for (const voice of sm.voices) {
        const e = voice.find((x) => x.id === eventId);
        if (e) return e.notes.map((n) => n.id);
      }
    }
  }
  return null;
}

interface OverlayProps {
  readonly page: PageLayout;
  readonly layout: ScoreLayout;
  readonly doc: ScoreDoc;
  readonly selection: Selection;
  readonly cursor: ScorePosition | null;
  readonly playhead: number | null;
  readonly measureStarts: readonly number[];
  readonly hover: Hit | null;
}

function Overlay({ page, doc, selection, cursor, playhead, measureStarts, hover }: OverlayProps) {
  const staves = allStaves(doc);
  const shapes: ReactElement[] = [];
  // range selection
  if (selection.kind === 'range') {
    for (const sys of page.systems) {
      const ms = sys.measures.filter(
        (m) => m.index >= selection.measureFrom && m.index <= selection.measureTo,
      );
      if (!ms.length) continue;
      const top = sys.staves[selection.staffFrom]!.y - 0.8;
      const bottom = sys.staves[selection.staffTo]!.y + 4.8;
      const x1 = ms[0]!.x;
      const x2 = ms[ms.length - 1]!.x + ms[ms.length - 1]!.width;
      shapes.push(
        <rect
          key={`r${sys.index}`}
          className="range-sel"
          x={x1}
          y={top}
          width={x2 - x1}
          height={bottom - top}
          rx={0.4}
        />,
      );
    }
  }
  // input cursor
  if (cursor) {
    const staffIndex = staves.findIndex((s) => s.staff.id === cursor.staffId);
    for (const sys of page.systems) {
      const m = sys.measures.find((x) => x.measureId === cursor.measureId);
      const staff = sys.staves[staffIndex];
      if (!m || !staff) continue;
      const x = offsetToX(m, cursor.offset);
      shapes.push(
        <rect
          key="cursor"
          className={`input-cursor voice-${cursor.voice + 1}`}
          x={x - 0.45}
          y={staff.y - 1.2}
          width={2.0}
          height={6.4}
          rx={0.3}
        />,
      );
    }
  }
  // shadow note
  if (hover) {
    const staff = hover.system.staves[hover.staffIndex]!;
    const x = hover.measure.segments.find((s) => Math.abs(s.x - hover.x) < 0.9)?.x ?? hover.x - 0.6;
    const y = staff.y + hover.position / 2;
    const ledgers: ReactElement[] = [];
    for (let p = -2; p >= hover.position; p -= 2)
      ledgers.push(
        <line
          key={`l${p}`}
          x1={x - 0.4}
          x2={x + 1.6}
          y1={staff.y + p / 2}
          y2={staff.y + p / 2}
          className="shadow-ledger"
        />,
      );
    for (let p = 10; p <= hover.position; p += 2)
      ledgers.push(
        <line
          key={`l${p}`}
          x1={x - 0.4}
          x2={x + 1.6}
          y1={staff.y + p / 2}
          y2={staff.y + p / 2}
          className="shadow-ledger"
        />,
      );
    shapes.push(
      <g key="shadow" className="shadow-note">
        {ledgers}
        <ellipse
          cx={x + 0.59}
          cy={y}
          rx={0.62}
          ry={0.45}
          transform={`rotate(-20 ${x + 0.59} ${y})`}
        />
      </g>,
    );
  }
  // playhead
  if (playhead !== null) {
    for (const sys of page.systems) {
      const m = sys.measures.find((x) => {
        const start = measureStarts[x.index]!;
        return playhead >= start && playhead < start + toNumber(x.length);
      });
      if (!m) continue;
      const start = measureStarts[m.index]!;
      // The barline is the final interpolation anchor, even when its last note is held.
      const px = offsetToX(m, playhead - start);
      shapes.push(
        <line key="ph" className="playhead" x1={px} x2={px} y1={sys.top - 1} y2={sys.bottom + 1} />,
      );
    }
  }
  return (
    <svg
      className="overlay"
      viewBox={`0 0 ${page.width} ${page.height}`}
      preserveAspectRatio="none"
    >
      {shapes}
    </svg>
  );
}
