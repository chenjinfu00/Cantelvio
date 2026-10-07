/**
 * Open a PDF / scanned page or a recording through the local Cantelvio service (the adapter server,
 * `npm run cantelvio:serve`). The file is uploaded, Audiveris (PDF) or MuScriptor + Cantelvio's
 * audio_to_score.py (recording) run there as a background job, the editor polls the job and imports
 * the MusicXML it gets back into a new, unsaved score. The job API (`ailegro-score.import-job/1`)
 * is described in docs/ailegro-integration.md and ADR 0013.
 */
import { importMusicXml, musicXmlFromBytes } from '@cantelvio-score/core';
import { useSyncExternalStore } from 'react';
import { type Lang, translate } from '../i18n';
import { IN_STATIC_PREVIEW, LOCAL_SERVICE_UNAVAILABLE } from '../host';
import { endpoint, serviceUrl } from './ailegro';
import { confirmDiscard, inflateRaw, openImportedDoc } from './files';
import { getStore } from './store';

export type ImportKind = 'pdf' | 'audio';

const PDF_FILE = /\.(pdf|png|jpe?g|tiff?|bmp)$/i;
const AUDIO_FILE = /\.(wav|mp3|flac|ogg|m4a|aac|aiff?)$/i;
export const PDF_ACCEPT = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,application/pdf';
export const AUDIO_ACCEPT = '.wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff';

/** Which service job opens this file, if any (by name). */
export function importKindOf(name: string): ImportKind | null {
  return PDF_FILE.test(name) ? 'pdf' : AUDIO_FILE.test(name) ? 'audio' : null;
}

/** MuScriptor instrument groups offered as hints (the service passes any group name on). */
export const AUDIO_GROUPS = [
  'acoustic_piano',
  'voice',
  'violin',
  'viola',
  'cello',
  'contrabass',
  'string_ensemble',
  'flutes',
  'oboe',
  'clarinet',
  'bassoon',
  'french_horn',
  'trumpet',
  'trombone',
  'tuba',
  'timpani',
  'orchestral_harp',
  'organ',
  'acoustic_guitar',
  'electric_piano',
] as const;

export const METRES = ['2/4', '3/4', '4/4', '2/2', '3/8', '6/8', '9/8', '12/8'] as const;

export interface ImportOptions {
  /** PDF: pages to read, e.g. "1 3-4" (empty: all). */
  readonly sheets: string;
  /** PDF: the print shows concert pitch (no written-pitch reading of transposing parts). */
  readonly concert: boolean;
  /** Recording: MuScriptor instrument groups that play (empty: the model decides). */
  readonly instruments: readonly string[];
  /** Recording: one piano part (a reduction of everything). */
  readonly piano: boolean;
  /** Recording: the metre, e.g. 3/4 or 6/8 (empty: from the tracked beats). */
  readonly metre: string;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  sheets: '',
  concert: false,
  instruments: [],
  piano: false,
  metre: '',
};

const OPTIONS_KEY = 'ailegro-score:import-options';

export function loadImportOptions(): ImportOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null') as Partial<ImportOptions>;
    if (!raw || typeof raw !== 'object') return DEFAULT_IMPORT_OPTIONS;
    return {
      sheets: typeof raw.sheets === 'string' ? raw.sheets : '',
      concert: raw.concert === true,
      instruments: Array.isArray(raw.instruments)
        ? raw.instruments.filter((g): g is string => typeof g === 'string')
        : [],
      piano: raw.piano === true,
      metre: typeof raw.metre === 'string' ? raw.metre : '',
    };
  } catch {
    return DEFAULT_IMPORT_OPTIONS;
  }
}

export function saveImportOptions(options: ImportOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    /* private mode: the options last for this page only */
  }
}

/** Query string of an upload: the file name and the options that apply to its kind. */
export function uploadQuery(kind: ImportKind, name: string, o: ImportOptions): string {
  const q = new URLSearchParams({ name });
  if (kind === 'pdf') {
    if (o.sheets.trim()) q.set('sheets', o.sheets.trim());
  } else {
    if (o.instruments.length) q.set('instruments', o.instruments.join(','));
    if (o.piano) q.set('piano', '1');
    if (o.metre) q.set('metre', o.metre);
  }
  return q.toString();
}

