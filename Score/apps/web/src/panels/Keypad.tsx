/**
 * The floating note-input keypad (after Sibelius' Keypad, with MuseScore's palettes): durations,
 * accidentals and voices; grace notes, cue size, tuplets and stems; articulations; ornaments and
 * tremolo; lines; dynamics. Buttons show what the selected notes carry and toggle it. The window
 * can be dragged by its title bar; on phones it is docked at the bottom.
 */
import type {
  Arpeggio,
  Articulation,
  Breath,
  DynamicValue,
  NoteValue,
  Ornament,
} from '@ailegro-score/core';
import type { GlyphName } from '@ailegro-score/engraving';
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Glyph, GlyphRow } from '../components/Glyph';
import { type MessageKey, useT } from '../i18n';
import * as actions from '../state/actions';
import * as marks from '../state/marks';
import { type KeypadTab, getStore, useEditor } from '../state/store';

const TABS: readonly { id: KeypadTab; label: MessageKey }[] = [
  { id: 'notes', label: 'keypad.tab.notes' },
  { id: 'more', label: 'keypad.tab.more' },
  { id: 'articulations', label: 'keypad.tab.articulations' },
  { id: 'ornaments', label: 'keypad.tab.ornaments' },
  { id: 'lines', label: 'keypad.tab.lines' },
  { id: 'dynamics', label: 'keypad.tab.dynamics' },
];

const DURATIONS: { value: NoteValue; glyph: GlyphName; key: string }[] = [
  { value: '64th', glyph: 'metNote64thUp', key: '1' },
  { value: '32nd', glyph: 'metNote32ndUp', key: '2' },
  { value: '16th', glyph: 'metNote16thUp', key: '3' },
  { value: 'eighth', glyph: 'metNote8thUp', key: '4' },
  { value: 'quarter', glyph: 'metNoteQuarterUp', key: '5' },
  { value: 'half', glyph: 'metNoteHalfUp', key: '6' },
  { value: 'whole', glyph: 'metNoteWhole', key: '7' },
  { value: 'breve', glyph: 'metNoteDoubleWhole', key: '8' },
];

const ARTICULATIONS: { a: Articulation; glyph: GlyphName; key?: string }[] = [
  { a: 'staccato', glyph: 'articStaccatoAbove', key: 'Shift+S' },
  { a: 'staccatissimo', glyph: 'articStaccatissimoAbove' },
  { a: 'tenuto', glyph: 'articTenutoAbove', key: 'Shift+N' },
  { a: 'accent', glyph: 'articAccentAbove', key: 'Shift+V' },
  { a: 'marcato', glyph: 'articMarcatoAbove', key: 'Shift+O' },
  { a: 'harmonic', glyph: 'stringsHarmonic' },
  { a: 'stopped', glyph: 'brassMuteClosed' },
  { a: 'open', glyph: 'brassMuteOpen' },
  { a: 'snapPizzicato', glyph: 'pluckedSnapPizzicatoAbove' },
  { a: 'upBow', glyph: 'stringsUpBow' },
  { a: 'downBow', glyph: 'stringsDownBow' },
  { a: 'fermata', glyph: 'fermataAbove', key: 'Shift+H' },
  { a: 'fermataShort', glyph: 'fermataShortAbove' },
  { a: 'fermataLong', glyph: 'fermataLongAbove' },
];

const BREATHS: { b: Breath; glyph: GlyphName }[] = [
  { b: 'breath', glyph: 'breathMarkComma' },
  { b: 'caesura', glyph: 'caesura' },
];

const ORNAMENTS: { o: Ornament; glyph: GlyphName }[] = [
  { o: 'trill', glyph: 'ornamentTrill' },
  { o: 'shortTrill', glyph: 'ornamentShortTrill' },
  { o: 'mordent', glyph: 'ornamentMordent' },
  { o: 'turn', glyph: 'ornamentTurn' },
  { o: 'invertedTurn', glyph: 'ornamentTurnInverted' },
];

const TREMOLOS: GlyphName[] = ['tremolo1', 'tremolo2', 'tremolo3', 'tremolo4'];

