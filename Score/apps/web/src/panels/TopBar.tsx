import { SAMPLES } from '@ailegro-score/core';
import { useState } from 'react';
import { BrandText } from '../components/BrandText';
import { useT } from '../i18n';
import { stopPlayback, togglePlayback } from '../playback/player';
import { exportSvg, openScore, saveScore } from '../state/files';
import { getStore, useEditor } from '../state/store';

export function TopBar() {
  const t = useT();
  const view = useEditor((s) => s.view);
  const canUndo = useEditor((s) => s.session.canUndo);
  const canRedo = useEditor((s) => s.session.canRedo);
  const playing = useEditor((s) => s.playing);
  const title = useEditor((s) => s.doc.meta.title);
  const [demoOpen, setDemoOpen] = useState(false);
  const store = getStore().getState;

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
      </div>
      <nav className="menu" aria-label="file">
        <button onClick={() => store().setDialog('new')}>{t('menu.new')}</button>
        <button onClick={() => void openScore()}>{t('menu.open')}</button>
        <button onClick={() => saveScore()} title="Ctrl+S">
          {t('menu.save')}
        </button>
        <div className="dropdown">
          <button onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}>
            {t('menu.demo')} ▾
          </button>
          {demoOpen && (
            <div className="dropdown-menu" onMouseLeave={() => setDemoOpen(false)}>
              {SAMPLES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    stopPlayback();
                    // examples are built with fixed ids; give each opened copy its own identity
                    store().load({ ...s.build(view.lang), id: store().ids.next('sc') });
                    setDemoOpen(false);
                  }}
                >
                  {s.title[view.lang]}
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => exportSvg()}>{t('menu.exportSvg')}</button>
        <button onClick={() => window.print()}>{t('menu.print')}</button>
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
        <label className="toggle">
          <input
            type="checkbox"
            checked={view.concertPitch}
            onChange={(e) => store().setView({ concertPitch: e.target.checked })}
          />
          {t('view.concert')}
        </label>
        <button
          onClick={() => store().setView({ mode: view.mode === 'page' ? 'continuous' : 'page' })}
        >
          {view.mode === 'page' ? t('view.continuous') : t('view.page')}
        </button>
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