// ------------------------------------------------------------------------------- jobs

export interface ImportFile {
  readonly name: string;
  readonly format: 'mxl' | 'musicxml';
  /** Base64. */
  readonly data: string;
}

/** A job as the service reports it (`ailegro-score.import-job/1`). */
export interface ImportJob {
  readonly id: string;
  readonly kind: ImportKind;
  readonly name: string;
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly stage: string;
  readonly progress: readonly [number, number] | null;
  readonly elapsed: number;
  readonly log?: readonly string[];
  readonly error?: string;
  readonly result?: {
    readonly files: readonly ImportFile[];
    readonly warnings: readonly string[];
    readonly report: Record<string, unknown>;
  };
}

export type ImportPhase = 'uploading' | 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';

/** What the status chip shows. `ready`: the result waits to be opened (see openImportResult). */
export interface ImportStatus {
  readonly kind: ImportKind;
  readonly name: string;
  readonly phase: ImportPhase;
  readonly stage: string;
  readonly progress: readonly [number, number] | null;
  readonly elapsed: number;
  readonly error?: string;
  readonly jobId?: string;
}

let status: ImportStatus | null = null;
let ready: { job: ImportJob; options: ImportOptions } | null = null;
let cancelRequested = false;
const listeners = new Set<() => void>();

function setStatus(next: ImportStatus | null): void {
  status = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getImportStatus(): ImportStatus | null {
  return status;
}

export function useImportStatus(): ImportStatus | null {
  return useSyncExternalStore(subscribe, getImportStatus, getImportStatus);
}

const busy = (s: ImportStatus | null) =>
  !!s && (s.phase === 'uploading' || s.phase === 'queued' || s.phase === 'running');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  if (!res.ok) {
    const error = (body as { error?: string } | null)?.error;
    throw new Error(error || text || `HTTP ${res.status}`);
  }
  return body as T;
}

function fromJob(job: ImportJob): ImportStatus {
  return {
    kind: job.kind,
    name: job.name,
    phase: job.state === 'done' ? 'ready' : job.state,
    stage: job.stage,
    progress: job.progress,
    elapsed: job.elapsed,
    jobId: job.id,
    ...(job.error ? { error: job.error } : {}),
  };
}

/**
 * Upload `file` to the service, follow the job and open the result. Resolves true once the job
 * has started (the result opens later); false when the service is missing or refuses the file.
 */
