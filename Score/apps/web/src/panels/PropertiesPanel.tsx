import {
  type BarlineStyle,
  CLEF_TYPES,
  type ClefType,
  type DynamicValue,
  type Rational,
  type ScoreDoc,
  type Step,
  allStaves,
  barLength,
  clefAt,
  cmp,
  findEventOfNote,
  measureIndexOf,
  measureInfos,
  rat,
  scoreLength,
  sub,
} from '@ailegro-score/core';
import { CHORD_QUALITIES } from '@ailegro-score/ailegro-bridge';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { type MessageKey, useT } from '../i18n';
import { type EditorState, getStore, useEditor } from '../state/store';

const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const DYNAMICS: readonly DynamicValue[] = [
  'ppp',
  'pp',
  'p',
  'mp',
  'mf',
  'f',
  'ff',
  'fff',
  'sf',
  'sfz',
  'fz',
  'fp',
  'sfp',
  'rf',
  'rfz',
];
const BARLINES: readonly BarlineStyle[] = ['single', 'double', 'final', 'dashed'];
const MAJOR = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const MINOR = ['a♭', 'e♭', 'b♭', 'f', 'c', 'g', 'd', 'a', 'e', 'b', 'f♯', 'c♯', 'g♯', 'd♯', 'a♯'];
const ALTER_SIGN: Record<number, string> = { [-1]: '♭', 0: '', 1: '♯' };

interface Target {
  readonly measureIndex: number;
  readonly staffId: string | null;
  readonly offset: Rational;
}

/** Where the properties apply: the selection, or the input cursor. */
function targetOf(s: Pick<EditorState, 'doc' | 'selection' | 'cursor'>): Target | null {
  const { doc, selection, cursor } = s;
  if (selection.kind === 'notes' && selection.noteIds.length) {
    const loc = findEventOfNote(doc, selection.noteIds[0]!);
    if (loc)
      return { measureIndex: loc.measureIndex, staffId: loc.staffId, offset: loc.event.offset };
  }
  if (selection.kind === 'rest')
    return {
      measureIndex: measureIndexOf(doc, selection.at.measureId),
      staffId: selection.at.staffId,
      offset: selection.at.offset,
    };
  if (selection.kind === 'range')
    return {
      measureIndex: selection.measureFrom,
      staffId: allStaves(doc)[selection.staffFrom]?.staff.id ?? null,
      offset: rat(0),
    };
  if (cursor)
    return {
      measureIndex: measureIndexOf(doc, cursor.measureId),
      staffId: cursor.staffId,
      offset: cursor.offset,
    };
  return null;
}

