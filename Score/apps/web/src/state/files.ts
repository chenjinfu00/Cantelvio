/**
 * Files: open and save `.ailegro.json`, recent files, downloads, autosave to this browser.
 *
 * Where the browser offers the File System Access API (Chrome, Edge; a top-level page), Save
 * writes straight back to the file the score came from, Save As picks a place, and recent files
 * are remembered (their handles live in IndexedDB). Elsewhere — Safari, Firefox, and the
 * claude.ai artifact viewer — Save downloads the file and Open uses the file chooser.
 */
import { type ScoreDoc, parseScore, serializeScore, validateScore } from '@ailegro-score/core';
import { layoutScore, renderPageSvg } from '@ailegro-score/engraving';
import { IN_ARTIFACT, artifactDownloads } from '../host';
import { translate } from '../i18n';
import { getStore, isDirty } from './store';

const AUTOSAVE_KEY = 'ailegro-score:autosave';

// ------------------------------------------------------------------------------- File System Access

interface WritableLike {
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
}

/** The parts of FileSystemFileHandle used here (typed locally; the DOM lib lags behind). */
export interface FileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableLike>;
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry?(other: FileHandleLike): Promise<boolean>;
}

interface PickerOptions {
  readonly types?: readonly {
    readonly description: string;
    readonly accept: Record<string, readonly string[]>;
  }[];
  readonly suggestedName?: string;
  readonly multiple?: boolean;
  readonly id?: string;
  readonly startIn?: FileHandleLike | string;
}

declare global {
  interface Window {
    showOpenFilePicker?: (options?: PickerOptions) => Promise<FileHandleLike[]>;
    showSaveFilePicker?: (options?: PickerOptions) => Promise<FileHandleLike>;
  }
}

/** Native open/save dialogs are available (not inside a frame such as the artifact viewer). */
export const CAN_PICK =
  typeof window !== 'undefined' &&
  typeof window.showSaveFilePicker === 'function' &&
  typeof window.showOpenFilePicker === 'function' &&
  !IN_ARTIFACT &&
  window.self === window.top;

const PICKER: PickerOptions = {
  id: 'ailegro-score',
  types: [{ description: 'AIlegro Score', accept: { 'application/json': ['.json'] } }],
};

/** The file the current document was opened from or last saved to. */
let current: FileHandleLike | null = null;

const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError';

async function permitted(h: FileHandleLike, mode: 'read' | 'readwrite'): Promise<boolean> {
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode })) === 'granted') return true;
  return (await h.requestPermission?.({ mode })) === 'granted';
}

async function writeTo(h: FileHandleLike, text: string): Promise<void> {
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
}

// ------------------------------------------------------------------------------- recent files

export interface RecentFile {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly at: number;
  readonly handle: FileHandleLike;
}

