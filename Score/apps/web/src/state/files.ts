/** File handling: open/save .ailegro.json, downloads, autosave to this browser. */
import { type ScoreDoc, parseScore, serializeScore, validateScore } from '@ailegro-score/core';
import { layoutScore, renderPageSvg } from '@ailegro-score/engraving';
import { artifactDownloads } from '../host';
import { translate } from '../i18n';
import { getStore } from './store';

const AUTOSAVE_KEY = 'ailegro-score:autosave';

/**
 * Offer a file to the user. Inside a claude.ai artifact the viewer's `downloads` capability shows a
 * confirmation (plain links are inert there); locally a regular browser download starts.
 * Resolves false when nothing was saved.
 */
export async function download(
  name: string,
  text: string,
  type = 'application/json',
): Promise<boolean> {
  const viewer = await artifactDownloads();
  if (viewer) {
    try {
      await viewer.save({ filename: name, data: text });
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code ?? String(e);
      if (code !== 'declined') {
        const s = getStore().getState();
        s.notify(translate(s.view.lang, 'files.saveFailed', { f: name, m: code }), 'error');
      }
      return false;
    }
  }
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function safeFileName(title: string, suffix: string): string {
  const base =
    title
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-') || 'score';
  return `${base}${suffix}`;
}

export function saveScore(): Promise<boolean> {
  const s = getStore().getState();
  const doc: ScoreDoc = { ...s.doc, meta: { ...s.doc.meta, modifiedAt: new Date().toISOString() } };
  const name = s.fileName ?? safeFileName(doc.meta.title, '.ailegro.json');
  return download(name, serializeScore(doc));
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
    // Hand-edited or foreign files must keep the model's invariants before they are opened.
    const issues = validateScore(doc);
    if (issues.length) {
      console.warn('[open] invalid score', issues);
      const first = issues[0]!;
      s.notify(
        `${file.name}: ${first.path} — ${first.message}${issues.length > 1 ? ` (+${issues.length - 1})` : ''}`,
        'error',
      );
      return;
    }
    s.load(doc, file.name);
    s.notify(`✓ ${file.name}`);
  } catch (e) {
    s.notify(String((e as Error).message ?? e), 'error');
  }
}

/** One SVG per page, offered one after another (the artifact viewer confirms each file). */
export async function exportSvg(): Promise<void> {
  const s = getStore().getState();
  const layout = layoutScore(s.doc, { concertPitch: s.view.concertPitch });
  for (const p of layout.pages) {
    const ok = await download(
      safeFileName(s.doc.meta.title, `-p${p.index + 1}.svg`),
      renderPageSvg(p, layout, { size: 'mm' }),
      'image/svg+xml',
    );
    if (!ok) return;
  }
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
    const doc = text ? parseScore(text) : null;
    return doc && validateScore(doc).length === 0 ? doc : null;
  } catch {
    return null;
  }
}
