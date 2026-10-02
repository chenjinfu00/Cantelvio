import { useEffect, useState } from 'react';
import { handleKeyDown } from './keyboard/shortcuts';
import { NewScoreDialog } from './panels/NewScoreDialog';
import { Palette } from './panels/Palette';
import { SidePanel } from './panels/SidePanel';
import { StatusBar } from './panels/StatusBar';
import { Toast } from './panels/Toast';
import { TopBar } from './panels/TopBar';
import { ScoreView } from './score/ScoreView';
import { autosave, saveScore } from './state/files';
import { getStore, useEditor } from './state/store';

const AUTOSAVE_DELAY_MS = 800;

export function App() {
  const dialog = useEditor((s) => s.dialog);
  const lang = useEditor((s) => s.view.lang);
  const title = useEditor((s) => s.doc.meta.title);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Global shortcuts (ignored while a dialog is open or while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getStore().getState().dialog) return;
      handleKeyDown(e);
    };
    const onSave = () => saveScore();
    window.addEventListener('keydown', onKey);
    window.addEventListener('ailegro:save', onSave);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('ailegro:save', onSave);
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
    <div className="app">
      <TopBar />
      <Palette />
      <main className="workspace">
        <ScoreView />
        <SidePanel />
      </main>
      <StatusBar savedAt={savedAt} />
      {dialog === 'new' && <NewScoreDialog />}
      <Toast />
    </div>
  );
}