const DYNAMICS: DynamicValue[] = [
  'ppp',
  'pp',
  'p',
  'mp',
  'mf',
  'f',
  'ff',
  'fff',
  'fp',
  'sf',
  'sfz',
  'sffz',
  'fz',
  'rf',
  'rfz',
  'sfp',
];

const DYNAMIC_GLYPH: Record<string, GlyphName> = {
  p: 'dynamicPiano',
  m: 'dynamicMezzo',
  f: 'dynamicForte',
  r: 'dynamicRinforzando',
  s: 'dynamicSforzando',
  z: 'dynamicZ',
  n: 'dynamicNiente',
};

const TUPLETS = [2, 3, 4, 5, 6, 7] as const;
const TUPLET_GLYPH: GlyphName[] = [
  'tuplet0',
  'tuplet1',
  'tuplet2',
  'tuplet3',
  'tuplet4',
  'tuplet5',
  'tuplet6',
  'tuplet7',
];

// ------------------------------------------------------------------------------- small icons

const svg = (children: ReactNode, viewBox = '0 0 24 24') => (
  <svg className="glyph-icon" width={22} height={22} viewBox={viewBox} aria-hidden>
    {children}
  </svg>
);
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
} as const;
const ICONS = {
  tie: svg(<path d="M4 15 Q12 8 20 15" {...stroke} />),
  slur: svg(<path d="M3 17 C7 5 17 5 21 17" {...stroke} />),
  crescendo: svg(<path d="M21 7 L3 12 L21 17" {...stroke} />),
  diminuendo: svg(<path d="M3 7 L21 12 L3 17" {...stroke} />),
  pedalLine: svg(<path d="M3 8 V16 H21 V8" {...stroke} />),
  arpeggio: (dir: Arpeggio) => {
    // a vertical wiggle, with an arrowhead for up/down
    const top = dir === 'up' ? 7 : 2.5;
    const bottom = dir === 'down' ? 17 : 21.5;
    const step = (bottom - top) / 4;
    let d = `M12 ${bottom}`;
    for (let k = 0; k < 4; k++) {
      const y0 = bottom - k * step;
      const side = k % 2 === 0 ? 4 : -4;
      d += ` C${12 + side} ${y0 - step * 0.3} ${12 + side} ${y0 - step * 0.7} 12 ${y0 - step}`;
    }
    return svg(
      <>
        <path d={d} fill="none" stroke="currentColor" strokeWidth={1.8} />
        {dir === 'up' && <path d="M7.5 8 L12 1.5 L16.5 8 Z" fill="currentColor" />}
        {dir === 'down' && <path d="M7.5 16 L12 22.5 L16.5 16 Z" fill="currentColor" />}
      </>,
    );
  },
  stemAuto: svg(
    <text x="12" y="16" fontSize="11" textAnchor="middle" fill="currentColor">
      auto
    </text>,
  ),
  flip: svg(<path d="M9 4 V20 M9 4 L5 8 M15 20 V4 M15 20 L19 16" {...stroke} />),
};

// ------------------------------------------------------------------------------- component

interface KeyProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly shortcut?: string;
  readonly on?: boolean;
  readonly wide?: boolean;
  readonly caption?: string;
  readonly className?: string;
  readonly onClick: () => void;
}

function Key({ icon, label, shortcut, on, wide, caption, className, onClick }: KeyProps) {
  return (
    <button
      type="button"
      className={['key', on ? 'on' : '', wide ? 'wide' : '', className ?? ''].join(' ').trim()}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={on ?? undefined}
      // keep the keyboard focus on the score: typing continues to work after a click
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span className="key-icon">{icon}</span>
      {caption && <span className="key-caption">{caption}</span>}
    </button>
  );
}

function useNarrow(): boolean {
  const query = '(max-width: 759px)';
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return !!narrow;
}