export async function importViaService(
  file: File,
  kind: ImportKind,
  options: ImportOptions = loadImportOptions(),
): Promise<boolean> {
  const lang = getStore().getState().view.lang;
  if (LOCAL_SERVICE_UNAVAILABLE) {
    getStore()
      .getState()
      .notify(
        translate(lang, IN_STATIC_PREVIEW ? 'preview.importUnavailable' : 'import.unavailable'),
        'error',
      );
    return false;
  }
  if (busy(status)) {
    getStore().getState().notify(translate(lang, 'import.busy'), 'error');
    return false;
  }
  const base = serviceUrl();
  const failed = (error: string) => {
    setStatus({
      kind,
      name: file.name,
      phase: 'failed',
      stage: 'failed',
      progress: null,
      elapsed: 0,
      error,
    });
    return false;
  };
  ready = null;
  cancelRequested = false;
  setStatus({
    kind,
    name: file.name,
    phase: 'uploading',
    stage: 'uploading',
    progress: null,
    elapsed: 0,
  });
  let job: ImportJob;
  try {
    const health = await json<{
      imports?: { pdf: boolean; audio: boolean; why?: Record<string, string> };
    }>(await fetch(endpoint(base, '/health')));
    if (!health.imports?.[kind])
      return failed(
        translate(lang, 'import.notAvailable', {
          w: health.imports?.why?.[kind] ?? translate(lang, 'import.oldService'),
        }),
      );
    job = await json<ImportJob>(
      await fetch(endpoint(base, `/import/${kind}?${uploadQuery(kind, file.name, options)}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      }),
    );
  } catch (e) {
    return failed(
      e instanceof TypeError
        ? translate(lang, 'import.offline', { u: base })
        : String((e as Error).message ?? e),
    );
  }
  void follow(base, job, options);
  return true;
}

async function follow(base: string, first: ImportJob, options: ImportOptions): Promise<void> {
  const lang = getStore().getState().view.lang;
  let job = first;
  let misses = 0;
  while (job.state === 'queued' || job.state === 'running') {
    setStatus(fromJob(job));
    await sleep(job.state === 'queued' ? 1000 : 700);
    try {
      job = await json<ImportJob>(await fetch(endpoint(base, `/jobs/${job.id}`)));
      misses = 0;
    } catch (e) {
      if (++misses < 5) continue; // the service may be busy for a moment
      setStatus({
        ...fromJob(job),
        phase: 'failed',
        error:
          e instanceof TypeError
            ? translate(lang, 'import.offline', { u: base })
            : String((e as Error).message ?? e),
      });
      return;
    }
  }
  if (job.state !== 'done' || !job.result?.files.length) {
    setStatus({
      ...fromJob(job),
      phase: cancelRequested || job.state === 'cancelled' ? 'cancelled' : 'failed',
      error: job.error ?? translate(lang, 'import.noResult'),
    });
    return;
  }
  ready = { job, options };
  setStatus(fromJob(job));
  await openImportResult();
}

/** Ask the service to stop the running job. */
export async function cancelImport(): Promise<void> {
  const s = status;
  if (!s?.jobId || !busy(s)) {
    if (s && s.phase === 'uploading') cancelRequested = true;
    return;
  }
  cancelRequested = true;
  try {
    await fetch(endpoint(serviceUrl(), `/jobs/${s.jobId}`), { method: 'DELETE' });
  } catch {
    /* the poll reports what happened */
  }
}

/** Forget a finished, failed or cancelled job (the chip disappears). */
export function dismissImport(): void {
  if (busy(status)) return;
  ready = null;
  setStatus(null);
}

/** Bytes of a base64 string (results come back as base64 in the job's JSON). */
export function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The MusicXML text of a result file (`.mxl` archives are unpacked). */
export async function resultXml(file: ImportFile): Promise<string> {
  const bytes = fromBase64(file.data);
  if (file.format === 'mxl') return (await musicXmlFromBytes(bytes, inflateRaw)).xml;
  return new TextDecoder().decode(bytes);
}

/** One line on what the job produced, for the notice when the score opens. */
export function importSummary(lang: Lang, job: ImportJob): string {
  const report = job.result?.report ?? {};
  const num = (key: string) => (typeof report[key] === 'number' ? (report[key] as number) : null);
  if (job.kind === 'audio') {
    const qpm = num('qpm');
    return translate(lang, 'import.doneAudio', {
      f: job.name,
      k: num('kept') ?? '?',
      n: num('notes') ?? '?',
      m: typeof report.metre === 'string' ? report.metre : '?',
      q: qpm == null ? '?' : Math.round(qpm),
      b: num('bars') ?? '?',
    });
  }
  const movements = job.result?.files.length ?? 0;
  return (
    translate(lang, 'import.donePdf', { f: job.name, p: num('sheets') ?? '?' }) +
    (movements > 1 ? translate(lang, 'import.movements', { n: movements }) : '')
  );
}

/**
 * Open the finished job's score. When the current score has unsaved changes the user is asked
 * first; if they cancel, the result stays ready (the chip offers "Open result" again).
 */
export async function openImportResult(): Promise<boolean> {
  const r = ready;
  if (!r) return false;
  if (!(await confirmDiscard())) return false;
  const s = getStore().getState();
  const lang = s.view.lang;
  try {
    const first = r.job.result!.files[0]!;
    const result = importMusicXml(await resultXml(first), {
      ids: s.ids,
      now: new Date().toISOString(),
      fileName: r.job.name,
      lang,
      ...(r.job.kind === 'pdf'
        ? { writtenPitch: !r.options.concert, trustTimeSignatures: true }
        : {}),
    });
    const warnings = [...(r.job.result!.warnings ?? []), ...result.warnings];
    if (!openImportedDoc(result.doc, r.job.name, warnings, importSummary(lang, r.job)))
      return false;
  } catch (e) {
    setStatus({ ...fromJob(r.job), phase: 'failed', error: String((e as Error).message ?? e) });
    ready = null;
    return false;
  }
  ready = null;
  setStatus(null);
  return true;
}
