/**
 * The AIlegro Score document model (format "ailegro-score", version 1).
 *
 * Design rules (see docs/score-model.md and docs/adr/0002-score-model.md):
 *
 * 1. SEMANTIC, NOT GRAPHICAL. The document stores music (pitches, durations, structure).
 *    Layout is derived by @ailegro-score/engraving; layout hints are explicit, optional fields.
 * 2. STABLE IDS. Every addressable element has a string id that never changes. Selections, AI
 *    patches, version diffs and (future) real-time collaboration all refer to ids.
 * 3. EXACT TIME. Offsets and durations are rationals in whole notes (quarter = 1/4).
 * 4. ONE SOUNDING NOTE = ONE EVENT. An event's duration may extend past barlines; ties at
 *    barlines are derived for display. Explicit ties (`Note.tieForward`) exist for cases the
 *    user writes deliberately (e.g. partial chord ties).
 * 5. CONCERT PITCH. Notes store sounding pitch with spelling; written pitch for transposing
 *    instruments is derived. AIlegro consumes sounding MIDI pitch directly.
 * 6. IMPLICIT RESTS. Gaps in a voice are rests; the engraver fills them according to the meter.
 * 7. PLAIN JSON. No classes, no Maps, no undefined-vs-missing ambiguity in persisted data, so
 *    documents serialize deterministically and diff cleanly in git.
 */
import type { Interval, KeySignature, Pitch } from '../pitch/pitch';
import type { TimeSignature } from '../time/meter';
import type { Rational } from '../time/rational';
import type { ClefType } from './clef';

export type ID = string;

export const SCORE_FORMAT = 'ailegro-score' as const;
export const SCORE_FORMAT_VERSION = 1 as const;

export interface ScoreDoc {
  readonly format: typeof SCORE_FORMAT;
  readonly version: typeof SCORE_FORMAT_VERSION;
  readonly id: ID;
  readonly meta: ScoreMeta;
  readonly settings: ScoreSettings;
  /** Parts (instruments) in score order, top to bottom. */
  readonly parts: readonly Part[];
  /** Brackets and braces joining staves. */
  readonly groups: readonly StaffGroup[];
  /** The global bar list shared by all staves. */
  readonly measures: readonly Measure[];
  /** Musical content: staffId -> measureId -> content. Missing entries are empty bars. */
  readonly content: Readonly<Record<ID, Readonly<Record<ID, StaffMeasure>>>>;
  /** Chord symbols (harmony track), also the harmony condition for AIlegro. */
  readonly harmony: readonly ChordSymbol[];
}

export interface ScoreMeta {
  readonly title: string;
  readonly subtitle?: string;
  readonly composer?: string;
  readonly arranger?: string;
  readonly lyricist?: string;
  readonly copyright?: string;
  /** ISO timestamps. */
  readonly createdAt?: string;
  readonly modifiedAt?: string;
}

export interface ScoreSettings {
  /** Staff space in millimetres (rastral size). 1.75 is a typical piano size. */
  readonly staffSpaceMm: number;
  readonly pageSize: { readonly widthMm: number; readonly heightMm: number };
  readonly pageMarginsMm: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
  /** Default display: false = transposed score (written pitch), true = concert pitch. */
  readonly concertPitch: boolean;
  /** Tempo (quarter notes per minute) used when no tempo mark is present. */
  readonly defaultTempo: number;
}

// ------------------------------------------------------------------------------- instruments

export interface Part {
  readonly id: ID;
  /** Key in the instrument catalog, e.g. "violin", "clarinet-bb". */
  readonly instrument: string;
  readonly name: string;
  readonly abbreviation: string;
  readonly staves: readonly Staff[];
  /**
   * Written -> sounding interval. Absent = taken from the instrument catalog.
   * Bb clarinet: { diatonic: -1, chromatic: -2 } (sounds a major second lower).
   */
  readonly transposition?: Interval;
  /** General MIDI program 0..127 for playback; absent = catalog default. */
  readonly midiProgram?: number;
}

export interface Staff {
  readonly id: ID;
  /** Clef at the start of the score; changes live in StaffMeasure.clefChanges. */
  readonly clef: ClefType;
  /** Number of staff lines (5 standard; 1 for some percussion). */
  readonly lines: number;
}

export interface StaffGroup {
  readonly id: ID;
  readonly kind: 'bracket' | 'brace' | 'square';
  /** Inclusive range of staves, by id, in score order. */
  readonly firstStaff: ID;
  readonly lastStaff: ID;
  /** Draw barlines through the gaps between the grouped staves. */
  readonly barlineThrough: boolean;
  readonly name?: string;
}

// ------------------------------------------------------------------------------- measures

export type BarlineStyle = 'single' | 'double' | 'final' | 'dashed' | 'none';

