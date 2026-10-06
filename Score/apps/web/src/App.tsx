import { useEffect, useState } from 'react';
import { useT } from './i18n';
import { handleKeyDown } from './keyboard/shortcuts';
import { stopPlayback } from './playback/player';
import { ConfirmDialog } from './panels/ConfirmDialog';
import { ImportStatus } from './panels/ImportStatus';
import { Keypad } from './panels/Keypad';
import { NewScoreDialog } from './panels/NewScoreDialog';
import { Palette } from './panels/Palette';
import { SidePanel } from './panels/SidePanel';
import { StatusBar } from './panels/StatusBar';
import { Toast } from './panels/Toast';
import { TopBar } from './panels/TopBar';
import { ScoreView } from './score/ScoreView';
import {
  autosave,
  hasFileHandle,
  openDropped,
  openScore,
  saveScore,
  saveScoreAs,
} from './state/files';
import { getStore, isDirty, useEditor } from './state/store';
import { demoId } from './state/demo';

const AUTOSAVE_DELAY_MS = 800;

export function App() {
  const t = useT();
  const dialog = useEditor((s) => s.dialog);
  const lang = useEditor((s) => s.view.lang);
  const title = useEditor((s) => s.doc.meta.title);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);

  // Global shortcuts (ignored while a dialog is open or while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getStore().getState();
      if (s.dialog || s.confirm) return;
      handleKeyDown(e);
    };
    const onSave = () => void saveScore();
    const onSaveAs = () => void saveScoreAs();
    const onOpen = () => {
      stopPlayback();
      void openScore();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('ailegro:save', onSave);
    window.addEventListener('ailegro:save-as', onSaveAs);
    window.addEventListener('ailegro:open', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('ailegro:save', onSave);
      window.removeEventListener('ailegro:save-as', onSaveAs);
      window.removeEventListener('ailegro:open', onOpen);
    };
  }, []);

  // Leaving with changes that are not in the opened file asks first (new scores live in autosave).
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      const s = getStore().getState();
      if (!isDirty(s) || (!s.fileName && !hasFileHandle())) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);

  // Drop a .ailegro.json or MusicXML file anywhere to open (import) it; PDFs, scanned pages and
  // recordings go to the local AIlegro service.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDropping(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      const item = e.dataTransfer?.items?.[0] ?? null;
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        stopPlayback();
        void openDropped(item, file);
      }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // Autosave to this browser shortly after every change (a convenience, not the file on disk).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = getStore().subscribe((s, prev) => {
      if (s.doc === prev.doc) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        autosave(getStore().getState().doc);
        setSavedAt(Date.now());
      }, AUTOSAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);
  useEffect(() => {
    document.title = `${title} · AIlegro Score`;
  }, [title]);

  return (
    <div className={demoId() ? 'app demo-app' : 'app'}>
      <TopBar />
      {demoId() && (
        <div className="demo-banner">
          <span>{t('demo.draft')}</span>
          <a href="http://127.0.0.1:4187/demo/" target="_blank" rel="noreferrer">
            {t('demo.home')}
          </a>
        </div>
      )}
      <Palette />
      <main className="workspace">
        <ScoreView />
        <SidePanel />
      </main>
      <StatusBar savedAt={savedAt} />
      <Keypad />
      {dialog === 'new' && <NewScoreDialog />}
      <ConfirmDialog />
      {dropping && (
        <div className="drop-overlay" aria-hidden>
          <span>{t('files.dropHint')}</span>
        </div>
      )}
      <ImportStatus />
      <Toast />
    </div>
  );
}
