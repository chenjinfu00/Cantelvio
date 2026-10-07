import {
  FAMILY_NAMES,
  INSTRUMENTS,
  type InstrumentFamily,
  type Part,
  createPart,
  findInstrument,
} from '@cantelvio-score/core';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { getStore, useEditor } from '../state/store';

const FAMILY_ORDER: readonly InstrumentFamily[] = [
  'woodwinds',
  'brass',
  'percussion',
  'keyboards',
  'plucked',
  'voices',
  'strings',
];

function addInstrument(instrumentId: string): void {
  const s = getStore().getState();
  const def = findInstrument(instrumentId);
  if (!def) return;
  const part = createPart(instrumentId, s.ids, { lang: s.view.lang });
  // Orchestral score order: before the first part that comes later in the catalog order.
  const order = (p: Part) => findInstrument(p.instrument)?.order ?? Number.MAX_SAFE_INTEGER;
  const later = s.doc.parts.findIndex((p) => order(p) > def.order);
  const index = later < 0 ? s.doc.parts.length : later;
  s.apply(
    {
      type: 'part.add',
      index,
      part,
      ...(def.brace && part.staves.length > 1 ? { braceId: s.ids.next('gr') } : {}),
    },
    'add instrument',
  );
}

function PartRow({ part, canRemove }: { part: Part; canRemove: boolean }) {
  const t = useT();
  const lang = useEditor((s) => s.view.lang);
  const [name, setName] = useState(part.name);
  const [abbr, setAbbr] = useState(part.abbreviation);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setName(part.name);
    setAbbr(part.abbreviation);
  }, [part.name, part.abbreviation]);
  const def = findInstrument(part.instrument);
  const commit = () => {
    const n = name.trim();
    if (!n || (n === part.name && abbr === part.abbreviation)) return;
    getStore()
      .getState()
      .apply(
        { type: 'part.rename', partId: part.id, name: n, abbreviation: abbr.trim() },
        'rename',
      );
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  };
  return (
    <li className="part-row">
      <div className="part-names">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-label={t('instr.rename')}
        />
        <input
          className="abbr"
          value={abbr}
          onChange={(e) => setAbbr(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-label={t('instr.abbr')}
        />
      </div>
      <div className="part-meta">
        <span>
          {def ? def.name[lang] : part.instrument}
          {part.staves.length > 1 ? ` · ${t('instr.staves', { n: part.staves.length })}` : ''}
        </span>
        {canRemove &&
          (confirming ? (
            <span className="confirm">
              <button
                className="danger small"
                onClick={() => {
                  getStore()
                    .getState()
                    .apply({ type: 'part.remove', partId: part.id }, 'remove instrument', {
                      selection: { kind: 'none' },
                      cursor: null,
                    });
                  setConfirming(false);
                }}
              >
                {t('instr.confirmRemove')}
              </button>
              <button className="small" onClick={() => setConfirming(false)}>
                {t('new.cancel')}
              </button>
            </span>
          ) : (
            <button className="small" onClick={() => setConfirming(true)}>
              {t('instr.remove')}
            </button>
          ))}
      </div>
    </li>
  );
}

export function InstrumentsPanel() {
  const t = useT();
  const parts = useEditor((s) => s.doc.parts);
  const lang = useEditor((s) => s.view.lang);
  const [choice, setChoice] = useState('violin');
  return (
    <div className="panel-body">
      <h3>{t('instr.parts')}</h3>
      <ul className="parts">
        {parts.map((p) => (
          <PartRow key={p.id} part={p} canRemove={parts.length > 1} />
        ))}
      </ul>
      <h4>{t('instr.add')}</h4>
      <div className="row tight">
        <select className="grow" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {FAMILY_ORDER.map((family) => (
            <optgroup key={family} label={FAMILY_NAMES[family][lang]}>
              {INSTRUMENTS.filter((i) => i.family === family).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name[lang]}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button className="primary" onClick={() => addInstrument(choice)}>
          ＋ {t('instr.addButton')}
        </button>
      </div>
      <p className="hint">{t('instr.orderHint')}</p>
    </div>
  );
}
