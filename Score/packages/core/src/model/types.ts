/**
 * The AIlegro Score document model (format "ailegro-score", version 2).
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
import type { NoteValue } from '../time/duration';
import type { TimeSignature } from '../time/meter';
import type { Rational } from '../time/rational';
import type { ClefType } from './clef';

export type ID = string;

export const SCORE_FORMAT = 'ailegro-score' as const;
/** v2 (2026-10): event marks (ornaments, tremolo, arpeggio, cue size, graces, breath) and spanners. */
export const SCORE_FORMAT_VERSION = 2 as const;

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
  /** Slurs, hairpins, octave lines, pedal marks and trill lines, by staff then start time. */
  readonly spanners: readonly Spanner[];
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
  /** Sorted, no duplicates. */
  readonly articulations?: readonly Articulation[];
  /** Ornament sign (trill, mordents, turns). */
  readonly ornament?: Ornament;
  /** Single-note tremolo: strokes through the stem, 1–4 (eighths … 64ths). */
  readonly tremolo?: number;
  /** Rolled chord. */
  readonly arpeggio?: Arpeggio;
  /** Cue-size (small) notes. Only the size changes; they sound normally. */
  readonly cue?: boolean;
  /** Grace notes before this event, in playing order. They take no metric time. */
  readonly graces?: readonly GraceNote[];
  /** Breath mark or caesura after this event. */
  readonly breath?: Breath;
  readonly stem?: 'up' | 'down';
  /** Where this event came from. Absent = entered by the user. */
  readonly source?: Provenance;
}

/**
 * A grace note (or grace chord) attached to the event that follows it. It has a written value but
 * no place in the bar's time; playback takes its time from the principal note.
 */
export interface GraceNote {
  readonly id: ID;
  /** Slashed stem: acciaccatura (short). Unslashed: appoggiatura. */
  readonly slash?: boolean;
  /** Written value, usually eighth or 16th. */
  readonly value: NoteValue;
  /** One or more notes sharing a stem, ascending by pitch. */
  readonly notes: readonly Note[];
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

/** Articulations in stacking order: the first ones sit closest to the notes. */
export const ARTICULATIONS = [
  'staccato',
  'staccatissimo',
  'tenuto',
  'accent',
  'marcato',
  'harmonic',
  'stopped',
  'open',
  'snapPizzicato',
  'upBow',
  'downBow',
  'fermata',
  'fermataShort',
  'fermataLong',
] as const;
export type Articulation = (typeof ARTICULATIONS)[number];

/** Marks of which a note carries at most one (choosing one replaces the others). */
export const EXCLUSIVE_ARTICULATIONS: readonly (readonly Articulation[])[] = [
  ['fermata', 'fermataShort', 'fermataLong'],
  ['upBow', 'downBow'],
  ['stopped', 'open'],
];

/**
 * trill (tr) · shortTrill (upper mordent, Pralltriller) · mordent (lower mordent, with stroke) ·
 * turn · invertedTurn.
 */
export const ORNAMENTS = ['trill', 'shortTrill', 'mordent', 'turn', 'invertedTurn'] as const;
export type Ornament = (typeof ORNAMENTS)[number];

export const ARPEGGIOS = ['normal', 'up', 'down'] as const;
export type Arpeggio = (typeof ARPEGGIOS)[number];

export const BREATHS = ['breath', 'caesura'] as const;
export type Breath = (typeof BREATHS)[number];

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
  readonly source?: Provenance;
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

// ------------------------------------------------------------------------------- spanners

/** A time position: a measure and an offset inside it (whole notes). */
export interface MeasureAnchor {
  readonly measureId: ID;
  readonly offset: Rational;
}

interface SpannerBase {
  readonly id: ID;
  readonly staffId: ID;
  readonly source?: Provenance;
}

/** A slur from one event to a later event of the same staff and voice. */
export interface Slur extends SpannerBase {
  readonly kind: 'slur';
  /** Event ids. */
  readonly from: ID;
  readonly to: ID;
  /** Default: chosen by the engraver from the stem directions. */
  readonly placement?: 'above' | 'below';
}

/**
 * Lines anchored to time. They cover [start, end): `end` is where the line stops (the end of the
 * last note it covers), always stored inside the measure that contains the last covered moment.
 */
interface TimeSpanner extends SpannerBase {
  readonly start: MeasureAnchor;
  readonly end: MeasureAnchor;
}

export interface Hairpin extends TimeSpanner {
  readonly kind: 'hairpin';
  readonly direction: 'crescendo' | 'diminuendo';
}

/** Octave line: notes inside are written `octaves` octaves away from where they sound. */
export interface OttavaLine extends TimeSpanner {
  readonly kind: 'ottava';
  /** 8va = 1, 15ma = 2, 8vb = −1, 15mb = −2. */
  readonly octaves: number;
}

/** Sustain pedal: "Ped. … *" by default, or a bracket line. */
export interface PedalLine extends TimeSpanner {
  readonly kind: 'pedal';
  readonly style?: 'line';
}

/** "tr" with a wavy line. */
export interface TrillLine extends TimeSpanner {
  readonly kind: 'trill';
}

export type TimeSpannerKind = 'hairpin' | 'ottava' | 'pedal' | 'trill';
export type Spanner = Slur | Hairpin | OttavaLine | PedalLine | TrillLine;
export type TimeSpan = Hairpin | OttavaLine | PedalLine | TrillLine;

export const isTimeSpan = (s: Spanner): s is TimeSpan => s.kind !== 'slur';

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
