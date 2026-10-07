import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutScore, renderPageSvg } from '@cantelvio-score/engraving';
import {
  type ComposeCandidate,
  acceptCandidate,
  fullCandidateScope,
} from '../state/compose-candidates';
import { getStore, useEditor } from '../state/store';
import { stopPlayback, togglePlayback } from '../playback/player';
import { useT } from '../i18n';

export function CandidatePreview({
  candidate,
  onClose,
}: {
  readonly candidate: ComposeCandidate;
  readonly onClose: () => void;
}) {
  const t = useT(),
    ref = useRef<HTMLDialogElement>(null),
    playing = useEditor((s) => s.playing);
  const full = useMemo(() => fullCandidateScope(candidate), [candidate]);
  const [scope, setScope] = useState(full),
    [original, setOriginal] = useState(false),
    [error, setError] = useState('');
  const doc = original ? candidate.base : candidate.preview;
  const concertPitch = useEditor((s) => s.view.concertPitch);
  const svgs = useMemo(() => {
    const layout = layoutScore(doc, { mode: 'page', concertPitch });
    return layout.pages.map((page) => renderPageSvg(page, layout));
  }, [doc, concertPitch]);
  useEffect(() => {
    ref.current?.showModal();
    return () => stopPlayback();
  }, []);
  const close = () => {
    stopPlayback();
    onClose();
  };
  return (
    <dialog
      ref={ref}
      className="candidate-dialog"
      onKeyDown={(e) => e.stopPropagation()}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="candidate-toolbar">
        <strong>{t('candidate.preview')}</strong>
        <span>
          {t('candidate.summary', { n: candidate.notes, s: candidate.seconds.toFixed(1) })}
        </span>
        <button
          onClick={() => {
            stopPlayback();
            setOriginal((x) => !x);
          }}
        >
          {original ? t('candidate.showCandidate') : t('candidate.showOriginal')}
        </button>
        <button onClick={() => void togglePlayback(doc)}>
          {playing ? t('play.stop') : t('candidate.listen')}
        </button>
        <button onClick={close}>{t('candidate.close')}</button>
      </div>
      {candidate.performance && (
        <p className="candidate-edge-note">
          {t('candidate.performance', {
            level: t(`ai.difficulty.${candidate.performance.difficulty}`),
            a: candidate.performance.before.notes,
            b: candidate.performance.after.notes,
            span: candidate.performance.handSpanLimit,
          })}
          {candidate.performance.arrangedPianoParts > 0 && ` ${t('candidate.arrangedPiano')}`}
        </p>
      )}
      {candidate.clippedTails > 0 && (
        <p className="candidate-edge-note">
          {t('candidate.clipped', { n: candidate.clippedTails })}
        </p>
      )}
      <div className="candidate-pages">
        {svgs.map((svg, i) => (
          <div key={i} dangerouslySetInnerHTML={{ __html: svg }} />
        ))}
      </div>
      <div className="candidate-accept">
        <div className="row wrap">
          <label className="field">
            <span>{t('candidate.from')}</span>
            <input
              type="number"
              min={full.from + 1}
              max={scope.to + 1}
              value={scope.from + 1}
              onChange={(e) => setScope((s) => ({ ...s, from: Number(e.target.value) - 1 }))}
            />
          </label>
          <label className="field">
            <span>{t('candidate.to')}</span>
            <input
              type="number"
              min={scope.from + 1}
              max={full.to + 1}
              value={scope.to + 1}
              onChange={(e) => setScope((s) => ({ ...s, to: Number(e.target.value) - 1 }))}
            />
          </label>
          {candidate.base.parts
            .filter((p) => full.parts.includes(p.id))
            .map((p) => (
              <label key={p.id} className="check">
                <input
                  type="checkbox"
                  checked={scope.parts.includes(p.id)}
                  onChange={() =>
                    setScope((s) => ({
                      ...s,
                      parts: s.parts.includes(p.id)
                        ? s.parts.filter((id) => id !== p.id)
                        : [...s.parts, p.id],
                    }))
                  }
                />
                {p.name}
              </label>
            ))}
          {full.chords && (
            <label className="check">
              <input
                type="checkbox"
                checked={scope.chords}
                onChange={(e) => setScope((s) => ({ ...s, chords: e.target.checked }))}
              />
              {t('candidate.chords')}
            </label>
          )}
        </div>
        <p className="hint">{t('candidate.protected')}</p>
        {error && (
          <p role="alert" className="status-line bad">
            {error}
          </p>
        )}
        <button
          className="primary"
          disabled={!scope.parts.length}
          onClick={() => {
            try {
              stopPlayback();
              if (acceptCandidate(candidate, scope)) onClose();
            } catch (e) {
              const message = (e as Error).message;
              setError(message);
              getStore().getState().notify(message, 'error');
            }
          }}
        >
          {t('candidate.accept')}
        </button>
      </div>
    </dialog>
  );
}
