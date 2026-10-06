/**
 * The AIlegro workflow inside the editor: describe a task, build an `ailegro.compose-request/1`,
 * hand it to AIlegro (file download or the local adapter server), and import the
 * `ailegro.compose-result/1` as reviewable suggestions. The contract lives in
 * packages/ailegro-bridge and docs/ailegro-integration.md; this file is only UI glue.
 */
import {
  AILEGRO_GROUPS,
  type AilegroGroup,
  type ScoreDoc,
  findEventOfNote,
  findInstrument,
} from '@ailegro-score/core';
import {
  ANALYSIS_RESULT_SCHEMA,
  type AnalysisRequest,
  type AnalysisResult,
  type ComposeRequest,
  type ComposeResult,
  type ComposeSpec,
  type ComposeTask,
  type HarmonicRhythm,
  type Difficulty,
  type PianoTexture,
  RESULT_SCHEMA,
  type TargetMapping,
  buildAnalysisRequest,
  buildComposeRequest,
  buildScoreRecord,
  planAnalysisImport,
  planComposeImport,
} from '@ailegro-score/ailegro-bridge';
import { translate } from '../i18n';
import { download, safeFileName } from './files';
import { type Selection, getStore } from './store';
import { DEMO_TASKS, demoId } from './demo';

export const APP_VERSION = '0.1.0';

/** Tasks the reference adapter (integrations/ailegro/score_compose.py) can run today. */
export const ADAPTER_TASKS: readonly ComposeTask[] = [
  'continue',
  'melody-from-chords',
  'accompany-melody',
  'develop-motif',
  'orchestrate',
];
export const ALL_TASKS: readonly ComposeTask[] = [
  'continue',
  'melody-from-chords',
  'accompany-melody',
  'develop-motif',
  'orchestrate',
];
/** Tasks whose given material lives in chosen parts. */
export const MATERIAL_TASKS: readonly ComposeTask[] = [
  'accompany-melody',
  'develop-motif',
  'orchestrate',
];

export interface PanelSpec {
  readonly difficulty?: Difficulty;
  readonly maxHandSpan?: number;
  readonly pianoTexture?: PianoTexture;
  readonly task: ComposeTask;
  /** 0-based first measure to write. */
  readonly from: number;
  readonly count: number;
  readonly groups: readonly AilegroGroup[];
  readonly materialParts: readonly string[];
  readonly chordMode: 'free' | 'hold' | 'bar' | 'given';
  readonly seed: number;
  readonly temperature: number;
  readonly topP: number;
  /** null = let the model decide. */
  readonly density: number | null;
  /** How often chords may change where AIlegro chooses them (accompaniment, harmonic analysis). */
  readonly harmonicRhythm: HarmonicRhythm;
}

// ------------------------------------------------------------------------------- defaults

/** Index of the last measure holding any note or rest, or -1 for an empty score. */
export function lastContentMeasure(doc: ScoreDoc): number {
  let last = -1;
  for (const row of Object.values(doc.content)) {
    doc.measures.forEach((m, i) => {
      if (i > last && row[m.id]?.voices.some((v) => v.length > 0)) last = i;
    });
  }
  return last;
}

/** Groups of the instruments in the score, in AIlegro's order. */
export function scoreGroups(doc: ScoreDoc): AilegroGroup[] {
  const present = new Set(doc.parts.map((p) => findInstrument(p.instrument)?.ailegroGroup ?? null));
  return AILEGRO_GROUPS.filter((g) => present.has(g));
}

export function defaultSpec(doc: ScoreDoc, selection: Selection): PanelSpec {
  let from = Math.min(lastContentMeasure(doc) + 1, doc.measures.length);
  let count = 4;
  if (selection.kind === 'range') {
    from = selection.measureFrom;
    count = selection.measureTo - selection.measureFrom + 1;
  } else if (selection.kind === 'notes' && selection.noteIds.length) {
    const loc = findEventOfNote(doc, selection.noteIds[0]!);
    if (loc) from = loc.measureIndex + 1;
  }
  const demo = demoId();
  const task = demo && doc.id.startsWith(`demo-${demo}-`) ? DEMO_TASKS[demo]! : 'continue';
  if (task !== 'continue') {
    from = task === 'develop-motif' ? 4 : 0;
    count = 4;
  }
  return {
    task,
    from,
    count,
    groups: task === 'accompany-melody' ? ['keys'] : scoreGroups(doc),
    materialParts: doc.parts[0] ? [doc.parts[0].id] : [],
    chordMode: doc.harmony.length ? 'given' : 'free',
    seed: 1,
    temperature: 0.9,
    topP: 0.95,
    density: null,
    harmonicRhythm: 'auto',
    difficulty: 'medium',
    pianoTexture: 'model',
  };
}

