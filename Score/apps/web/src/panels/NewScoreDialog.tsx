import { type NoteValue, TEMPLATES, createScore, lengthOf } from '@ailegro-score/core';
import { useEffect, useRef, useState } from 'react';
import { type MessageKey, useT } from '../i18n';
import { stopPlayback } from '../playback/player';
import { loadNew } from '../state/files';
import { getStore, useEditor } from '../state/store';

const MAJOR = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const MINOR = ['a♭', 'e♭', 'b♭', 'f', 'c', 'g', 'd', 'a', 'e', 'b', 'f♯', 'c♯', 'g♯', 'd♯', 'a♯'];
const TIMES: readonly [number, number][] = [
  [4, 4],
  [3, 4],
  [2, 4],
  [2, 2],
  [6, 8],
  [9, 8],
  [12, 8],
  [3, 8],
  [5, 4],
];
/** Pickup (anacrusis) lengths offered in the dialog; null = no pickup bar. */
const PICKUPS: readonly ({ value: NoteValue; dots: number } | null)[] = [
  null,
  { value: 'eighth', dots: 0 },
  { value: 'quarter', dots: 0 },
  { value: 'quarter', dots: 1 },
  { value: 'half', dots: 0 },
  { value: 'half', dots: 1 },
];
const CATEGORIES = ['solo', 'chamber', 'vocal', 'orchestra'] as const;

export function NewScoreDialog() {
  const t = useT();
  const lang = useEditor((s) => s.view.lang);
  const [title, setTitle] = useState(lang === 'zh' ? '新乐谱' : 'New score');
  const [composer, setComposer] = useState('');
  const [template, setTemplate] = useState('piano');
  const [fifths, setFifths] = useState(0);
  const [minor, setMinor] = useState(false);
  const [time, setTime] = useState(0);
  const [tempo, setTempo] = useState(100);
  const [measures, setMeasures] = useState(16);
  const [pickup, setPickup] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const close = () => getStore().getState().setDialog(null);

  useEffect(() => {
    dialog.current?.querySelector('input')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const create = () => {
    const [beats, beatType] = TIMES[time]!;
    const p = PICKUPS[pickup];
    const pick = p ? lengthOf(p.value, p.dots) : null;
    const doc = createScore({
      template,
      title: title.trim() || 'Untitled',
      ...(composer.trim() ? { composer: composer.trim() } : {}),
      measures,
      timeSig: { beats, beatType },
      keySig: { fifths, mode: minor ? 'minor' : 'major' },
      tempo,
      ...(pick ? { pickup: pick } : {}),
      lang,
      ids: getStore().getState().ids,
      now: new Date().toISOString(),
    });
    stopPlayback();
    loadNew(doc);
    getStore().getState().setDialog(null);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-score-title"
        ref={dialog}
      >
        <h2 id="new-score-title">{t('new.title')}</h2>
        <div className="row">
          <label className="field grow">
            <span>{t('new.name')}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field grow">
            <span>{t('new.composer')}</span>
            <input value={composer} onChange={(e) => setComposer(e.target.value)} />
          </label>
        </div>
        <fieldset className="templates">
          <legend>{t('new.template')}</legend>
          {CATEGORIES.map((cat) => {
            const list = TEMPLATES.filter((x) => x.category === cat);
            if (!list.length) return null;
            return (
              <div key={cat} className="template-group">
                <h5>{t(`cat.${cat}` as MessageKey)}</h5>
                <div className="template-list">
                  {list.map((x) => (
                    <button
                      key={x.id}
                      className={`template ${template === x.id ? 'on' : ''}`}
                      onClick={() => setTemplate(x.id)}
                      title={x.parts.length > 1 ? t('new.parts', { n: x.parts.length }) : ''}
                    >
                      {x.name[lang]}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </fieldset>
        <div className="row">
          <label className="field grow">
            <span>{t('new.key')}</span>
            <div className="row tight">
              <select
                className="grow"
                value={fifths}
                onChange={(e) => setFifths(Number(e.target.value))}
              >
                {MAJOR.map((name, i) => (
                  <option key={name} value={i - 7}>
                    {minor ? t('new.minorKey', { k: MINOR[i]! }) : t('new.majorKey', { k: name })}
                  </option>
                ))}
              </select>
              <select
                value={minor ? 'minor' : 'major'}
                onChange={(e) => setMinor(e.target.value === 'minor')}
              >
                <option value="major">{t('props.major')}</option>
                <option value="minor">{t('props.minor')}</option>
              </select>
            </div>
          </label>
          <label className="field">
            <span>{t('new.time')}</span>
            <select value={time} onChange={(e) => setTime(Number(e.target.value))}>
              {TIMES.map(([b, bt], i) => (
                <option key={`${b}/${bt}`} value={i}>
                  {b}/{bt}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>{t('new.tempo')} (♩)</span>
            <input
              type="number"
              min={20}
              max={300}
              value={tempo}
              onChange={(e) => setTempo(Math.max(20, Math.min(300, Number(e.target.value) || 100)))}
            />
          </label>
          <label className="field">
            <span>{t('new.measures')}</span>
            <input
              type="number"
              min={1}
              max={500}
              value={measures}
              onChange={(e) =>
                setMeasures(Math.max(1, Math.min(500, Number(e.target.value) || 16)))
              }
            />
          </label>
          <label className="field">
            <span>{t('new.pickup')}</span>
            <select value={pickup} onChange={(e) => setPickup(Number(e.target.value))}>
              {PICKUPS.map((p, i) => (
                <option key={i} value={i}>
                  {p
                    ? `${p.dots ? t('status.dotted') : ''}${t(`dur.${p.value}` as MessageKey)}`
                    : t('new.none')}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <button onClick={close}>{t('new.cancel')}</button>
          <button className="primary" onClick={create}>
            {t('new.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
