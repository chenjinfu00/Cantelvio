/**
 * Files: open and save `.cantelvio.json`, import MusicXML (`.musicxml`, `.xml`, `.mxl`), recent
 * files, downloads, autosave to this browser. PDFs, scanned pages and recordings are opened through
 * the local Cantelvio service (./service-import.ts).
 *
 * Where the browser offers the File System Access API (Chrome, Edge; a top-level page), Save
 * writes straight back to the file the score came from, Save As picks a place, and recent files
 * are remembered (their handles live in IndexedDB). Elsewhere — Safari, Firefox, and the
 * claude.ai artifact viewer — Save downloads the file and Open uses the file chooser.
 */
import {
  MUSICXML_FILE_PATTERN,
  type ScoreDoc,
  importMusicXml,
  musicXmlFromBytes,
  parseScore,
  serializeScore,
  validateScore,
} from '@cantelvio-score/core';
import { layoutScore, renderPageSvg } from '@cantelvio-score/engraving';
import { IN_ARTIFACT, artifactDownloads } from '../host';
import { translate } from '../i18n';
import { importKindOf, importViaService } from './service-import';
import { currentEntry, getStore, isDirty } from './store';
import { demoId } from './demo';
import { rebrandBuiltinDraft } from './branding';

const AUTOSAVE_KEY = demoId()
  ? `ailegro-score:demo-autosave:${demoId()}`
  : 'ailegro-score:autosave';

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
  types: [{ description: 'Cantelvio Score', accept: { 'application/json': ['.json'] } }],
};

/**
 * Open also offers MusicXML, which is imported (Save then writes a .cantelvio.json), and PDFs,
 * scanned pages and recordings, which the local Cantelvio service turns into MusicXML first.
 */
const OPEN_PICKER: PickerOptions = {
  id: 'ailegro-score',
  types: [
    {
      description: 'Cantelvio Score, MusicXML',
      accept: {
        'application/json': ['.json'],
        'application/vnd.recordare.musicxml+xml': ['.musicxml', '.xml'],
        'application/vnd.recordare.musicxml': ['.mxl'],
      },
    },
    {
      description: 'PDF, scanned pages (Audiveris)',
      accept: {
        'application/pdf': ['.pdf'],
        'image/png': ['.png'],
        'image/jpeg': ['.jpg', '.jpeg'],
        'image/tiff': ['.tif', '.tiff'],
      },
    },
    {
      description: 'Recordings (MuScriptor)',
      accept: {
        'audio/wav': ['.wav'],
        'audio/mpeg': ['.mp3'],
        'audio/flac': ['.flac'],
        'audio/ogg': ['.ogg'],
        'audio/mp4': ['.m4a', '.aac'],
        'audio/aiff': ['.aif', '.aiff'],
      },
    },
  ],
};

const OPEN_ACCEPT =
  '.json,.cantelvio.json,.ailegro.json,application/json,.musicxml,.xml,.mxl,' +
  '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff';

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

// Keep the existing database and storage keys so the rebrand preserves saved file handles.
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
  text: string | Blob,
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
  const blob = text instanceof Blob ? text : new Blob([text], { type });
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

/** The document together with the history entry it was taken at. */
interface Snapshot {
  readonly doc: ScoreDoc;
  readonly entry: ReturnType<typeof currentEntry>;
}

function snapshot(): Snapshot {
  const s = getStore().getState();
  return { doc: s.doc, entry: currentEntry(s) };
}

/** Write the document as it is now; edits made while the file is written stay unsaved. */
async function writeSnapshot(h: FileHandleLike): Promise<Snapshot> {
  const snap = snapshot();
  await writeTo(h, fileText(snap.doc));
  return snap;
}

function savedAs(name: string, snap: Snapshot, downloaded = false): void {
  const s = getStore().getState();
  s.markSaved(name, snap.entry);
  s.notify(translate(s.view.lang, downloaded ? 'files.downloaded' : 'files.saved', { f: name }));
}