export function Keypad() {
  const t = useT();
  const keypad = useEditor((s) => s.keypad);
  const input = useEditor((s) => s.input);
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const lastEntered = useEditor((s) => s.lastEntered);
  const narrow = useNarrow();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState({ x: keypad.x, y: keypad.y });
  const store = getStore().getState;

  useEffect(() => setPos({ x: keypad.x, y: keypad.y }), [keypad.x, keypad.y]);

  // keep the window on screen when the browser window shrinks
  useEffect(() => {
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth;
      const x = Math.max(0, Math.min(window.innerWidth - w, store().keypad.x));
      const y = Math.max(0, Math.min(window.innerHeight - 48, store().keypad.y));
      if (x !== store().keypad.x || y !== store().keypad.y) store().setKeypad({ x, y });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [store, keypad.open]);

  const state = useMemo(
    () => marks.marksState(doc, selection, lastEntered, input.active),
    [doc, selection, lastEntered, input.active],
  );

  if (!keypad.open) return null;

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (narrow || (e.target as HTMLElement).closest('button')) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const w = ref.current?.offsetWidth ?? 240;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - w, e.clientX - drag.current.dx)),
      y: Math.max(0, Math.min(window.innerHeight - 48, e.clientY - drag.current.dy)),
    });
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    store().setKeypad({ x: pos.x, y: pos.y });
  };

  // durations: the input value, or the value of the selected notes outside note input
  const shown =
    !input.active && state.written ? state.written : { value: input.value, dots: input.dots };
  const setDuration = (value: NoteValue, dots: number) => {
    store().setInput({ value, dots });
    actions.setSelectedDuration();
  };
  const setVoice = (v: number) => {
    store().setInput({ voice: v });
    const c = store().cursor;
    if (c) getStore().setState({ cursor: { ...c, voice: v } });
  };
  const pending = input.pendingLine ? marks.pendingLineKind() : null;

  let body: ReactNode = null;
  switch (keypad.tab) {
    case 'notes':
      body = (
        <>
          <Key
            wide
            className="input-key"
            icon={<span className="key-text">✎ {t('input.mode')}</span>}
            label={t('input.modeHint')}
            shortcut="N"
            on={input.active}
            onClick={() => actions.toggleNoteInput()}
          />
          {DURATIONS.map((d) => (
            <Key
              key={d.value}
              icon={<Glyph name={d.glyph} size={24} />}
              label={t(`dur.${d.value}` as MessageKey)}
              shortcut={d.key}
              on={shown.value === d.value}
              onClick={() => setDuration(d.value, shown.value === d.value ? shown.dots : 0)}
            />
          ))}
          <Key
            icon={<Glyph name="augmentationDot" size={14} />}
            label={t('input.dot')}
            shortcut="."
            on={shown.dots === 1}
            onClick={() => setDuration(shown.value, shown.dots === 1 ? 0 : 1)}
          />
          <Key
            icon={<GlyphRow names={['augmentationDot', 'augmentationDot']} size={18} gap={0.25} />}
            label={t('input.doubleDot')}
            on={shown.dots === 2}
            onClick={() => setDuration(shown.value, shown.dots === 2 ? 0 : 2)}
          />
          <Key
            icon={<Glyph name="restQuarter" size={22} />}
            label={t('input.rest')}
            shortcut="0"
            onClick={() => actions.enterRest()}
          />
          <Key icon={ICONS.tie} label={t('input.tie')} shortcut="+" onClick={() => actions.tie()} />
          <Key
            icon={<Glyph name="accidentalFlat" size={20} />}
            label={t('input.flat')}
            on={state.alter === -1}
            onClick={() => actions.setAccidental(-1)}
          />
          <Key
            icon={<Glyph name="accidentalNatural" size={20} />}
            label={t('input.natural')}
            on={state.alter === 0}
            onClick={() => actions.setAccidental(0)}
          />
          <Key
            icon={<Glyph name="accidentalSharp" size={20} />}
            label={t('input.sharp')}
            on={state.alter === 1}
            onClick={() => actions.setAccidental(1)}
          />
          <Key
            icon={<span className="key-text">3</span>}
            label={t('input.triplet')}
            shortcut="Ctrl+3"
            onClick={() => actions.createTuplet(3)}
          />
          {[0, 1, 2, 3].map((v) => (
            <Key
              key={v}
              className={`voice v${v + 1}`}
              icon={<span className="key-text">{v + 1}</span>}
              label={`${t('input.voice')} ${v + 1}`}
              shortcut={`Ctrl+Alt+${v + 1}`}
              on={input.voice === v}
              onClick={() => setVoice(v)}
            />
          ))}
        </>
      );
      break;
    case 'more':
      body = (
        <>
          <Key
            icon={<Glyph name="graceNoteAcciaccaturaStemUp" size={24} />}
            label={t('grace.acciaccatura')}
            shortcut="/"
            onClick={() => marks.addGrace('acciaccatura')}
          />
          <Key
            icon={<Glyph name="graceNoteAppoggiaturaStemUp" size={24} />}
            label={t('grace.appoggiatura')}
            shortcut="Alt+/"
            onClick={() => marks.addGrace('appoggiatura')}
          />
          <Key
            icon={<Glyph name="metNote16thUp" size={18} />}
            caption="16"
            label={t('grace.grace16')}
            onClick={() => marks.addGrace('grace16')}
          />
          <Key
            icon={<Glyph name="metNote32ndUp" size={18} />}
            caption="32"
            label={t('grace.grace32')}
            onClick={() => marks.addGrace('grace32')}
          />
          <Key
            wide
            icon={
              <span className="key-text">
                <Glyph name="noteheadBlack" size={11} /> {t('marks.cue')}
              </span>
            }
            label={t('marks.cueHint')}
            on={state.cue}
            onClick={() => marks.toggleCue()}
          />
          <Key
            icon={<Glyph name="accidentalDoubleFlat" size={20} />}
            label={t('input.doubleFlat')}
            on={state.alter === -2}
            onClick={() => actions.setAccidental(-2)}
          />
          <Key
            icon={<Glyph name="accidentalDoubleSharp" size={16} />}
            label={t('input.doubleSharp')}
            on={state.alter === 2}
            onClick={() => actions.setAccidental(2)}
          />
          {TUPLETS.map((n) => (
            <Key
              key={n}
              icon={<Glyph name={TUPLET_GLYPH[n]!} size={18} />}
              label={t('tuplet.n', { n })}
              shortcut={`Ctrl+${n}`}
              onClick={() => actions.createTuplet(n)}
            />
          ))}
          <Key
            icon={<Glyph name="metNoteQuarterUp" size={22} />}
            label={t('stem.up')}
            on={state.stem === 'up'}
            onClick={() => marks.setStem(state.stem === 'up' ? null : 'up')}
          />
          <Key
            icon={<Glyph name="metNoteQuarterDown" size={22} />}
            label={t('stem.down')}
            on={state.stem === 'down'}
            onClick={() => marks.setStem(state.stem === 'down' ? null : 'down')}
          />
          <Key icon={ICONS.stemAuto} label={t('stem.auto')} onClick={() => marks.setStem(null)} />
          <Key
            icon={ICONS.flip}
            label={t('stem.flip')}
            shortcut="X"
            onClick={() => marks.flipStem()}
          />
        </>
      );
      break;
    case 'articulations':
      body = (
        <>
          {ARTICULATIONS.map((x) => (
            <Key
              key={x.a}
              icon={<Glyph name={x.glyph} size={20} />}
              label={t(`art.${x.a}` as MessageKey)}
              {...(x.key ? { shortcut: x.key } : {})}
              on={state.articulations.has(x.a)}
              onClick={() => marks.toggleArticulation(x.a)}
            />
          ))}
          {BREATHS.map((x) => (
            <Key
              key={x.b}
              icon={<Glyph name={x.glyph} size={20} />}
              label={t(`breath.${x.b}` as MessageKey)}
              on={state.breath === x.b}
              onClick={() => marks.toggleBreath(x.b)}
            />
          ))}
        </>
      );
      break;
    case 'ornaments':
      body = (
        <>
          {ORNAMENTS.map((x) => (
            <Key
              key={x.o}
              icon={<Glyph name={x.glyph} size={22} />}
              label={t(`orn.${x.o}` as MessageKey)}
              on={state.ornament === x.o}
              onClick={() => marks.toggleOrnament(x.o)}
            />
          ))}
          {(['normal', 'up', 'down'] as const).map((a) => (
            <Key
              key={a}
              icon={ICONS.arpeggio(a)}
              label={t(`arp.${a}` as MessageKey)}
              on={state.arpeggio === a}
              onClick={() => marks.toggleArpeggio(a)}
            />
          ))}
          {TREMOLOS.map((g, i) => (
            <Key
              key={g}
              icon={<Glyph name={g} size={20} />}
              label={t('trem.n', { n: i + 1 })}
              on={state.tremolo === i + 1}
              onClick={() => marks.toggleTremolo(i + 1)}
            />
          ))}
        </>
      );
      break;
    case 'lines': {
      const line = (kind: marks.LineKind, icon: ReactNode, shortcut?: string) => (
        <Key
          key={kind}
          icon={icon}
          label={t(`line.${kind}` as MessageKey)}
          {...(shortcut ? { shortcut } : {})}
          on={pending === kind}
          onClick={() => marks.addLine(kind)}
        />
      );
      body = (
        <>
          {line('slur', ICONS.slur, 'S')}
          {line('crescendo', ICONS.crescendo, '<')}
          {line('diminuendo', ICONS.diminuendo, '>')}
          {line('trill', <GlyphRow names={['ornamentTrill', 'wiggleTrill']} size={24} />)}
          {line('8va', <Glyph name="ottavaAlta" size={24} />, 'Ctrl+Alt+O')}
          {line('8vb', <Glyph name="ottavaBassaVb" size={24} />, 'Ctrl+Alt+Shift+O')}
          {line('15ma', <Glyph name="quindicesimaAlta" size={26} />)}
          {line('15mb', <Glyph name="quindicesimaBassaMb" size={26} />)}
          {line('pedal', <Glyph name="keyboardPedalPed" size={26} />)}
          {line('pedalLine', ICONS.pedalLine)}
        </>
      );
      break;
    }
    case 'dynamics':
      body = (
        <>
          {DYNAMICS.map((d) => (
            <Key
              key={d}
              icon={<GlyphRow names={[...d].map((c) => DYNAMIC_GLYPH[c]!)} size={26} gap={-0.1} />}
              label={d}
              onClick={() => marks.addDynamic(d)}
            />
          ))}
        </>
      );
      break;
  }

  let hint: string;
  if (pending) hint = t('keypad.hint.pending', { l: t(`line.${pending}` as MessageKey) });
  else if (input.active) hint = t('keypad.hint.input');
  else if (selection.kind === 'marks') hint = t('keypad.hint.marks');
  else if (state.events) hint = t('keypad.hint.selected', { n: state.events });
  else hint = t('keypad.hint.none');

  return (
    <div
      ref={ref}
      className={`keypad ${keypad.collapsed ? 'collapsed' : ''} ${narrow ? 'docked' : ''}`}
      style={narrow ? undefined : { left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={t('keypad.title')}
    >
      <div
        className="keypad-head"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <span className="keypad-title">⌨ {t('keypad.title')}</span>
        <span className="grow" />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => store().setKeypad({ collapsed: !keypad.collapsed })}
          aria-label={keypad.collapsed ? t('keypad.expand') : t('keypad.collapse')}
          title={keypad.collapsed ? t('keypad.expand') : t('keypad.collapse')}
        >
          {keypad.collapsed ? '▴' : '▾'}
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => store().setKeypad({ open: false })}
          aria-label={t('keypad.close')}
          title={`${t('keypad.close')} (K)`}
        >
          ✕
        </button>
      </div>
      {!keypad.collapsed && (
        <>
          <div className="keypad-tabs" role="tablist">
            {TABS.map((tab, i) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={keypad.tab === tab.id}
                className={keypad.tab === tab.id ? 'on' : ''}
                title={`${t(tab.label)} (Alt+${i + 1})`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => store().setKeypad({ tab: tab.id })}
              >
                {t(tab.label)}
              </button>
            ))}
          </div>
          <div className={`keypad-grid tab-${keypad.tab}`} role="tabpanel">
            {body}
          </div>
          <p className="keypad-hint">{hint}</p>
        </>
      )}
    </div>
  );
}