export function toComposeSpec(p: PanelSpec): ComposeSpec {
  const material = MATERIAL_TASKS.includes(p.task);
  return {
    task: p.task,
    from: p.from,
    count: p.count,
    groups: p.groups,
    ...(material ? { materialParts: p.materialParts } : {}),
    chordMode: p.task === 'melody-from-chords' ? 'given' : p.chordMode,
    seed: p.seed,
    temperature: p.temperature,
    topP: p.topP,
    ...(p.density !== null ? { density: p.density } : {}),
    ...(p.task === 'accompany-melody' ? { harmonicRhythm: p.harmonicRhythm } : {}),
  };
}

// ------------------------------------------------------------------------------- requests

const REQUESTS_KEY = 'ailegro-score:requests';

/** Remember where each request's groups go, so a result imported later lands in the right parts. */
function rememberTargets(request: ComposeRequest): void {
  try {
    const saved = JSON.parse(localStorage.getItem(REQUESTS_KEY) ?? '[]') as {
      id: string;
      targets: TargetMapping[];
    }[];
    const next = [
      { id: request.requestId, targets: [...request.targets] },
      ...saved.filter((x) => x.id !== request.requestId),
    ];
    localStorage.setItem(REQUESTS_KEY, JSON.stringify(next.slice(0, 30)));
  } catch {
    /* storage unavailable: imports fall back to mapping groups by instrument */
  }
}

function targetsFor(requestId: string): TargetMapping[] | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(REQUESTS_KEY) ?? '[]') as {
      id: string;
      targets: TargetMapping[];
    }[];
    return saved.find((x) => x.id === requestId)?.targets;
  } catch {
    return undefined;
  }
}

export function newRequest(spec: PanelSpec): ComposeRequest {
  const s = getStore().getState();
  const request = buildComposeRequest(s.doc, toComposeSpec(spec), {
    requestId: s.ids.next('ai'),
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
  });
  rememberTargets(request);
  return request;
}

export function requestFileName(request: ComposeRequest | AnalysisRequest): string {
  return `ailegro-request-${request.requestId}.json`;
}

export function resultFileName(request: ComposeRequest | AnalysisRequest): string {
  return `ailegro-result-${request.requestId}.json`;
}

/** Download the request; returns it so the panel can show the adapter command. */
export function exportRequest(spec: PanelSpec): ComposeRequest {
  const request = newRequest(spec);
  void download(requestFileName(request), JSON.stringify(request, null, 1));
  return request;
}

export function exportRecord(): void {
  const s = getStore().getState();
  const record = buildScoreRecord(s.doc, { exportedAt: new Date().toISOString() });
  void download(
    safeFileName(s.doc.meta.title, '.score-record.json'),
    JSON.stringify(record, null, 1),
  );
}

// ------------------------------------------------------------------------------- harmonic analysis

/** Bars to analyse: the selected range, otherwise the whole score. */
export function analysisRange(
  doc: ScoreDoc,
  selection: Selection,
): { from: number; count: number } {
  if (selection.kind === 'range')
    return { from: selection.measureFrom, count: selection.measureTo - selection.measureFrom + 1 };
  return { from: 0, count: doc.measures.length };
}

export function newAnalysisRequest(rhythm: HarmonicRhythm): AnalysisRequest {
  const s = getStore().getState();
  return buildAnalysisRequest(
    s.doc,
    { ...analysisRange(s.doc, s.selection), harmonicRhythm: rhythm },
    { requestId: s.ids.next('ai'), createdAt: new Date().toISOString(), appVersion: APP_VERSION },
  );
}

export function exportAnalysisRequest(rhythm: HarmonicRhythm): AnalysisRequest {
  const request = newAnalysisRequest(rhythm);
  void download(requestFileName(request), JSON.stringify(request, null, 1));
  return request;
}

