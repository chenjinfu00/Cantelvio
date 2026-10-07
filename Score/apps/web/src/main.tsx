import { SAMPLES, randomIds } from '@cantelvio-score/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { artifactDownloads } from './host';
import { restoreAutosave } from './state/files';
import { initStore, initialLang, getStore } from './state/store';
import './styles.css';
import { demoDocument, demoId } from './state/demo';

// Open the last autosaved score of this browser, or the first example on a first visit
// (examples are built with fixed ids, so the opened copy gets its own document id).
const demo = demoId();
initStore(
  restoreAutosave() ??
    (demo
      ? demoDocument(demo)
      : { ...SAMPLES[0]!.build(initialLang()), id: randomIds().next('sc') }),
);

if (demo) initDemoPanel();
function initDemoPanel() {
  getStore().getState().setPanel('ailegro');
}

// Ask the artifact viewer (if any) for its downloads capability early, so Save responds at once.
void artifactDownloads();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
