import { SAMPLES } from '@ailegro-score/core';
import { useEffect, useRef, useState } from 'react';
import { BrandText } from '../components/BrandText';
import { IN_ARTIFACT } from '../host';
import { useT } from '../i18n';
import { stopPlayback, togglePlayback } from '../playback/player';
import {
  CAN_PICK,
  type RecentFile,
  confirmDiscard,
  exportSvg,
  exportMidi,
  exportPdf,
  loadNew,
  openRecent,
  openScore,
  recentFiles,
  saveScore,
  saveScoreAs,
} from '../state/files';
import { getStore, isDirty, useEditor } from '../state/store';

/** A dropdown that closes on outside clicks and Escape. */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return { open, setOpen, ref };
}

export function TopBar() {
  const t = useT();
  const view = useEditor((s) => s.view);
  const canUndo = useEditor((s) => s.session.canUndo);
  const canRedo = useEditor((s) => s.session.canRedo);
  const playing = useEditor((s) => s.playing);
  const title = useEditor((s) => s.doc.meta.title);
  const dirty = useEditor((s) => isDirty(s));
  const keypadOpen = useEditor((s) => s.keypad.open);
  const demo = useDropdown();
  const recent = useDropdown();
  const exports = useDropdown();
  const [recentList, setRecentList] = useState<RecentFile[]>([]);
  const store = getStore().getState;

  const showRecent = async () => {
    setRecentList(await recentFiles());
    recent.setOpen(!recent.open);
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden>
          ♪
        </span>
        <strong>
          <BrandText text="AIlegro Score" />
        </strong>
        <span className="doc-title" title={title}>
          {title}
        </span>
        {dirty && (
          <span
            className="dirty-dot"
            role="img"
            aria-label={t('status.dirty')}
            title={t('status.dirty')}
          />
        )}
      </div>
      <nav className="menu" aria-label={t('menu.file')}>
        <button
          onClick={async () => {
            if (await confirmDiscard()) store().setDialog('new');
          }}
        >
          {t('menu.new')}
        </button>
        <div className="split" ref={recent.ref}>
          <button onClick={() => void openScore()} title="Ctrl+O">
            {t('menu.open')}
          </button>
          {CAN_PICK && (
            <button
              className="split-arrow"
              onClick={() => void showRecent()}
              aria-expanded={recent.open}
              aria-label={t('menu.recent')}
              title={t('menu.recent')}
            >
              ▾
            </button>
          )}
          {recent.open && (
            <div className="dropdown-menu">
              <div className="dropdown-title">{t('menu.recent')}</div>
              {recentList.length === 0 && (
                <div className="dropdown-empty">{t('menu.recentEmpty')}</div>
              )}
              {recentList.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    recent.setOpen(false);
                    stopPlayback();
                    void openRecent(r);
                  }}
                  title={r.name}
                >
                  <span>{r.title || r.name}</span>
                  <small>{r.name}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => void saveScore()} title="Ctrl+S">
          {t('menu.save')}
        </button>
        <button onClick={() => void saveScoreAs()} title="Ctrl+Shift+S">
          {t('menu.saveAs')}
        </button>
        <div className="dropdown" ref={demo.ref}>
          <button onClick={() => demo.setOpen(!demo.open)} aria-expanded={demo.open}>
            {t('menu.demo')} ▾
          </button>
          {demo.open && (
            <div className="dropdown-menu">
              {SAMPLES.map((s) => (
                <button
                  key={s.id}
                  onClick={async () => {
                    demo.setOpen(false);
                    if (!(await confirmDiscard())) return;
                    stopPlayback();
                    // examples are built with fixed ids; give each opened copy its own identity
                    loadNew({ ...s.build(view.lang), id: store().ids.next('sc') });
                  }}
                >
                  {s.title[view.lang]}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="dropdown" ref={exports.ref}>
          <button onClick={() => exports.setOpen(!exports.open)} aria-expanded={exports.open}>
            {t('menu.export')} ▾
          </button>
          {exports.open && (
            <div className="dropdown-menu">
              <button
                onClick={() => {
                  exports.setOpen(false);
                  void exportMidi();
                }}
              >
                {t('menu.exportMidi')}
              </button>
              <button
                onClick={() => {
                  exports.setOpen(false);
                  void exportPdf();
                }}
              >
                {t('menu.exportPdf')}
              </button>
              <button
                onClick={() => {
                  exports.setOpen(false);
                  void exportSvg();
                }}
              >
                {t('menu.exportSvg')}
              </button>
            </div>
          )}
        </div>
        {/* the artifact viewer cannot open the print dialog */}
        {!IN_ARTIFACT && <button onClick={() => window.print()}>{t('menu.print')}</button>}
      </nav>
      <div className="tools">
        <button
          onClick={() => store().undo()}
          disabled={!canUndo}
          title="Ctrl+Z"
          aria-label={t('menu.undo')}
        >
          ↶
        </button>
        <button
          onClick={() => store().redo()}
          disabled={!canRedo}
          title="Ctrl+Y"
          aria-label={t('menu.redo')}
        >
          ↷
        </button>
        <span className="sep" />
        <button
          className={`play ${playing ? 'on' : ''}`}
          onClick={() => void togglePlayback()}
          title="Space"
        >
          {playing ? `■ ${t('play.stop')}` : `▶ ${t('play.play')}`}
        </button>
        <span className="sep" />
        <button
          className={keypadOpen ? 'on' : ''}
          onClick={() => store().setKeypad({ open: !keypadOpen, collapsed: false })}
          aria-pressed={keypadOpen}
          title={`${t('keypad.toggle')} (K)`}
        >
          ⌨ {t('keypad.toggle')}
        </button>
        <span className="sep" />
        <label className="toggle">
          <input
            type="checkbox"
            checked={view.concertPitch}
            onChange={(e) => store().setView({ concertPitch: e.target.checked })}
          />
          {t('view.concert')}
        </label>
        <select
          aria-label={t('view.mode')}
          value={view.mode}
          onChange={(e) => store().setView({ mode: e.target.value as typeof view.mode })}
        >
          <option value="page">{t('view.page')}</option>
          <option value="seamless">{t('view.seamless')}</option>
          <option value="continuous">{t('view.continuous')}</option>
        </select>
        <button
          onClick={() => store().setView({ zoom: Math.max(0.4, +(view.zoom - 0.1).toFixed(2)) })}
          aria-label={t('view.zoomOut')}
        >
          −
        </button>
        <span className="zoom">{Math.round(view.zoom * 100)}%</span>
        <button
          onClick={() => store().setView({ zoom: Math.min(3, +(view.zoom + 0.1).toFixed(2)) })}
          aria-label={t('view.zoomIn')}
        >
          +
        </button>
        <span className="sep" />
        <button
          className="lang"
          onClick={() => store().setView({ lang: view.lang === 'zh' ? 'en' : 'zh' })}
        >
          {view.lang === 'zh' ? 'EN' : '中文'}
        </button>
      </div>
    </header>
  );
}