export function importAnalysisResult(result: AnalysisResult): boolean {
  const s = getStore().getState();
  const lang = s.view.lang;
  let plan;
  try {
    plan = planAnalysisImport(s.doc, result, { ids: s.ids, runId: result.requestId });
  } catch (e) {
    s.notify(translate(lang, 'toast.error', { m: (e as Error).message }), 'error');
    return false;
  }
  if (!plan.commands.length) {
    s.notify(translate(lang, 'ai.analysisEmpty'), 'error');
    return false;
  }
  if (!s.apply(plan.commands, 'AIlegro', { selection: { kind: 'none' } })) return false;
  const w = plan.warnings.length
    ? plan.warnings.slice(0, 2).join('; ')
    : translate(lang, 'ai.noWarnings');
  getStore()
    .getState()
    .notify(translate(lang, 'ai.analyzed', { n: plan.stats.chords, w }));
  for (const warning of plan.warnings) console.info('[AIlegro]', warning);
  return true;
}

/** Ask the adapter server (`POST /analyze`) for the chords of the selected bars and import them. */
export async function analyzeWithService(base: string, rhythm: HarmonicRhythm): Promise<boolean> {
  const snapshot = JSON.stringify(getStore().getState().doc);
  const request = newAnalysisRequest(rhythm);
  const res = await fetch(endpoint(base, '/analyze'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* plain-text error */
    }
    throw new Error(message || `HTTP ${res.status}`);
  }
  if (JSON.stringify(getStore().getState().doc) !== snapshot)
    throw new Error(translate(getStore().getState().view.lang, 'candidate.stale'));
  return importAnalysisResult(JSON.parse(text) as AnalysisResult);
}

/** Shell command for the reference adapter, run from the AIlegro project root. */
export function adapterCommand(
  request: ComposeRequest | AnalysisRequest,
  mode: 'file' | 'serve',
): string {
  const script = '"../Score/integrations/ailegro/score_compose.py"';
  if (mode === 'serve') {
    return `cd "<AIlegro>"\n.venv-training/bin/python ${script} \\\n  --serve --checkpoint training/runs/<run>/weights.pt`;
  }
  return (
    `cd "<AIlegro>"\n.venv-training/bin/python ${script} \\\n` +
    `  --request ~/Downloads/${requestFileName(request)} \\\n` +
    `  --checkpoint training/runs/<run>/weights.pt \\\n` +
    `  --output ~/Downloads/${resultFileName(request)}`
  );
}

// ------------------------------------------------------------------------------- results

export function importResult(result: ComposeResult | AnalysisResult): boolean {
  if (result?.schema === ANALYSIS_RESULT_SCHEMA) return importAnalysisResult(result);
  const s = getStore().getState();
  const lang = s.view.lang;
  if (result?.schema !== RESULT_SCHEMA) {
    const schema = (result as { schema?: unknown } | null)?.schema;
    s.notify(translate(lang, 'ai.badResult', { s: String(schema ?? '?') }), 'error');
    return false;
  }
  const targets = targetsFor(result.requestId);
  let plan;
  try {
    plan = planComposeImport(s.doc, result, {
      ids: s.ids,
      runId: result.requestId,
      quantize: 'exact',
      ...(targets ? { targets } : {}),
    });
  } catch (e) {
    s.notify(translate(lang, 'toast.error', { m: (e as Error).message }), 'error');
    return false;
  }
  if (!plan.commands.length) {
    s.notify(translate(lang, 'ai.empty'), 'error');
    return false;
  }
  if (!s.apply(plan.commands, 'AIlegro', { selection: { kind: 'none' } })) return false;
  const w = plan.warnings.length
    ? plan.warnings.slice(0, 2).join('; ')
    : translate(lang, 'ai.noWarnings');
  getStore()
    .getState()
    .notify(translate(lang, 'ai.imported', { n: plan.stats.notes, w }));
  for (const warning of plan.warnings) console.info('[AIlegro]', warning);
  return true;
}

export async function importResultFile(file: File): Promise<boolean> {
  try {
    return importResult(JSON.parse(await file.text()) as ComposeResult | AnalysisResult);
  } catch (e) {
    const s = getStore().getState();
    s.notify(translate(s.view.lang, 'toast.error', { m: (e as Error).message }), 'error');
    return false;
  }
}

