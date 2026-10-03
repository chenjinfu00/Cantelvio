/** Build an ailegro.compose-request/1 from a score and what the user asked for. */
import {
  type ScoreDoc,
  add,
  getInstrument,
  keyTonicPitchClass,
  measureInfos,
  mulInt,
  tempoMap,
  toString as ratString,
} from '@ailegro-score/core';
import type { HarmonicRhythm } from './analysis';
import { buildScoreRecord } from './record';
import {
  AILEGRO_GROUPS,
  type AilegroGroup,
  type ComposeRequest,
  type ComposeTask,
  type ConstraintCondition,
  type MaterialCondition,
  REQUEST_SCHEMA,
  type TargetMapping,
} from './schemas';

export interface ComposeSpec {
  readonly task: ComposeTask;
  /** First measure index to write and number of measures. */
  readonly from: number;
  readonly count: number;
  /** Parts holding given material (accompany-melody, develop-motif, orchestrate). */
  readonly materialParts?: readonly string[];
  /** Keep the material exactly (default true). */
  readonly lockMaterial?: boolean;
  /** Allowed groups; default: the groups of the target parts. */
  readonly groups?: readonly AilegroGroup[];
  /** Also tell the model which groups should play (learned condition). */
  readonly requestGroups?: boolean;
  /** Parts that receive generated music; default: every part not holding material. */
  readonly targetParts?: readonly string[];
  readonly chordMode?: 'free' | 'hold' | 'bar' | 'given';
  readonly density?: number;
  readonly style?: string;
  readonly referenceBar?: number;
  readonly referencePolicy?: 'auto' | 'none';
  readonly seed?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly modelKeys?: boolean;
  readonly contextBars?: number;
  readonly intent?: { readonly text: string; readonly tags?: readonly string[] };
  /** How often chords may change where AIlegro chooses them (accompany-melody); sent as the intent tag
   * `harmonic-rhythm:<value>` so the compose contract stays unchanged. */
  readonly harmonicRhythm?: HarmonicRhythm;
}

export interface RequestMeta {
  readonly requestId: string;
  readonly createdAt?: string;
  readonly appVersion?: string;
}

const q = (r: { n: number; d: number }) => ratString(mulInt(r, 4));

/** The intent tag that carries a harmonic rhythm (`auto` sends none). */
export function harmonicRhythmTag(rhythm: HarmonicRhythm): string | null {
  return rhythm === 'auto' ? null : `harmonic-rhythm:${rhythm}`;
}

function intentOf(spec: ComposeSpec): ComposeRequest['intent'] {
  const tag = spec.harmonicRhythm ? harmonicRhythmTag(spec.harmonicRhythm) : null;
  const tags = [
    ...(spec.intent?.tags ?? []).filter((t) => !t.startsWith('harmonic-rhythm:')),
    ...(tag ? [tag] : []),
  ];
  if (!spec.intent && !tags.length) return null;
  return { text: spec.intent?.text ?? '', tags };
}

