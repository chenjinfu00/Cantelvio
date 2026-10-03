/**
 * Interchange schemas between AIlegro Score and AIlegro (see docs/ailegro-integration.md).
 *
 * Conventions shared with AIlegro's training code (training/scripts/score_events_v2.py,
 * four_pillar_codec.py, four_pillar_v31_sample.py):
 * - musical time in QUARTER notes as exact fraction strings ("3/2"), never floats;
 * - sounding MIDI pitch (60 = C4); unpitched percussion has pitch null plus a GM drum key;
 * - six native instrument groups; voices/parts keep stable identities;
 * - one sounding note per event (ties merged); missing labels stay null, never guessed.
 *
 * All three documents are versioned. Changing a field = new schema version + migration + tests.
 */
import { AILEGRO_GROUPS, type AilegroGroup } from '@ailegro-score/core';

export { AILEGRO_GROUPS, type AilegroGroup };

/** Fraction string in quarter notes, e.g. "0", "3/2", "1/3". */
export type QuarterTime = string;

export const RECORD_SCHEMA = 'ailegro.score-record/1' as const;
export const REQUEST_SCHEMA = 'ailegro.compose-request/1' as const;
export const RESULT_SCHEMA = 'ailegro.compose-result/1' as const;
export const ANALYSIS_REQUEST_SCHEMA = 'ailegro.analysis-request/1' as const;
export const ANALYSIS_RESULT_SCHEMA = 'ailegro.analysis-result/1' as const;

/** AIlegro's score-dynamic vocabulary (four_pillar_codec.DYNAMICS). */
export const AILEGRO_DYNAMICS = [
  'p',
  'f',
  'pp',
  'ff',
  'sf',
  'mf',
  'other-dynamics',
  'fz',
  'fff',
  'fp',
  'ppp',
  'mp',
  'sfp',
  'sfz',
  'rf',
  'rfz',
  'ffff',
  'sffz',
  'pppp',
  'sfpp',
  'ppppp',
  'pppppp',
] as const;
export const AILEGRO_WEDGES = ['crescendo', 'diminuendo'] as const;

// ------------------------------------------------------------------------------- score record

export interface RecordPart {
  readonly id: string;
  readonly name: string;
  /** MusicXML instrument-sound id, e.g. "strings.violin". */
  readonly sound: string;
  readonly group: AilegroGroup | null;
  /** General MIDI program, 1-based as in MusicXML <midi-program>. */
  readonly program: number | null;
  /** How the group was decided: "catalog" (instrument definition) or "vocal". */
  readonly mapping: string | null;
  /** AIlegro Score instrument id (extension). */
  readonly instrument?: string;
  readonly staves?: number;
}

export interface RecordMeasure {
  readonly number: number;
  readonly on: QuarterTime;
  readonly dur: QuarterTime;
  readonly meter: readonly [number, number];
  /** Concert key signature. */
  readonly key: { readonly fifths: number; readonly mode: 'major' | 'minor' | null } | null;
  readonly irregular: boolean;
}

export interface RecordNote {
  readonly part: string;
  readonly staff: string;
  readonly voice: string;
  /** Index of the measure the note starts in (0-based). */
  readonly bar: number;
  readonly on: QuarterTime;
  readonly dur: QuarterTime;
  /** Sounding MIDI pitch, null for unpitched percussion. */
  readonly pitch: number | null;
  readonly writtenPitch: number | null;
  readonly group: AilegroGroup | null;
  readonly role: string | null;
  /** Notated tuplet ratio "actual:normal" or null. */
  readonly tuplet: string | null;
  readonly dynamic: string | null;
  readonly wedge: string | null;
  /** 0 none, 1 accent, 2 strong accent (marcato). */
  readonly accent: number;
  readonly grace: boolean;
  readonly unpitched: boolean;
  /** Extensions (ignored by AIlegro's reader): */
  readonly drum?: number | null;
  readonly velocity?: number | null;
  /** AIlegro Score note id, so results and diffs can refer back. */
  readonly id?: string;
  readonly source?: string;
}

