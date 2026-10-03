import { type MessageKey, useT } from '../i18n';
import {
  type ImportStatus as Status,
  cancelImport,
  dismissImport,
  openImportResult,
  useImportStatus,
} from '../state/service-import';

const STAGES = new Set([
  'uploading',
  'queued',
  'recognising',
  'exporting',
  'loading',
  'transcribing',
  'beats',
  'score',
]);

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The step a job is in, e.g. "Recognising (Audiveris) · page 2/4" (Audiveris adds a sub-step). */
function stageText(t: ReturnType<typeof useT>, s: Status): string {
  const stage = s.stage.split(':')[0]!;
  const label = STAGES.has(stage)
    ? t(`import.stage.${stage}` as MessageKey, { f: s.name })
    : s.stage;
  if (!s.progress) return label;
  const [a, b] = s.progress;
  if (s.kind === 'pdf') return `${label} · ${t('import.pages', { a: Math.min(a + 1, b), b })}`;
  return stage === 'transcribing' ? `${label} · ${t('import.chunks', { a, b })}` : label;
}

/** Floating status of the PDF / recording job running on the local AIlegro service. */
export function ImportStatus() {
  const t = useT();
  const s = useImportStatus();
  if (!s) return null;
  const running = s.phase === 'uploading' || s.phase === 'queued' || s.phase === 'running';
  const title = s.kind === 'pdf' ? t('import.kindPdf') : t('import.kindAudio');
  return (
    <div
      className={`import-status ${s.phase}`}
      role={s.phase === 'failed' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <div className="import-text">
        <strong>
          {title} · {s.name}
        </strong>
        <span>
          {s.phase === 'failed'
            ? t('import.failed', { m: s.error ?? '?' })
            : s.phase === 'cancelled'
              ? t('import.cancelled')
              : s.phase === 'ready'
                ? t('import.waiting')
                : stageText(t, s)}
          {running && s.elapsed > 0 ? ` · ${clock(s.elapsed)}` : ''}
        </span>
      </div>
      {running && s.phase !== 'uploading' && (
        <button className="small" onClick={() => void cancelImport()}>
          {t('import.cancel')}
        </button>
      )}
      {s.phase === 'ready' && (
        <button className="small primary" onClick={() => void openImportResult()}>
          {t('import.open')}
        </button>
      )}
      {!running && (
        <button className="small" onClick={dismissImport} aria-label={t('import.close')}>
          ✕
        </button>
      )}
      {running && <span className="import-spinner" aria-hidden />}
    </div>
  );
}