const DB = 'ailegro-score';
const STORE = 'recent';
const MAX_RECENT = 8;

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = run(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Recently opened or saved files, newest first (empty where handles cannot be kept). */
export async function recentFiles(): Promise<RecentFile[]> {
  if (!CAN_PICK) return [];
  try {
    const all = await tx<RecentFile[]>('readonly', (s) => s.getAll() as IDBRequest<RecentFile[]>);
    return all.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

async function remember(h: FileHandleLike, title: string): Promise<void> {
  if (!CAN_PICK) return;
  try {
    const list = await recentFiles();
    for (const r of list) {
      const same = (await r.handle.isSameEntry?.(h).catch(() => false)) ?? r.name === h.name;
      if (same) await tx('readwrite', (s) => s.delete(r.id));
    }
    const entry: RecentFile = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: h.name,
      title,
      at: Date.now(),
      handle: h,
    };
    await tx('readwrite', (s) => s.put(entry));
    for (const old of (await recentFiles()).slice(MAX_RECENT))
      await tx('readwrite', (s) => s.delete(old.id));
  } catch (e) {
    console.warn('[files] could not remember recent file', e);
  }
}

async function forget(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------------------- downloads

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

// ------------------------------------------------------------------------------- save

function fileText(doc: ScoreDoc): string {
  return serializeScore({ ...doc, meta: { ...doc.meta, modifiedAt: new Date().toISOString() } });
}

function savedAs(name: string, downloaded = false): void {
  const s = getStore().getState();
  s.markSaved(name);
  s.notify(translate(s.view.lang, downloaded ? 'files.downloaded' : 'files.saved', { f: name }));
}

/** Save to the file the score came from; the first time, ask where (Save As). */
export async function saveScore(): Promise<boolean> {
  const s = getStore().getState();
  if (current && CAN_PICK) {
    try {
      if (await permitted(current, 'readwrite')) {
        await writeTo(current, fileText(s.doc));
        savedAs(current.name);
        void remember(current, s.doc.meta.title);
        return true;
      }
    } catch (e) {
      console.warn('[files] saving to the open file failed', e);
    }
  }
  return saveScoreAs();
}

/** Save under a new name (a download where the browser has no save dialog). */
export async function saveScoreAs(): Promise<boolean> {
  const s = getStore().getState();
  const name = s.fileName ?? safeFileName(s.doc.meta.title, '.ailegro.json');
  if (CAN_PICK) {
    try {
      const h = await window.showSaveFilePicker!({
        ...PICKER,
        suggestedName: name,
        ...(current ? { startIn: current } : {}),
      });
      await writeTo(h, fileText(getStore().getState().doc));
      current = h;
      savedAs(h.name);
      void remember(h, s.doc.meta.title);
      return true;
    } catch (e) {
      if (isAbort(e)) return false;
      console.warn('[files] save dialog failed, downloading instead', e);
    }
  }
  const ok = await download(name, fileText(s.doc));
  if (ok) savedAs(name, !IN_ARTIFACT);
  return ok;
}

// ------------------------------------------------------------------------------- open

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/**
 * Before replacing the document: offer to save unsaved changes. Resolves false when the user
 * cancels (or saving failed).
 */
export async function confirmDiscard(): Promise<boolean> {
  const s = getStore().getState();
  if (!isDirty(s)) return true;
  const lang = s.view.lang;
  const choice = await s.ask(translate(lang, 'files.unsavedAsk', { t: s.doc.meta.title }), [
    { id: 'save', label: translate(lang, 'files.save'), primary: true },
    { id: 'discard', label: translate(lang, 'files.discard') },
    { id: 'cancel', label: translate(lang, 'files.cancel') },
  ]);
  if (choice === 'save') return saveScore();
  return choice === 'discard';
}

/** Open a score file; `handle` (when known) lets Save write back to it. */
export async function openFile(file: File, handle: FileHandleLike | null = null): Promise<boolean> {
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
      return false;
    }
    s.load(doc, file.name);
    current = handle;
    if (handle) void remember(handle, doc.meta.title);
    s.notify(translate(s.view.lang, 'toast.opened', { f: file.name }));
    return true;
  } catch (e) {
    s.notify(`${file.name}: ${String((e as Error).message ?? e)}`, 'error');
    return false;
  }
}

export async function openScore(): Promise<void> {
  if (!(await confirmDiscard())) return;
  if (CAN_PICK) {
    try {
      const [h] = await window.showOpenFilePicker!({ ...PICKER, multiple: false });
      if (h) await openFile(await h.getFile(), h);
      return;
    } catch (e) {
      if (isAbort(e)) return;
      console.warn('[files] open dialog failed, using the file chooser', e);
    }
  }
  const file = await pickFile('.json,.ailegro.json,application/json');
  if (file) await openFile(file);
}

export async function openRecent(entry: RecentFile): Promise<void> {
  const s = getStore().getState();
  if (!(await confirmDiscard())) return;
  try {
    if (!(await permitted(entry.handle, 'readwrite'))) return;
    await openFile(await entry.handle.getFile(), entry.handle);
  } catch (e) {
    console.warn('[files] recent file unavailable', e);
    s.notify(translate(s.view.lang, 'files.recentGone', { f: entry.name }), 'error');
    await forget(entry.id);
  }
}

/** A file dropped on the window (with its handle where the browser provides one). */
export async function openDropped(item: DataTransferItem | null, file: File): Promise<void> {
  const s = getStore().getState();
  if (!/\.json$/i.test(file.name)) {
    s.notify(translate(s.view.lang, 'files.notScore', { f: file.name }), 'error');
    return;
  }
  if (!(await confirmDiscard())) return;
  let handle: FileHandleLike | null = null;
  const withHandle = item as
    (DataTransferItem & { getAsFileSystemHandle?: () => Promise<unknown> }) | null;
  if (CAN_PICK && withHandle?.getAsFileSystemHandle) {
    try {
      const h = (await withHandle.getAsFileSystemHandle()) as FileHandleLike | null;
      if (h?.kind === 'file') handle = h;
    } catch {
      /* no handle: Save will ask where to save */
    }
  }
  await openFile(file, handle);
}

/** Replace the document by a new or example score (not tied to a file). */
export function loadNew(doc: ScoreDoc): void {
  current = null;
  getStore().getState().load(doc);
}

/** The document is tied to a file on disk (Save writes back without asking). */
export function hasFileHandle(): boolean {
  return current !== null;
}

// ------------------------------------------------------------------------------- export, autosave

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