/** New measure ids needed to re-bar from `index` with a new time signature. */
function newIdsForTimeSig(doc: ScoreDoc, index: number, beats: number, beatType: number): string[] {
  const infos = measureInfos(doc);
  let end = index + 1;
  while (end < infos.length && !infos[end]!.measure.timeSig) end++;
  const regionEnd = end < infos.length ? infos[end]!.start : scoreLength(doc);
  const span = sub(regionEnd, infos[index]!.start);
  const bar = barLength({ beats, beatType });
  const k = Math.max(1, Math.ceil((span.n * bar.d) / (span.d * bar.n)));
  const ids = getStore().getState().ids;
  return Array.from({ length: Math.max(0, k - (end - index)) }, () => ids.next('m'));
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="props-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function MetaFields() {
  const t = useT();
  const meta = useEditor((s) => s.doc.meta);
  const [draft, setDraft] = useState({
    title: meta.title,
    subtitle: meta.subtitle ?? '',
    composer: meta.composer ?? '',
  });
  useEffect(
    () =>
      setDraft({ title: meta.title, subtitle: meta.subtitle ?? '', composer: meta.composer ?? '' }),
    [meta],
  );
  const commit = (key: 'title' | 'subtitle' | 'composer') => {
    const value = draft[key].trim();
    if (value === (meta[key] ?? '')) return;
    if (key === 'title' && !value) return;
    getStore()
      .getState()
      .apply({ type: 'meta.set', patch: { [key]: value } }, 'score info');
  };
  return (
    <Section title={t('props.score')}>
      {(['title', 'subtitle', 'composer'] as const).map((key) => (
        <label className="field" key={key}>
          <span>{t(`props.${key}` as MessageKey)}</span>
          <input
            value={draft[key]}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            onBlur={() => commit(key)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </label>
      ))}
    </Section>
  );
}

function MeasureFields({ target }: { target: Target }) {
  const t = useT();
  const doc = useEditor((s) => s.doc);
  const info = measureInfos(doc)[target.measureIndex];
  const [beats, setBeats] = useState(4);
  const [beatType, setBeatType] = useState(4);
  const [bpm, setBpm] = useState(100);
  const [tempoText, setTempoText] = useState('');
  const [mark, setMark] = useState('');
  useEffect(() => {
    if (!info) return;
    setBeats(info.timeSig.beats);
    setBeatType(info.timeSig.beatType);
    const tempo = info.measure.tempo?.[0];
    setBpm(tempo?.bpm ?? doc.settings.defaultTempo);
    setTempoText(tempo?.text ?? '');
    setMark(info.measure.rehearsalMark ?? '');
  }, [info, doc.settings.defaultTempo]);
  if (!info) return null;
  const m = info.measure;
  const store = getStore().getState;
  const apply = store().apply;
  return (
    <Section title={t('props.measure', { n: target.measureIndex + 1 })}>
      <label className="field">
        <span>{t('props.keyChange')}</span>
        <div className="row tight">
          <select
            className="grow"
            value={info.keySig.fifths}
            onChange={(e) =>
              apply(
                {
                  type: 'measure.setKeySig',
                  measureId: m.id,
                  keySig: {
                    fifths: Number(e.target.value),
                    ...(info.keySig.mode ? { mode: info.keySig.mode } : {}),
                  },
                },
                'key signature',
              )
            }
          >
            {MAJOR.map((name, i) => (
              <option key={name} value={i - 7}>
                {t('props.keyName', { major: name, minor: MINOR[i]! })}
              </option>
            ))}
          </select>
          <select
            value={info.keySig.mode ?? 'major'}
            onChange={(e) =>
              apply(
                {
                  type: 'measure.setKeySig',
                  measureId: m.id,
                  keySig: { fifths: info.keySig.fifths, mode: e.target.value as 'major' | 'minor' },
                },
                'key signature',
              )
            }
          >
            <option value="major">{t('props.major')}</option>
            <option value="minor">{t('props.minor')}</option>
          </select>
        </div>
      </label>

      <label className="field">
        <span>{t('props.timeChange')}</span>
        <div className="row tight">
          <input
            type="number"
            min={1}
            max={32}
            value={beats}
            onChange={(e) => setBeats(Math.max(1, Math.min(32, Number(e.target.value) || 1)))}
          />
          <span className="slash">/</span>
          <select value={beatType} onChange={(e) => setBeatType(Number(e.target.value))}>
            {[1, 2, 4, 8, 16].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              apply(
                {
                  type: 'measure.setTimeSig',
                  measureId: m.id,
                  timeSig: { beats, beatType },
                  newMeasureIds: newIdsForTimeSig(
                    store().doc,
                    target.measureIndex,
                    beats,
                    beatType,
                  ),
                },
                'time signature',
                { selection: { kind: 'none' }, cursor: null },
              )
            }
          >
            {t('props.apply')}
          </button>
        </div>
      </label>

      <label className="field">
        <span>{t('props.tempo')}</span>
        <div className="row tight">
          <span className="prefix">♩=</span>
          <input
            type="number"
            min={10}
            max={400}
            value={bpm}
            onChange={(e) => setBpm(Number(e.target.value) || 100)}
          />
          <input
            className="grow"
            placeholder="Allegro"
            value={tempoText}
            onChange={(e) => setTempoText(e.target.value)}
          />
        </div>
        <div className="row tight">
          <button
            onClick={() =>
              apply(
                {
                  type: 'measure.setTempo',
                  measureId: m.id,
                  tempo: {
                    id: m.tempo?.[0]?.id ?? store().ids.next('tm'),
                    offset: rat(0),
                    bpm,
                    ...(tempoText.trim() ? { text: tempoText.trim() } : {}),
                  },
                },
                'tempo',
              )
            }
          >
            {t('props.apply')}
          </button>
          {m.tempo?.length ? (
            <button
              onClick={() =>
                apply({ type: 'measure.setTempo', measureId: m.id, tempo: null }, 'tempo')
              }
            >
              {t('props.clear')}
            </button>
          ) : null}
        </div>
      </label>

      <label className="field">
        <span>{t('props.rehearsal')}</span>
        <div className="row tight">
          <input
            className="grow"
            value={mark}
            maxLength={8}
            placeholder="A"
            onChange={(e) => setMark(e.target.value)}
          />
          <button
            onClick={() =>
              apply(
                { type: 'measure.setRehearsalMark', measureId: m.id, text: mark.trim() || null },
                'rehearsal mark',
              )
            }
          >
            {t('props.apply')}
          </button>
        </div>
      </label>

      <div className="row">
        <label className="field">
          <span>{t('props.barline')}</span>
          <select
            value={m.barline ?? 'single'}
            onChange={(e) =>
              apply(
                {
                  type: 'measure.setBarline',
                  measureId: m.id,
                  barline: e.target.value as BarlineStyle,
                },
                'barline',
              )
            }
          >
            {BARLINES.map((b) => (
              <option key={b} value={b}>
                {t(`barline.${b}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('props.break')}</span>
          <select
            value={m.breakAfter ?? ''}
            onChange={(e) =>
              apply(
                {
                  type: 'measure.setBreak',
                  measureId: m.id,
                  breakAfter: (e.target.value || null) as 'system' | 'page' | null,
                },
                'break',
              )
            }
          >
            <option value="">{t('new.none')}</option>
            <option value="system">{t('props.breakSystem')}</option>
            <option value="page">{t('props.breakPage')}</option>
          </select>
        </label>
      </div>
    </Section>
  );
}

function PositionFields({ target }: { target: Target }) {
  const t = useT();
  const doc = useEditor((s) => s.doc);
  const info = measureInfos(doc)[target.measureIndex];
  const existing = info
    ? doc.harmony.find((h) => h.measureId === info.measure.id && cmp(h.offset, target.offset) === 0)
    : undefined;
  const [root, setRoot] = useState<Step>('C');
  const [alter, setAlter] = useState(0);
  const [quality, setQuality] = useState('maj');
  const [bass, setBass] = useState('');
  const [dynamic, setDynamic] = useState<DynamicValue>('mf');
  useEffect(() => {
    if (!existing) return;
    setRoot(existing.root.step);
    setAlter(existing.root.alter);
    setQuality(existing.quality);
    setBass(existing.bass ? `${existing.bass.step}${existing.bass.alter}` : '');
  }, [existing]);
  if (!info) return null;
  const store = getStore().getState;
  const apply = store().apply;
  const measureId = info.measure.id;
  const staffId = target.staffId;
  const clef = staffId ? clefAt(doc, staffId, target.measureIndex, target.offset) : null;
  const beat = (target.offset.n / target.offset.d) * info.timeSig.beatType + 1;
  return (
    <Section
      title={t('props.position', {
        n: target.measureIndex + 1,
        b: Number.isInteger(beat) ? beat : beat.toFixed(2),
      })}
    >
      <label className="field">
        <span>{t('props.chord')}</span>
        <div className="row tight wrap">
          <select value={root} onChange={(e) => setRoot(e.target.value as Step)}>
            {STEPS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select value={alter} onChange={(e) => setAlter(Number(e.target.value))}>
            <option value={-1}>♭</option>
            <option value={0}>♮</option>
            <option value={1}>♯</option>
          </select>
          <select className="grow" value={quality} onChange={(e) => setQuality(e.target.value)}>
            {CHORD_QUALITIES.map((q) => (
              <option key={q.id} value={q.id}>
                {`${root}${ALTER_SIGN[alter] ?? ''}${q.suffix}`} ({q.id})
              </option>
            ))}
          </select>
          <select
            value={bass}
            onChange={(e) => setBass(e.target.value)}
            aria-label={t('props.bass')}
          >
            <option value="">/ —</option>
            {STEPS.flatMap((s) =>
              [-1, 0, 1].map((a) => (
                <option key={`${s}${a}`} value={`${s}${a}`}>
                  /{s}
                  {ALTER_SIGN[a]}
                </option>
              )),
            )}
          </select>
        </div>
        <div className="row tight">
          <button
            onClick={() =>
              apply(
                {
                  type: 'harmony.set',
                  chord: {
                    id: existing?.id ?? store().ids.next('ch'),
                    measureId,
                    offset: target.offset,
                    root: { step: root, alter },
                    quality,
                    ...(bass
                      ? { bass: { step: bass[0] as Step, alter: Number(bass.slice(1)) } }
                      : {}),
                  },
                },
                'chord symbol',
              )
            }
          >
            {t('props.apply')}
          </button>
          {existing && (
            <button
              onClick={() => apply({ type: 'harmony.delete', ids: [existing.id] }, 'chord symbol')}
            >
              {t('props.clear')}
            </button>
          )}
        </div>
      </label>

      {staffId && (
        <>
          <label className="field">
            <span>{t('props.dynamic')}</span>
            <div className="row tight">
              <select
                className="grow"
                value={dynamic}
                onChange={(e) => setDynamic(e.target.value as DynamicValue)}
              >
                {DYNAMICS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <button
                onClick={() =>
                  apply(
                    {
                      type: 'dynamic.set',
                      staffId,
                      measureId,
                      mark: { id: store().ids.next('dy'), offset: target.offset, value: dynamic },
                    },
                    'dynamic',
                  )
                }
              >
                {t('props.apply')}
              </button>
            </div>
          </label>
          <label className="field">
            <span>{t('props.clef')}</span>
            <select
              value={clef ?? 'treble'}
              onChange={(e) =>
                apply(
                  {
                    type: 'clef.set',
                    staffId,
                    measureId,
                    offset: target.offset,
                    clef: e.target.value as ClefType,
                    id: store().ids.next('cl'),
                  },
                  'clef',
                )
              }
            >
              {CLEF_TYPES.map((c) => (
                <option key={c} value={c}>
                  {t(`clef.${c}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </Section>
  );
}

export function PropertiesPanel() {
  const t = useT();
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const cursor = useEditor((s) => s.cursor);
  const target = useMemo(() => targetOf({ doc, selection, cursor }), [doc, selection, cursor]);
  return (
    <div className="panel-body">
      <MetaFields />
      {target ? (
        <>
          <MeasureFields target={target} />
          <PositionFields target={target} />
        </>
      ) : (
        <p className="hint">{t('props.selectHint')}</p>
      )}
    </div>
  );
}