/** Save to the file the score came from; the first time, ask where (Save As). */
export async function saveScore(): Promise<boolean> {
  if (current && CAN_PICK) {
    const h = current;
    try {
      if (await permitted(h, 'readwrite')) {
        const snap = await writeSnapshot(h);
        savedAs(h.name, snap);
        void remember(h, snap.doc.meta.title);
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
  const name =
    s.fileName?.replace(/\.ailegro\.json$/i, '.cantelvio.json') ??
    safeFileName(s.doc.meta.title, '.cantelvio.json');
  if (CAN_PICK) {
    try {
      const h = await window.showSaveFilePicker!({
        ...PICKER,
        suggestedName: name,
        ...(current ? { startIn: current } : {}),
      });
      const snap = await writeSnapshot(h);
      current = h;
      savedAs(h.name, snap);
      void remember(h, snap.doc.meta.title);
      return true;
    } catch (e) {
      if (isAbort(e)) return false;
      console.warn('[files] save dialog failed, downloading instead', e);
    }
  }
  const snap = snapshot();
  const ok = await download(name, fileText(snap.doc));
  if (ok) savedAs(name, snap, !IN_ARTIFACT);
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

/** The page may open a dialog now (a click happened moments ago and was not used up). */
function hasUserActivation(): boolean {
  const ua = (globalThis.navigator as { userActivation?: { isActive: boolean } } | undefined)
    ?.userActivation;
  return ua?.isActive ?? false;
}

/**
 * Before replacing the document: offer to save unsaved changes. Resolves false when the user
 * cancels (or saving failed). `thenDialog`: the caller opens a file dialog or permission prompt
 * next, which browsers allow only right after a click; a save dialog uses that click up, so the
 * user is asked once more (and that click opens the dialog).
 */
export async function confirmDiscard(opts: { thenDialog?: boolean } = {}): Promise<boolean> {
  const s = getStore().getState();
  if (!isDirty(s)) return true;
  const lang = s.view.lang;
  const choice = await s.ask(translate(lang, 'files.unsavedAsk', { t: s.doc.meta.title }), [
    { id: 'save', label: translate(lang, 'files.save'), primary: true },
    { id: 'discard', label: translate(lang, 'files.discard') },
    { id: 'cancel', label: translate(lang, 'files.cancel') },
  ]);
  if (choice !== 'save') return choice === 'discard';
  if (!(await saveScore())) return false;
  if (!opts.thenDialog || hasUserActivation()) return true;
  const go = await s.ask(translate(lang, 'files.savedContinue'), [
    { id: 'go', label: translate(lang, 'files.continue'), primary: true },
    { id: 'cancel', label: translate(lang, 'files.cancel') },
  ]);
  return go === 'go';
}

/** Raw DEFLATE with the browser's DecompressionStream (for `.mxl` archives). */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A MusicXML file (by name): imported rather than opened. */
export const isMusicXmlFile = (name: string): boolean => MUSICXML_FILE_PATTERN.test(name);

/** A document that may come from a hand-edited or foreign file keeps the model's invariants. */
function invalid(doc: ScoreDoc, fileName: string): boolean {
  const issues = validateScore(doc);
  if (!issues.length) return false;
  console.warn('[open] invalid score', issues);
  const first = issues[0]!;
  getStore()
    .getState()
    .notify(
      `${fileName}: ${first.path} — ${first.message}${issues.length > 1 ? ` (+${issues.length - 1})` : ''}`,
      'error',
    );
  return true;
}

/**
 * Load an imported document (MusicXML, or what the Cantelvio service made of a PDF or recording) as
 * a new, unsaved score: Save asks where to write the `.cantelvio.json`, never over the source file.
 * `message` replaces the default notice; skipped or approximated content goes to the console.
 */
export function openImportedDoc(
  doc: ScoreDoc,
  fileName: string,
  warnings: readonly string[],
  message?: string,
): boolean {
  if (invalid(doc, fileName)) return false;
  const s = getStore().getState();
  const lang = s.view.lang;
  s.load(doc, null);
  current = null;
  const shown = warnings.slice(0, 2).join('; ');
  const more = warnings.length > 2 ? ` (+${warnings.length - 2})` : '';
  s.notify(
    message ??
      (warnings.length
        ? translate(lang, 'files.importedWarnings', { f: fileName, w: shown + more })
        : translate(lang, 'files.imported', { f: fileName })),
  );
  for (const warning of warnings) console.info('[MusicXML]', warning);
  return true;
}

/**
 * Open a score file; `handle` (when known) lets Save write back to it. MusicXML is imported into
 * a new, unsaved document. PDFs, scanned pages and recordings go to the local Cantelvio service,
 * which runs in the background; the result opens when it is ready (resolves true once started).
 */
export async function openFile(file: File, handle: FileHandleLike | null = null): Promise<boolean> {
  const s = getStore().getState();
  const lang = s.view.lang;
  const kind = importKindOf(file.name);
  if (kind) return importViaService(file, kind);
  try {
    if (isMusicXmlFile(file.name)) {
      const { xml } = await musicXmlFromBytes(new Uint8Array(await file.arrayBuffer()), inflateRaw);
      const result = importMusicXml(xml, {
        ids: s.ids,
        now: new Date().toISOString(),
        fileName: file.name,
        lang,
      });
      return openImportedDoc(result.doc, file.name, result.warnings);
    }
    const doc = parseScore(await file.text());
    if (invalid(doc, file.name)) return false;
    s.load(doc, file.name);
    current = handle;
    if (handle) void remember(handle, doc.meta.title);
    s.notify(translate(lang, 'toast.opened', { f: file.name }));
    return true;
  } catch (e) {
    s.notify(`${file.name}: ${String((e as Error).message ?? e)}`, 'error');
    return false;
  }
}

export async function openScore(): Promise<void> {
  if (!(await confirmDiscard({ thenDialog: true }))) return;
  if (CAN_PICK) {
    try {
      const [h] = await window.showOpenFilePicker!({ ...OPEN_PICKER, multiple: false });
      if (h) await openFile(await h.getFile(), h);
      return;
    } catch (e) {
      if (isAbort(e)) return;
      console.warn('[files] open dialog failed, using the file chooser', e);
    }
  }
  const file = await pickFile(OPEN_ACCEPT);
  if (file) await openFile(file);
}

export async function openRecent(entry: RecentFile): Promise<void> {
  const s = getStore().getState();
  if (!(await confirmDiscard({ thenDialog: true }))) return;
  try {
    if (!(await permitted(entry.handle, 'readwrite'))) return;
    await openFile(await entry.handle.getFile(), entry.handle);
  } catch (e) {
    console.warn('[files] recent file unavailable', e);
    s.notify(translate(s.view.lang, 'files.recentGone', { f: entry.name }), 'error');
    await forget(entry.id);
  }
}

/**
 * A file dropped on the window (with its handle where the browser provides one). Call it from
 * the drop event itself: the dropped data can only be read while the event is handled.
 */
export async function openDropped(item: DataTransferItem | null, file: File): Promise<void> {
  const s = getStore().getState();
  if (importKindOf(file.name)) {
    await openFile(file); // the service runs in the background; nothing is replaced until it is done
    return;
  }
  if (!/\.json$/i.test(file.name) && !isMusicXmlFile(file.name)) {
    s.notify(translate(s.view.lang, 'files.notScore', { f: file.name }), 'error');
    return;
  }
  // ask for the handle before anything is awaited (no handle: Save will ask where to save)
  const withHandle = item as
    (DataTransferItem & { getAsFileSystemHandle?: () => Promise<unknown> }) | null;
  const pending: Promise<FileHandleLike | null> =
    CAN_PICK && withHandle?.getAsFileSystemHandle
      ? withHandle
          .getAsFileSystemHandle()
          .then((h) =>
            (h as FileHandleLike | null)?.kind === 'file' ? (h as FileHandleLike) : null,
          )
          .catch(() => null)
      : Promise.resolve(null);
  if (!(await confirmDiscard())) return;
  await openFile(file, await pending);
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

export async function exportMidi(): Promise<void> {
  const s = getStore().getState();
  try {
    const { scoreToMidi } = await import('../export/midi');
    const data = scoreToMidi(s.doc);
    await download(
      safeFileName(s.doc.meta.title, '.mid'),
      new Blob([new Uint8Array(data).buffer], { type: 'audio/midi' }),
    );
  } catch (e) {
    s.notify(translate(s.view.lang, 'files.exportFailed', { m: String(e) }), 'error');
  }
}

export async function exportPdf(): Promise<void> {
  const s = getStore().getState();
  try {
    const { scoreToPdf } = await import('../export/pdf');
    await download(
      safeFileName(s.doc.meta.title, '.pdf'),
      await scoreToPdf(s.doc, s.view.concertPitch),
    );
  } catch (e) {
    s.notify(translate(s.view.lang, 'files.exportFailed', { m: String(e) }), 'error');
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
    return doc && validateScore(doc).length === 0 ? rebrandBuiltinDraft(doc) : null;
  } catch {
    return null;
  }
}
