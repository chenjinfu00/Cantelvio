import type { Articulation, NoteValue } from '@ailegro-score/core';
import type { GlyphName } from '@ailegro-score/engraving';
import { Glyph } from '../components/Glyph';
import { type MessageKey, useT } from '../i18n';
import * as actions from '../state/actions';
import { getStore, useEditor } from '../state/store';

const DURATIONS: { value: NoteValue; glyph: GlyphName; key: string }[] = [
  { value: '64th', glyph: 'metNote64thUp', key: '1' },
  { value: '32nd', glyph: 'metNote32ndUp', key: '2' },
  { value: '16th', glyph: 'metNote16thUp', key: '3' },
  { value: 'eighth', glyph: 'metNote8thUp', key: '4' },
  { value: 'quarter', glyph: 'metNoteQuarterUp', key: '5' },
  { value: 'half', glyph: 'metNoteHalfUp', key: '6' },
  { value: 'whole', glyph: 'metNoteWhole', key: '7' },
];

const ARTICULATIONS: { a: Articulation; glyph: GlyphName; key: string }[] = [
  { a: 'staccato', glyph: 'articStaccatoAbove', key: 'Shift+S' },
  { a: 'accent', glyph: 'articAccentAbove', key: 'Shift+V' },
  { a: 'tenuto', glyph: 'articTenutoAbove', key: 'Shift+N' },
  { a: 'marcato', glyph: 'articMarcatoAbove', key: 'Shift+O' },
  { a: 'fermata', glyph: 'fermataAbove', key: 'Shift+H' },
];

export function Palette() {
  const t = useT();
  const input = useEditor((s) => s.input);
  const store = getStore().getState;

  return (
    <div className="palette" role="toolbar" aria-label={t('input.mode')}>
      <button
        className={`input-toggle ${input.active ? 'on' : ''}`}
        onClick={() => actions.toggleNoteInput()}
        title={t('input.modeHint')}
      >
        ✎ {t('input.mode')} <kbd>N</kbd>
      </button>
      <div className="group">
        {DURATIONS.map((d) => (
          <button
            key={d.value}
            className={`icon ${input.value === d.value ? 'on' : ''}`}
            onClick={() => {
              store().setInput({ value: d.value, dots: 0 });
              actions.setSelectedDuration();
            }}
            title={`${t(`dur.${d.value}` as MessageKey)} (${d.key})`}
          >
            <Glyph name={d.glyph} size={24} />
          </button>
        ))}
        <button
          className={`icon ${input.dots ? 'on' : ''}`}
          onClick={() => {
            store().setInput({ dots: input.dots ? 0 : 1 });
            actions.setSelectedDuration();
          }}
          title={`${t('input.dot')} (.)`}
        >
          <Glyph name="augmentationDot" size={14} />
        </button>
      </div>
      <div className="group">
        <button
          className="icon"
          onClick={() => actions.enterRest()}
          title={`${t('input.rest')} (0)`}
        >
          <Glyph name="restQuarter" size={22} />
        </button>
        <button className="icon text" onClick={() => actions.tie()} title={`${t('input.tie')} (+)`}>
          ⁀
        </button>
        <button
          className="icon text"
          onClick={() => actions.createTriplet()}
          title={`${t('input.triplet')} (Ctrl+3)`}
        >
          3
        </button>
      </div>
      <div className="group">
        <button className="icon" onClick={() => actions.setAccidental(-1)} title={t('input.flat')}>
          <Glyph name="accidentalFlat" size={20} />
        </button>
        <button
          className="icon"
          onClick={() => actions.setAccidental(0)}
          title={t('input.natural')}
        >
          <Glyph name="accidentalNatural" size={20} />
        </button>
        <button className="icon" onClick={() => actions.setAccidental(1)} title={t('input.sharp')}>
          <Glyph name="accidentalSharp" size={20} />
        </button>
      </div>
      <div className="group">
        {ARTICULATIONS.map((x) => (
          <button
            key={x.a}
            className="icon"
            onClick={() => actions.toggleArticulation(x.a)}
            title={`${t(`art.${x.a}` as MessageKey)} (${x.key})`}
          >
            <Glyph name={x.glyph} size={18} />
          </button>
        ))}
      </div>
      <div className="group voices" aria-label={t('input.voice')}>
        {[0, 1, 2, 3].map((v) => (
          <button
            key={v}
            className={`voice v${v + 1} ${input.voice === v ? 'on' : ''}`}
            onClick={() => {
              store().setInput({ voice: v });
              const c = store().cursor;
              if (c) getStore().setState({ cursor: { ...c, voice: v } });
            }}
            title={`${t('input.voice')} ${v + 1} (Ctrl+Alt+${v + 1})`}
          >
            {v + 1}
          </button>
        ))}
      </div>
      <div className="group">
        <button onClick={() => actions.appendMeasures(1)} title="Ctrl+B">
          ＋ {t('measure.append')}
        </button>
        <button onClick={() => actions.insertMeasureBeforeSelection()}>
          {t('measure.insert')}
        </button>
        <button onClick={() => actions.deleteSelectedMeasures()}>{t('measure.delete')}</button>
      </div>
    </div>
  );
}
