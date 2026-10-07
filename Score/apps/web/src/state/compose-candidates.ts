/** Generation candidates stay outside the edited document until a checked, undoable acceptance. */
import {
  type Command,
  type ScoreDoc,
  type Rational,
  applyCommand,
  add,
  sub,
  sum,
  parseRational,
  toString as rationalString,
  cmp,
  measureInfos,
  rat,
  validateScore,
} from '@cantelvio-score/core';
import {
  type ComposeRequest,
  type ComposeResult,
  type PerformanceReport,
  RESULT_SCHEMA,
  buildComposeRequest,
  planComposeImport,
} from '@cantelvio-score/compose-bridge';
import { create } from 'zustand';
import { translate, type MessageKey } from '../i18n';
import {
  APP_VERSION,
  assertServiceAvailable,
  endpoint,
  toComposeSpec,
  type PanelSpec,
} from './ailegro';
import { getStore } from './store';

export interface ComposeCandidate {
  readonly performance?: PerformanceReport;
  readonly id: string;
  readonly request: ComposeRequest;
  readonly result: ComposeResult;
  readonly base: ScoreDoc;
  readonly fingerprint: string;
  readonly preview: ScoreDoc;
  readonly commands: readonly Command[];
  readonly seconds: number;
  readonly notes: number;
  readonly warnings: readonly string[];
  readonly clippedTails: number;
}
interface CandidateState {
  readonly candidates: readonly ComposeCandidate[];
  readonly busy: boolean;
  readonly completed: number;
  readonly total: number;
}
export const useComposeCandidates = create<CandidateState>(() => ({
  candidates: [],
  busy: false,
  completed: 0,
  total: 0,
}));
let operation = 0;
let controller: AbortController | null = null;

function fail(key: MessageKey): never {
  throw new Error(translate(getStore().getState().view.lang, key));
}
export const documentFingerprint = (doc: ScoreDoc): string => JSON.stringify(doc);
export function cancelCandidates(): void {
  operation++;
  controller?.abort();
  controller = null;
  useComposeCandidates.setState({ busy: false });
}
export function clearCandidates(): void {
  cancelCandidates();
  useComposeCandidates.setState({ candidates: [], completed: 0, total: 0 });
}