// ------------------------------------------------------------------------------- local adapter server

export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8765';
export const SERVICE_KEY = 'ailegro-score:service-url';

/** The adapter server the editor talks to (set and remembered in the AIlegro panel). */
export function serviceUrl(): string {
  try {
    if (typeof window !== 'undefined') {
      const value = new URLSearchParams(window.location.search).get('service');
      if (value) {
        const parsed = new URL(value);
        if (
          parsed.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
        )
          return parsed.origin;
      }
    }
    return localStorage.getItem(SERVICE_KEY) || DEFAULT_SERVICE_URL;
  } catch {
    return DEFAULT_SERVICE_URL;
  }
}

/** What the service can open (PDF / images through Audiveris, recordings through MuScriptor). */
export interface ServiceImports {
  readonly pdf: boolean;
  readonly audio: boolean;
  readonly why?: { readonly pdf?: string; readonly audio?: string };
  readonly instruments?: readonly string[];
}

export interface ServiceInfo {
  readonly ok: boolean;
  readonly model?: string;
  readonly mock?: boolean;
  readonly tasks?: readonly string[];
  readonly imports?: ServiceImports | null;
}

export function endpoint(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}${path}`;
}

export async function pingService(base: string): Promise<ServiceInfo> {
  const res = await fetch(endpoint(base, '/health'), { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ServiceInfo;
}

/** Send a request to the adapter server (`score_compose.py --serve`) and import the result. */
export async function generateWithService(base: string, spec: PanelSpec): Promise<boolean> {
  const snapshot = JSON.stringify(getStore().getState().doc);
  const request = newRequest(spec);
  const res = await fetch(endpoint(base, '/compose'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* plain-text error */
    }
    throw new Error(message || `HTTP ${res.status}`);
  }
  if (JSON.stringify(getStore().getState().doc) !== snapshot)
    throw new Error(translate(getStore().getState().view.lang, 'candidate.stale'));
  return importResult(JSON.parse(text) as ComposeResult);
}

// ------------------------------------------------------------------------------- review

export interface PendingRun {
  readonly runId: string;
  readonly model: string;
  readonly notes: number;
  readonly chords: number;
  /** 0-based measure range touched by the run. */
  readonly firstMeasure: number;
  readonly lastMeasure: number;
}

/** AI suggestions not yet accepted, grouped by run. */
export function pendingRuns(doc: ScoreDoc): PendingRun[] {
  const runs = new Map<
    string,
    { model: string; notes: number; chords: number; first: number; last: number }
  >();
  const touch = (runId: string, model: string, measure: number, notes: number, chords: number) => {
    const r = runs.get(runId) ?? { model, notes: 0, chords: 0, first: measure, last: measure };
    r.notes += notes;
    r.chords += chords;
    r.first = Math.min(r.first, measure);
    r.last = Math.max(r.last, measure);
    runs.set(runId, r);
  };
  const index = new Map(doc.measures.map((m, i) => [m.id, i]));
  for (const row of Object.values(doc.content)) {
    for (const [measureId, sm] of Object.entries(row)) {
      const mi = index.get(measureId) ?? 0;
      for (const voice of sm.voices) {
        for (const e of voice) {
          if (e.source?.kind === 'ai' && !e.source.accepted)
            touch(e.source.runId, e.source.model, mi, e.notes.length, 0);
        }
      }
    }
  }
  for (const h of doc.harmony) {
    if (h.source?.kind === 'ai' && !h.source.accepted)
      touch(h.source.runId, h.source.model, index.get(h.measureId) ?? 0, 0, 1);
  }
  return [...runs.entries()].map(([runId, r]) => ({
    runId,
    model: r.model,
    notes: r.notes,
    chords: r.chords,
    firstMeasure: r.first,
    lastMeasure: r.last,
  }));
}

export function acceptRun(runId: string): void {
  getStore().getState().apply({ type: 'provenance.accept', runId }, 'accept AI');
}

export function rejectRun(runId: string): void {
  getStore()
    .getState()
    .apply({ type: 'provenance.reject', runId }, 'reject AI', { selection: { kind: 'none' } });
}