export interface RecordChord {
  readonly bar: number;
  readonly on: QuarterTime;
  /** Root pitch class 0..11 and spelling. */
  readonly root: number;
  readonly rootName: string;
  /** AIlegro chord-quality id ("maj", "min7", ...). */
  readonly quality: string;
  readonly bass: number | null;
  readonly id?: string;
}

export interface RecordTempo {
  readonly on: QuarterTime;
  /** Quarter notes per minute. */
  readonly qpm: number;
  readonly text: string | null;
}

/** A score in AIlegro's exact-notation record format (compatible with classical-score-v1). */
export interface ScoreRecord {
  readonly schema: typeof RECORD_SCHEMA;
  readonly scoreId: string;
  readonly source: string;
  readonly composer: string | null;
  readonly work: string | null;
  readonly movement: string | null;
  readonly compositionKey: string | null;
  readonly scoreSha256: string | null;
  readonly parts: readonly RecordPart[];
  readonly measures: readonly RecordMeasure[];
  readonly notes: readonly RecordNote[];
  /** Extensions used by compose requests. */
  readonly harmony: readonly RecordChord[];
  readonly tempo: readonly RecordTempo[];
  readonly provenance: {
    readonly app: string;
    readonly exportedAt: string | null;
    readonly license: string | null;
  };
}

// ------------------------------------------------------------------------------- compose request

export type ComposeTask =
  /** Free continuation after the given context. */
  | 'continue'
  /** Melody is given (hard-locked); write the other voices. */
  | 'accompany-melody'
  /** Chords are given; write melody and accompaniment. */
  | 'melody-from-chords'
  /** A short motif is given; develop it. */
  | 'develop-motif'
  /** Existing music is given; re-orchestrate it for the requested groups. */
  | 'orchestrate';

export interface TimeSpan {
  /** Inclusive start / exclusive end, quarter notes from the start of the score. */
  readonly from: QuarterTime;
  readonly to: QuarterTime;
}

/** Common fields of every condition, following AIlegro's unified request contract. */
export interface ConditionBase {
  readonly id: string;
  readonly timeSpan: TimeSpan;
  /** The value is known (given by the user). Unknown labels are omitted, not defaulted. */
  readonly known: boolean;
  /** true: must be kept exactly; false: soft hint. */
  readonly hardLock: boolean;
  readonly source: 'user' | 'score' | 'ai' | 'import';
}

export interface MaterialCondition extends ConditionBase {
  readonly kind: 'notes' | 'chords' | 'motif';
  /** Parts whose notes in the span are the material (notes/motif). */
  readonly parts?: readonly string[];
  readonly role?: 'melody' | 'bass' | 'harmony' | 'counterpoint' | 'rhythm';
}

export type ConstraintCondition = ConditionBase &
  (
    | {
        readonly kind: 'key';
        readonly value: { readonly tonic: number; readonly mode: 0 | 1; readonly fifths: number };
      }
    | { readonly kind: 'meter'; readonly value: readonly [number, number] }
    | { readonly kind: 'tempo'; readonly value: { readonly qpm: number } }
    | {
        readonly kind: 'groups';
        readonly value: { readonly allowed: readonly AilegroGroup[]; readonly request: boolean };
      }
    | { readonly kind: 'density'; readonly value: number }
    | { readonly kind: 'reference'; readonly value: { readonly bar: number } }
    | { readonly kind: 'style'; readonly value: string }
  );

export interface GenerateSpec {
  /** Bars to write: measure indices [from, from + count). */
  readonly bars: { readonly from: number; readonly count: number };
  readonly chordMode: 'free' | 'hold' | 'bar' | 'given';
  readonly sampling: { readonly seed: number; readonly temperature: number; readonly topP: number };
  readonly referencePolicy: 'auto' | 'none';
  readonly maxNotesPerBar: number;
  /** Let the model change key at bar boundaries. */
  readonly modelKeys: boolean;
  /** Bars of context before `bars.from` to feed (default: everything available, max 511). */
  readonly contextBars: number;
}

export interface TargetMapping {
  readonly group: AilegroGroup;
  /** Parts that receive notes the model writes for this group, in score order. */
  readonly parts: readonly string[];
}