export async function generateCandidates(
  baseUrl: string,
  spec: PanelSpec,
  count = 1,
): Promise<void> {
  assertServiceAvailable();
  if (useComposeCandidates.getState().busy) return;
  if (!Number.isInteger(count) || count < 1 || count > 4) fail('candidate.invalid');
  const state = getStore().getState(),
    base = state.doc,
    fingerprint = documentFingerprint(base);
  const token = ++operation;
  useComposeCandidates.setState({ candidates: [], busy: true, completed: 0, total: count });
  try {
    for (let i = 0; i < count; i++) {
      if (token !== operation) return;
      const request = buildComposeRequest(base, toComposeSpec({ ...spec, seed: spec.seed + i }), {
        requestId: state.ids.next('ai'),
        createdAt: new Date().toISOString(),
        appVersion: APP_VERSION,
      });
      if (!request.targets.some((t) => t.parts.length)) fail('candidate.noTargets');
      controller = new AbortController();
      const started = performance.now();
      const response = await fetch(endpoint(baseUrl, '/compose'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const result = (await response.json()) as ComposeResult & { error?: string };
      if (token !== operation) return;
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      if (
        result.schema !== RESULT_SCHEMA ||
        result.requestId !== request.requestId ||
        result.startBar !== request.generate.bars.from ||
        result.bars.length !== request.generate.bars.count
      )
        fail('candidate.invalid');
      if (getStore().getState().doc.id !== base.id) fail('candidate.stale');
      // A bounded request cannot write a generated tail into unrequested later measures.
      // Preserve the raw result for review; end only those tails at the requested edge.
      let clippedTails = 0;
      const bounded: ComposeResult = {
        ...result,
        bars: result.bars.map((bar, index) => {
          const remaining = sum(result.bars.slice(index).map((b) => parseRational(b.length)));
          return {
            ...bar,
            notes: bar.notes.map((note) => {
              const available = sub(remaining, parseRational(note.onset));
              if (cmp(parseRational(note.duration), available) > 0 && available.n > 0) {
                clippedTails++;
                return { ...note, duration: rationalString(available) };
              }
              return note;
            }),
          };
        }),
      };
      const plan = planComposeImport(base, bounded, {
        ids: state.ids,
        runId: request.requestId,
        targets: request.targets,
        quantize: 'exact',
        importChords: request.generate.chordMode !== 'given',
        ...(spec.difficulty
          ? {
              performance: {
                difficulty: spec.difficulty,
                maxHandSpan: spec.maxHandSpan,
                pianoTexture: spec.pianoTexture ?? 'model',
                task: spec.task,
                seed: spec.seed + i,
                useScoreChords: request.generate.chordMode === 'given',
              },
            }
          : {}),
      });
      const generatedMeasures = new Set(
        base.measures
          .slice(
            request.generate.bars.from,
            request.generate.bars.from + request.generate.bars.count,
          )
          .map((m) => m.id),
      );
      const replacedChords =
        request.generate.chordMode === 'given'
          ? []
          : base.harmony.filter((h) => generatedMeasures.has(h.measureId)).map((h) => h.id);
      const previewCommands: Command[] = replacedChords.length
        ? [{ type: 'harmony.delete', ids: replacedChords }, ...plan.commands]
        : [...plan.commands];
      const preview = applyCommand(base, { type: 'batch', commands: previewCommands }).doc;
      if (validateScore(preview).length) fail('candidate.invalid');
      const candidate: ComposeCandidate = {
        id: request.requestId,
        request,
        result,
        base,
        fingerprint,
        preview,
        commands: plan.commands,
        seconds: (performance.now() - started) / 1000,
        notes: plan.stats.notes,
        warnings: plan.warnings,
        clippedTails,
        ...(plan.performance ? { performance: plan.performance } : {}),
      };
      useComposeCandidates.setState((s) => ({
        candidates: [...s.candidates, candidate],
        completed: i + 1,
      }));
    }
  } catch (e) {
    if (token === operation) throw e;
  } finally {
    if (token === operation) {
      controller = null;
      useComposeCandidates.setState({ busy: false });
    }
  }
}

export interface AcceptScope {
  /** Inclusive measure indices. */
  readonly from: number;
  readonly to: number;
  readonly parts: readonly string[];
  readonly chords: boolean;
}
export function fullCandidateScope(c: ComposeCandidate): AcceptScope {
  return {
    from: c.result.startBar,
    to: c.result.startBar + c.result.bars.length - 1,
    parts: [...new Set(c.request.targets.flatMap((t) => t.parts))],
    chords: c.request.generate.chordMode !== 'given',
  };
}
/** Select commands after the full preview was laid out, retaining its fixed group/voice mapping. */
export function candidateCommands(c: ComposeCandidate, scope: AcceptScope): Command[] {
  const full = fullCandidateScope(c),
    infos = measureInfos(c.preview);
  if (
    !Number.isInteger(scope.from) ||
    !Number.isInteger(scope.to) ||
    scope.from < full.from ||
    scope.to > full.to ||
    scope.from > scope.to ||
    !scope.parts.length ||
    scope.parts.some((id) => !full.parts.includes(id)) ||
    (scope.chords && !full.chords)
  )
    fail('candidate.invalidScope');
  const selected = new Set(infos.slice(scope.from, scope.to + 1).map((x) => x.measure.id));
  const staves = new Set(
    c.base.parts
      .filter((p) => scope.parts.includes(p.id))
      .flatMap((p) => p.staves.map((s) => s.id)),
  );
  const start = infos[scope.from]!.start,
    end = add(infos[scope.to]!.start, infos[scope.to]!.length);
  const indexes = new Map(infos.map((x) => [x.measure.id, x]));
  const crosses = (a: Rational, b: Rational) =>
    cmp(a, end) < 0 && cmp(b, start) > 0 && (cmp(a, start) < 0 || cmp(b, end) > 0);
  // Do not sever notes or spans at a partial acceptance boundary, including existing target music.
  for (const doc of [c.base, c.preview]) {
    for (const staff of staves)
      for (const [measureId, sm] of Object.entries(doc.content[staff] ?? {})) {
        const info = indexes.get(measureId);
        if (!info) continue;
        for (const voice of sm.voices)
          for (const event of voice) {
            const a = add(info.start, event.offset);
            if (crosses(a, add(a, event.duration))) fail('candidate.crossing');
          }
      }
    for (const span of doc.spanners) {
      if (span.kind === 'slur' || !staves.has(span.staffId)) continue;
      const a = indexes.get(span.start.measureId),
        b = indexes.get(span.end.measureId);
      if (a && b && crosses(add(a.start, span.start.offset), add(b.start, span.end.offset)))
        fail('candidate.crossing');
    }
  }
  const commands: Command[] = [];
  for (const command of c.commands) {
    switch (command.type) {
      case 'measures.insert': {
        const needed = Math.max(0, scope.to + 1 - c.base.measures.length);
        if (needed) commands.push({ ...command, ids: command.ids.slice(0, needed) });
        break;
      }
      case 'range.clear':
        commands.push({
          ...command,
          staffIds: [...staves],
          from: { measureId: infos[scope.from]!.measure.id, offset: rat(0) },
          to: { measureId: infos[scope.to]!.measure.id, offset: infos[scope.to]!.length },
        });
        break;
      case 'events.insert':
      case 'dynamic.set':
        if (staves.has(command.staffId) && selected.has(command.measureId)) commands.push(command);
        break;
      case 'tuplet.create':
        if (staves.has(command.at.staffId) && selected.has(command.at.measureId))
          commands.push(command);
        break;
      case 'spanner.add':
        if (
          command.spanner.kind !== 'slur' &&
          staves.has(command.spanner.staffId) &&
          selected.has(command.spanner.start.measureId) &&
          selected.has(command.spanner.end.measureId)
        )
          commands.push(command);
        break;
      case 'harmony.set':
        if (scope.chords && selected.has(command.chord.measureId)) commands.push(command);
        break;
      default:
        fail('candidate.invalid');
    }
  }
  if (scope.chords) {
    const ids = c.base.harmony.filter((h) => selected.has(h.measureId)).map((h) => h.id);
    if (ids.length) commands.unshift({ type: 'harmony.delete', ids });
  }
  commands.push({ type: 'provenance.accept', runId: c.id });
  return commands;
}

export function acceptCandidate(c: ComposeCandidate, scope = fullCandidateScope(c)): boolean {
  const s = getStore().getState();
  if (documentFingerprint(s.doc) !== c.fingerprint) fail('candidate.stale');
  const commands = candidateCommands(c, scope);
  const checked = applyCommand(s.doc, { type: 'batch', commands }).doc;
  if (validateScore(checked).length) fail('candidate.invalid');
  if (!s.apply(commands, 'Cantelvio', { selection: { kind: 'none' } })) return false;
  clearCandidates();
  getStore().getState().notify(translate(s.view.lang, 'candidate.accepted'));
  return true;
}