export interface Measure {
  readonly id: ID;
  /** Present where the time signature changes (always on the first measure). */
  readonly timeSig?: TimeSignature;
  /** Concert key signature, present where it changes (always on the first measure). */
  readonly keySig?: KeySignature;
  /** Actual length if it differs from the time signature (pickup bars, cadenzas). */
  readonly actualLength?: Rational;
  /** Barline at the END of this measure. Default 'single'. */
  readonly barline?: BarlineStyle;
  readonly repeatStart?: boolean;
  readonly repeatEnd?: boolean;
  readonly rehearsalMark?: string;
  readonly tempo?: readonly TempoMark[];
  /** Layout hint: force a system or page break after this measure. */
  readonly breakAfter?: 'system' | 'page';
}

export interface TempoMark {
  readonly id: ID;
  readonly offset: Rational;
  /** Beats per minute of `beatUnit` (default quarter = 1/4). */
  readonly bpm: number;
  readonly beatUnit?: Rational;
  readonly text?: string;
}

// ------------------------------------------------------------------------------- content

/** Number of voices per staff (MuseScore/Sibelius convention: 1 and 3 stems up, 2 and 4 down). */
export const VOICES_PER_STAFF = 4;

export interface StaffMeasure {
  /** voices[v] is sorted by offset; events in one voice never overlap. */
  readonly voices: readonly (readonly VoiceEvent[])[];
  readonly tuplets?: readonly TupletSpan[];
  readonly clefChanges?: readonly ClefChange[];
  readonly dynamics?: readonly DynamicMark[];
}

export type VoiceEvent = NoteEvent;

export interface NoteEvent {
  readonly id: ID;
  readonly kind: 'note';
  /** Start within the measure, in whole notes. */
  readonly offset: Rational;
  /** Sounding length in whole notes. May extend past the barline. */
  readonly duration: Rational;
  /** One or more notes sharing a stem, ascending by pitch. */
  readonly notes: readonly Note[];
  readonly articulations?: readonly Articulation[];
  readonly stem?: 'up' | 'down';
  /** Where this event came from. Absent = entered by the user. */
  readonly source?: Provenance;
}

export interface Note {
  readonly id: ID;
  /** Concert (sounding) pitch with spelling. */
  readonly pitch: Pitch;
  /** Tie to the note of the same pitch in the next event of this voice. */
  readonly tieForward?: boolean;
  /** Display override for the accidental. Default 'auto'. */
  readonly accidental?: 'auto' | 'show' | 'cautionary' | 'hide';
  /** MIDI velocity override 1..127. */
  readonly velocity?: number;
}

export type Articulation =
  'staccato' | 'staccatissimo' | 'accent' | 'tenuto' | 'marcato' | 'fermata';

export interface TupletSpan {
  readonly id: ID;
  readonly voice: number;
  readonly offset: Rational;
  /** Actual (sounding) length of the whole tuplet. */
  readonly length: Rational;
  /** `actual` notes in the time of `normal`: a triplet is 3:2. */
  readonly actual: number;
  readonly normal: number;
}

export interface ClefChange {
  readonly id: ID;
  readonly offset: Rational;
  readonly clef: ClefType;
}

// prettier-ignore
export type DynamicValue =
  | 'pppp' | 'ppp' | 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff' | 'fff' | 'ffff'
  | 'sf' | 'sfz' | 'sffz' | 'fz' | 'fp' | 'sfp' | 'rf' | 'rfz';

export interface DynamicMark {
  readonly id: ID;
  readonly offset: Rational;
  readonly value: DynamicValue;
}

// ------------------------------------------------------------------------------- harmony

/** A chord symbol. `quality` uses AIlegro's chord-quality ids ("maj", "min", "dom7", ...). */
export interface ChordSymbol {
  readonly id: ID;
  readonly measureId: ID;
  readonly offset: Rational;
  readonly root: { readonly step: Pitch['step']; readonly alter: number };
  readonly quality: string;
  readonly bass?: { readonly step: Pitch['step']; readonly alter: number };
  readonly source?: Provenance;
}

// ------------------------------------------------------------------------------- provenance

/**
 * Who produced an element. Kept so that AI suggestions can be reviewed, so version diffs can
 * attribute changes, and so material exported to AIlegro can be filtered by origin
 * (e.g. never train on unreviewed model output).
 */
export type Provenance =
  | { readonly kind: 'user' }
  | { readonly kind: 'import'; readonly format: string; readonly file?: string }
  | {
      readonly kind: 'ai';
      readonly model: string;
      readonly runId: string;
      readonly accepted?: boolean;
    };

// ------------------------------------------------------------------------------- addressing

/** A position in the score where input happens. */
export interface ScorePosition {
  readonly staffId: ID;
  readonly voice: number;
  readonly measureId: ID;
  readonly offset: Rational;
}
