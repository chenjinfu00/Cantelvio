/** File handling: open/save .ailegro.json, downloads, autosave to this browser. */
import { type ScoreDoc, parseScore, serializeScore } from '@ailegro-score/core';
import { layoutScore, renderPageSvg } from '@ailegro-score/engraving';
import { getStore } from './store';

const AUTOSAVE_KEY = 'ailegro-score:autosave';

export function download(name: string, text: string, type = 'application/json'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(title: string, suffix: string): string {
  const base =
    title
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-') || 'score';
  return `${base}${suffix}`;
}

export function saveScore(): void {
  const s = getStore().getState();
  const doc: ScoreDoc = { ...s.doc, meta: { ...s.doc.meta, modifiedAt: new Date().toISOString() } };
  const name = s.fileName ?? safeFileName(doc.meta.title, '.ailegro.json');
  download(name, serializeScore(doc));
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export async function openScore(): Promise<void> {
  const file = await pickFile('.json,.ailegro.json,application/json');
  if (!file) return;
  const s = getStore().getState();
  try {
    const doc = parseScore(await file.text());
    s.load(doc, file.name);
    s.notify(`✓ ${file.name}`);
  } catch (e) {
    s.notify(String((e as Error).message ?? e), 'error');
  }
}

export function exportSvg(): void {
  const s = getStore().getState();
  const layout = layoutScore(s.doc, { concertPitch: s.view.concertPitch });
  layout.pages.forEach((p) => {
    download(
      safeFileName(s.doc.meta.title, `-p${p.index + 1}.svg`),
      renderPageSvg(p, layout, { size: 'mm' }),
      'image/svg+xml',
    );
  });
}

export function autosave(doc: ScoreDoc): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serializeScore(doc));
  } catch {
    /* storage full or unavailable: autosave is a convenience only */
  }
}

export function restoreAutosave(): ScoreDoc | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    return text ? parseScore(text) : null;
  } catch {
    return null;
  }
}
