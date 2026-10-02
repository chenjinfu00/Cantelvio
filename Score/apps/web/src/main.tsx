import { SAMPLES, randomIds } from '@ailegro-score/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { restoreAutosave } from './state/files';
import { initStore, initialLang } from './state/store';
import './styles.css';

// Open the last autosaved score of this browser, or the first example on a first visit
// (examples are built with fixed ids, so the opened copy gets its own document id).
initStore(restoreAutosave() ?? { ...SAMPLES[0]!.build(initialLang()), id: randomIds().next('sc') });

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