export interface ComposeRequest {
  readonly schema: typeof REQUEST_SCHEMA;
  readonly requestId: string;
  readonly createdAt: string | null;
  readonly client: { readonly app: 'AIlegro Score'; readonly version: string };
  readonly task: ComposeTask;
  readonly intent: { readonly text: string; readonly tags: readonly string[] } | null;
  /** Context and given material, as a score record (notes before/inside the target span). */
  readonly score: ScoreRecord;
  readonly material: readonly MaterialCondition[];
  readonly constraints: readonly ConstraintCondition[];
  readonly generate: GenerateSpec;
  readonly targets: readonly TargetMapping[];
}

// ------------------------------------------------------------------------------- compose result

/** One generated bar exactly as AIlegro's v3.1 Composer.next_bar() returns it. */
export interface ResultBar {
  readonly bar: number;
  readonly length: QuarterTime;
  readonly meter: readonly [number, number];
  readonly key: { readonly tonic: number; readonly mode: number; readonly name?: string };
  readonly chords: readonly {
    readonly onset: QuarterTime;
    readonly root: number;
    readonly quality: number | string;
    readonly name?: string;
  }[];
  readonly notes: readonly ResultNote[];
  readonly reference?: number | null;
  readonly resourceClosure?: boolean;
}

export interface ResultNote {
  readonly onset: QuarterTime;
  readonly duration: QuarterTime;
  readonly group: AilegroGroup | null;
  /** Voice slot; stable across bars within one result. */
  readonly voice: number;
  readonly pitch: number | null;
  readonly drum: number | null;
  readonly velocity: number;
  readonly dynamic: string | null;
  readonly accent: number;
  readonly wedge: string | null;
}

export interface ComposeResult {
  readonly schema: typeof RESULT_SCHEMA;
  readonly requestId: string;
  readonly model: {
    readonly name: string;
    readonly checkpoint?: string;
    readonly sha256?: string;
    readonly step?: number;
  };
  readonly seed?: number;
  /** Measure index in the score where `bars[0]` goes. */
  readonly startBar: number;
  readonly bars: readonly ResultBar[];
  readonly warnings?: readonly string[];
}

// ------------------------------------------------------------------------------- harmonic analysis

/** Ask AIlegro to label the chords (and local keys) of existing music. */
export interface AnalysisRequest {
  readonly schema: typeof ANALYSIS_REQUEST_SCHEMA;
  readonly requestId: string;
  readonly createdAt: string | null;
  readonly client: { readonly app: 'AIlegro Score'; readonly version: string };
  /** The music to analyse (all parts of the analysed bars). */
  readonly score: ScoreRecord;
  readonly analyze: {
    /** Measure indices [from, from + count) to label. */
    readonly bars: { readonly from: number; readonly count: number };
    /** Part whose top line is read as the melody; null = the first part with notes. */
    readonly melodyPart: string | null;
    /** `auto` = AIlegro's best available engine; `model` = its trained analysis model; `rules` = its chord tracker. */
    readonly engine: 'auto' | 'model' | 'rules';
    /** How often chords may change: `auto` (as learned), `beat`, `half-bar`, `bar`, `two-bars`. */
    readonly harmonicRhythm: 'auto' | 'beat' | 'half-bar' | 'bar' | 'two-bars';
  };
}

export interface AnalysisBar {
  readonly bar: number;
  /** Local key AIlegro reads in the bar. */
  readonly key: { readonly tonic: number; readonly mode: number; readonly name?: string };
  /** Chord changes in the bar; the first analysed bar starts with the chord in effect at onset 0. */
  readonly chords: readonly {
    readonly onset: QuarterTime;
    readonly root: number;
    readonly quality: number | string;
    readonly name?: string;
  }[];
}

export interface AnalysisResult {
  readonly schema: typeof ANALYSIS_RESULT_SCHEMA;
  readonly requestId: string;
  readonly model: {
    readonly name: string;
    readonly checkpoint?: string;
    readonly sha256?: string;
    readonly step?: number;
  };
  /** Measure index in the score where `bars[0]` goes. */
  readonly startBar: number;
  readonly bars: readonly AnalysisBar[];
  readonly warnings?: readonly string[];
}