export function buildComposeRequest(
  doc: ScoreDoc,
  spec: ComposeSpec,
  meta: RequestMeta,
): ComposeRequest {
  const infos = measureInfos(doc);
  if (spec.from < 0 || spec.count < 1) throw new Error('invalid bar range');
  const contextBars = Math.min(spec.contextBars ?? 511, spec.from);
  const ctxFrom = spec.from - contextBars;
  const genTo = Math.min(spec.from + spec.count, infos.length);
  const spanStart =
    infos[spec.from]?.start ?? add(infos[infos.length - 1]!.start, infos[infos.length - 1]!.length);
  const spanEnd =
    genTo < infos.length
      ? infos[genTo]!.start
      : add(infos[infos.length - 1]!.start, infos[infos.length - 1]!.length);
  const ctxStart = infos[ctxFrom]?.start ?? { n: 0, d: 1 };

  const materialParts = spec.materialParts ?? [];
  // develop-motif writes on from the motif (it lies in the context), so its own parts receive new bars
  // too; the other tasks keep their given notes and write into the remaining parts.
  const targetParts =
    spec.targetParts ??
    doc.parts
      .map((p) => p.id)
      .filter((id) => spec.task === 'develop-motif' || !materialParts.includes(id));
  // Score record: context bars, plus the material parts inside the generated span.
  const record = buildScoreRecord(doc, { bars: { from: ctxFrom, to: genTo } });
  const inSpan = (on: string) => {
    const [n, d] = on.split('/');
    const t = Number(n) / Number(d ?? 1) / 4;
    return t >= spanStart.n / spanStart.d;
  };
  const filtered = {
    ...record,
    notes: record.notes.filter((n) => !inSpan(n.on) || materialParts.includes(n.part)),
  };

  const groupOf = (partId: string): AilegroGroup | null => {
    const part = doc.parts.find((p) => p.id === partId);
    return part ? getInstrument(part.instrument).ailegroGroup : null;
  };
  const allowed: AilegroGroup[] = spec.groups
    ? [...spec.groups]
    : AILEGRO_GROUPS.filter((g) => targetParts.some((id) => groupOf(id) === g));
  const targets: TargetMapping[] = AILEGRO_GROUPS.filter((g) => allowed.includes(g)).map((g) => ({
    group: g,
    parts: targetParts.filter((id) => groupOf(id) === g),
  }));

  const genSpan = { from: q(spanStart), to: q(spanEnd) };
  const ctxSpan = { from: q(ctxStart), to: q(spanStart) };
  const material: MaterialCondition[] = [];
  if (contextBars > 0) {
    material.push({
      id: 'context',
      kind: 'notes',
      timeSpan: ctxSpan,
      known: true,
      hardLock: true,
      source: 'score',
    });
  }
  const lock = spec.lockMaterial ?? true;
  if (spec.task === 'accompany-melody' || spec.task === 'orchestrate') {
    material.push({
      id: 'given-notes',
      kind: 'notes',
      timeSpan: genSpan,
      parts: materialParts,
      ...(spec.task === 'accompany-melody' ? { role: 'melody' as const } : {}),
      known: true,
      hardLock: lock,
      source: 'user',
    });
  }
  if (spec.task === 'develop-motif') {
    material.push({
      id: 'motif',
      kind: 'motif',
      timeSpan: ctxSpan,
      parts: materialParts,
      known: true,
      hardLock: lock,
      source: 'user',
    });
  }
  if (spec.task === 'melody-from-chords' || spec.chordMode === 'given') {
    material.push({
      id: 'given-chords',
      kind: 'chords',
      timeSpan: genSpan,
      known: true,
      hardLock: lock,
      source: 'user',
    });
  }

  const constraints: ConstraintCondition[] = [];
  for (let i = spec.from; i < genTo; i++) {
    const m = infos[i]!;
    const span = { from: q(m.start), to: q(add(m.start, m.length)) };
    const tonic = keyTonicPitchClass(m.keySig);
    constraints.push({
      id: `key-${i}`,
      kind: 'key',
      timeSpan: span,
      value: { tonic, mode: m.keySig.mode === 'minor' ? 1 : 0, fifths: m.keySig.fifths },
      known: true,
      hardLock: !spec.modelKeys,
      source: 'score',
    });
    constraints.push({
      id: `meter-${i}`,
      kind: 'meter',
      timeSpan: span,
      value: [m.timeSig.beats, m.timeSig.beatType],
      known: true,
      hardLock: true,
      source: 'score',
    });
  }
  // Bars appended after the end of the score continue its last meter and key.
  const lastInfo = infos[infos.length - 1]!;
  let appendStart = add(lastInfo.start, lastInfo.length);
  for (let i = Math.max(genTo, spec.from); i < spec.from + spec.count; i++) {
    const end = add(appendStart, lastInfo.length);
    const span = { from: q(appendStart), to: q(end) };
    constraints.push({
      id: `meter-${i}`,
      kind: 'meter',
      timeSpan: span,
      value: [lastInfo.timeSig.beats, lastInfo.timeSig.beatType],
      known: true,
      hardLock: true,
      source: 'score',
    });
    constraints.push({
      id: `key-${i}`,
      kind: 'key',
      timeSpan: span,
      value: {
        tonic: keyTonicPitchClass(lastInfo.keySig),
        mode: lastInfo.keySig.mode === 'minor' ? 1 : 0,
        fifths: lastInfo.keySig.fifths,
      },
      known: true,
      hardLock: false,
      source: 'score',
    });
    appendStart = end;
  }
  const tempo = tempoMap(doc);
  const qpm =
    [...tempo].reverse().find((t) => t.at.n / t.at.d <= spanStart.n / spanStart.d)?.qpm ??
    doc.settings.defaultTempo;
  constraints.push({
    id: 'tempo',
    kind: 'tempo',
    timeSpan: genSpan,
    value: { qpm },
    known: true,
    hardLock: true,
    source: 'score',
  });
  constraints.push({
    id: 'groups',
    kind: 'groups',
    timeSpan: genSpan,
    value: { allowed, request: !!spec.requestGroups },
    known: true,
    hardLock: true,
    source: 'user',
  });
  if (spec.density !== undefined)
    constraints.push({
      id: 'density',
      kind: 'density',
      timeSpan: genSpan,
      value: spec.density,
      known: true,
      hardLock: false,
      source: 'user',
    });
  if (spec.style)
    constraints.push({
      id: 'style',
      kind: 'style',
      timeSpan: genSpan,
      value: spec.style,
      known: true,
      hardLock: false,
      source: 'user',
    });
  if (spec.referenceBar !== undefined)
    constraints.push({
      id: 'reference',
      kind: 'reference',
      timeSpan: genSpan,
      value: { bar: spec.referenceBar },
      known: true,
      hardLock: false,
      source: 'user',
    });

  return {
    schema: REQUEST_SCHEMA,
    requestId: meta.requestId,
    createdAt: meta.createdAt ?? null,
    client: { app: 'AIlegro Score', version: meta.appVersion ?? '0.1.0' },
    task: spec.task,
    intent: intentOf(spec),
    score: filtered,
    material,
    constraints,
    generate: {
      bars: { from: spec.from, count: spec.count },
      chordMode: spec.chordMode ?? 'free',
      sampling: { seed: spec.seed ?? 1, temperature: spec.temperature ?? 1, topP: spec.topP ?? 1 },
      referencePolicy: spec.referencePolicy ?? 'auto',
      maxNotesPerBar: 128,
      modelKeys: !!spec.modelKeys,
      contextBars,
    },
    targets,
  };
}
