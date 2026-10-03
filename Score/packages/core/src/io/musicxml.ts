/**
 * MusicXML import: `score-partwise` (and `score-timewise`, converted) → ScoreDoc.
 *
 * The document model is semantic, MusicXML is notational, so the importer translates:
 *
 * - time: `<divisions>` / `<duration>` become exact rationals in whole notes; `<backup>`,
 *   `<forward>` and `<chord/>` move the time cursor. Bar lengths come from the content of all parts
 *   (pickups and irregular bars get `actualLength`); parts that disagree are reported.
 * - voices: MusicXML voices are per part, ours are per staff (0..3). Each staff gives slots to the
 *   voices that live there first (in order of appearance), then to cross-staff visitors; voices
 *   that never sound in the same bar share a slot. Overlapping notes are moved to a free voice or
 *   the earlier note is shortened (reported).
 * - ties: a chord whose notes are all tied to identical pitches that follow immediately in the
 *   same voice becomes ONE event (also across barlines: one sounding note = one event). Other
 *   ties stay as `tieForward` on the tied notes.
 * - pitch: concert pitch with spelling. Parts with `<transpose>` are converted (written →
 *   sounding, diatonic + chromatic); the score's key is the concert key, preferably taken from a
 *   non-transposing part.
 * - marks, lines, chord symbols, dynamics and tempo map to the model; everything the model does not
 *   have (lyrics, voltas, D.C./D.S., glissandi, unpitched percussion, …) is skipped and counted in
 *   the warnings — never silently.
 *
 * Every imported event, dynamic, chord symbol and line carries
 * `source: { kind: 'import', format: 'musicxml', file }`. Ids come from `options.ids`, so the same
 * input gives the same document. The result passes `validateScore`.
 */
import { type InstrumentDef, findInstrument, getInstrument } from '../instruments/catalog';
import type { ClefType } from '../model/clef';
import { DEFAULT_SETTINGS, type Lang } from '../model/create';
import type { IdGenerator } from '../model/ids';
import { compareSpanners } from '../model/spanners';
import {
  ARTICULATIONS,
  EXCLUSIVE_ARTICULATIONS,
  SCORE_FORMAT,
  SCORE_FORMAT_VERSION,
  VOICES_PER_STAFF,
  type Arpeggio,
  type Articulation,
  type BarlineStyle,
  type Breath,
  type ChordSymbol,
  type ClefChange,
  type DynamicMark,
  type DynamicValue,
  type GraceNote,
  type ID,
  type Measure,
  type MeasureAnchor,
  type Note,
  type NoteEvent,
  type Ornament,
  type Part,
  type Provenance,
  type ScoreDoc,
  type ScoreMeta,
  type ScoreSettings,
  type Spanner,
  type StaffGroup,
  type StaffMeasure,
  type TempoMark,
  type TupletSpan,
} from '../model/types';
import { validateScore } from '../model/validate';
import {
  type Interval,
  type KeySignature,
  type Pitch,
  type Step,
  STEPS,
  comparePitch,
  diatonicOf,
  interval,
  isUnison,
  midiOf,
  pitchEquals,
  pitchFromDiatonic,
  transpose,
  transposeKey,
} from '../pitch/pitch';
import { type NoteValue, writtenLength } from '../time/duration';
import { type TimeSignature, barLength } from '../time/meter';
import {
  type Rational,
  ZERO,
  add,
  cmp,
  div,
  eq,
  isPositive,
  le,
  lt,
  max,
  min,
  mulInt,
  rat,
  sub,
} from '../time/rational';
import { type PartIdentity, guessInstruments, isGenericName } from './musicxml-instruments';
import {
  type XmlElement,
  XmlError,
  decodeXmlBytes,
  parseXml,
  xmlChild,
  xmlChildText,
  xmlChildren,
  xmlText,
} from './xml';
import { type InflateRaw, isZip, readZipEntries, readZipEntry } from './zip';

export interface MusicXmlImportOptions {
  readonly ids: IdGenerator;
  /** ISO timestamp for `meta.createdAt` / `modifiedAt` (pass a fixed value in tests). */
  readonly now: string;
  /** Name of the imported file: recorded in `source.file`, and the title when the file has none. */
  readonly fileName?: string;
  /** Language of catalog instrument names used for unnamed parts (default 'en'). */
  readonly lang?: Lang;
}

export interface MusicXmlImportResult {
  readonly doc: ScoreDoc;
  /** What was skipped or approximated, aggregated (English, one line per kind). */
  readonly warnings: string[];
}

export class MusicXmlError extends Error {
  override name = 'MusicXmlError';
}

// ------------------------------------------------------------------------------- .mxl and bytes

/** File names the importer accepts. */
export const MUSICXML_FILE_PATTERN = /\.(musicxml|mxl|xml)$/i;

/**
 * The MusicXML text of a `.musicxml` / `.xml` file or a compressed `.mxl` archive (the root file
 * is found through `META-INF/container.xml`). Deflate comes from the platform via `inflateRaw`.
 */
export async function musicXmlFromBytes(
  bytes: Uint8Array,
  inflateRaw: InflateRaw,
): Promise<{ readonly xml: string; readonly path: string | null }> {
  if (!isZip(bytes)) return { xml: decodeXmlBytes(bytes), path: null };
  const entries = readZipEntries(bytes);
  const container = entries.find((e) => e.name === 'META-INF/container.xml');
  let path: string | null = null;
  if (container) {
    const xml = decodeXmlBytes(await readZipEntry(bytes, container, inflateRaw));
    const rootfiles = xmlChildren(xmlChild(parseXml(xml), 'rootfiles'), 'rootfile');
    const pick =
      rootfiles.find((r) => (r.attributes['media-type'] ?? '').includes('musicxml')) ??
      rootfiles.find((r) => !r.attributes['media-type']) ??
      rootfiles[0];
    path = pick?.attributes['full-path'] ?? null;
  }
  const entry =
    (path !== null ? entries.find((e) => e.name === path) : undefined) ??
    entries.find((e) => !e.name.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(e.name));
  if (!entry) throw new MusicXmlError('the .mxl archive contains no MusicXML score');
  return { xml: decodeXmlBytes(await readZipEntry(bytes, entry, inflateRaw)), path: entry.name };
}

// ------------------------------------------------------------------------------- warnings

/** Aggregated warnings: one line per kind with a count and the first bar (1-based). */
class WarningLog {
  private readonly items = new Map<string, { count: number; bar: number | null }>();

  add(message: string, bar: number | null = null, count = 1): void {
    const item = this.items.get(message);
    if (item) {
      item.count += count;
      if (item.bar === null) item.bar = bar;
    } else this.items.set(message, { count, bar });
  }

  list(): string[] {
    return [...this.items].map(([message, { count, bar }]) => {
      const where = bar === null ? '' : count > 1 ? `, first in bar ${bar}` : ` (bar ${bar})`;
      return count > 1 ? `${message}: ${count}×${where}` : `${message}${where}`;
    });
  }
}

// ------------------------------------------------------------------------------- small parsers

const intOf = (text: string | undefined): number | null => {
  if (text === undefined) return null;
  const v = Number.parseInt(text.trim(), 10);
  return Number.isFinite(v) ? v : null;
};

const numberOf = (text: string | undefined): number | null => {
  if (text === undefined) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(text);
  return m ? Number(m[0]) : null;
};

/** A MusicXML decimal ("4", "2.5") as an exact rational. */
function decimal(text: string | undefined): Rational | null {
  const m = /^\s*(-?)(\d*)(?:\.(\d*))?\s*$/.exec(text ?? '');
  if (!m || (m[2] === '' && !m[3])) return null;
  const frac = (m[3] ?? '').slice(0, 6);
  const value = Number((m[2] || '0') + frac);
  if (!Number.isSafeInteger(value)) return null;
  return rat(m[1] ? -value : value, 10 ** frac.length);
}

const NOTE_TYPES: Readonly<Record<string, NoteValue>> = {
  maxima: 'breve',
  long: 'breve',
  breve: 'breve',
  whole: 'whole',
  half: 'half',
  quarter: 'quarter',
  eighth: 'eighth',
  '16th': '16th',
  '32nd': '32nd',
  '64th': '64th',
  '128th': '128th',
  '256th': '128th',
  '512th': '128th',
  '1024th': '128th',
};

function noteValueOf(type: string | undefined): NoteValue | null {
  return type ? (NOTE_TYPES[type.trim()] ?? null) : null;
}

/** Concert spelling within ±2 alterations (a transposition may produce E### and the like). */
function normalizeSpelling(p: Pitch): Pitch {
  let q = p;
  while (q.alter > 2) {
    const up = pitchFromDiatonic(diatonicOf(q) + 1, 0);
    q = { ...up, alter: midiOf(q) - midiOf(up) };
  }
  while (q.alter < -2) {
    const down = pitchFromDiatonic(diatonicOf(q) - 1, 0);
    q = { ...down, alter: midiOf(q) - midiOf(down) };
  }
  return q;
}

const isStep = (s: string | undefined): s is Step =>
  !!s && (STEPS as readonly string[]).includes(s);

const abs = (r: Rational): Rational => (r.n < 0 ? rat(-r.n, r.d) : r);

// ------------------------------------------------------------------------------- mapping tables

const ARTICULATION_MAP: Readonly<Record<string, readonly Articulation[]>> = {
  accent: ['accent'],
  'strong-accent': ['marcato'],
  staccato: ['staccato'],
  tenuto: ['tenuto'],
  'detached-legato': ['tenuto', 'staccato'],
  staccatissimo: ['staccatissimo'],
  spiccato: ['staccatissimo'],
};

const TECHNICAL_MAP: Readonly<Record<string, Articulation>> = {
  'up-bow': 'upBow',
  'down-bow': 'downBow',
  harmonic: 'harmonic',
  stopped: 'stopped',
  open: 'open',
  'open-string': 'open',
  'snap-pizzicato': 'snapPizzicato',
};

const ORNAMENT_MAP: Readonly<Record<string, Ornament>> = {
  'trill-mark': 'trill',
  'inverted-mordent': 'shortTrill',
  mordent: 'mordent',
  turn: 'turn',
  'inverted-turn': 'invertedTurn',
  'delayed-turn': 'turn',
  'delayed-inverted-turn': 'invertedTurn',
  'vertical-turn': 'turn',
  'inverted-vertical-turn': 'invertedTurn',
  shake: 'shortTrill',
};
const APPROXIMATE_ORNAMENTS = new Set([
  'delayed-turn',
  'delayed-inverted-turn',
  'vertical-turn',
  'inverted-vertical-turn',
  'shake',
]);

const DYNAMICS: Readonly<Record<string, DynamicValue>> = {
  pppppp: 'pppp',
  ppppp: 'pppp',
  pppp: 'pppp',
  ppp: 'ppp',
  pp: 'pp',
  p: 'p',
  mp: 'mp',
  mf: 'mf',
  f: 'f',
  ff: 'ff',
  fff: 'fff',
  ffff: 'ffff',
  fffff: 'ffff',
  ffffff: 'ffff',
  sf: 'sf',
  sfz: 'sfz',
  sffz: 'sffz',
  fz: 'fz',
  fp: 'fp',
  sfp: 'sfp',
  sfpp: 'sfp',
  sfzp: 'sfz',
  pf: 'p',
  rf: 'rf',
  rfz: 'rfz',
};
const EXACT_DYNAMICS = new Set<string>([
  'pppp',
  'ppp',
  'pp',
  'p',
  'mp',
  'mf',
  'f',
  'ff',
  'fff',
  'ffff',
  'sf',
  'sfz',
  'sffz',
  'fz',
  'fp',
  'sfp',
  'rf',
  'rfz',
]);

/**
 * MusicXML `<kind>` → AIlegro chord-quality id (packages/ailegro-bridge/src/qualities.ts).
 * Kinds without an exact quality are approximated (`approx`).
 */
export const MUSICXML_CHORD_KINDS: Readonly<
  Record<string, { readonly quality: string; readonly approx?: boolean }>
> = {
  major: { quality: 'maj' },
  minor: { quality: 'min' },
  augmented: { quality: 'aug' },
  diminished: { quality: 'dim' },
  dominant: { quality: 'dom7' },
  'major-seventh': { quality: 'maj7' },
  'minor-seventh': { quality: 'min7' },
  'diminished-seventh': { quality: 'dim7' },
  'augmented-seventh': { quality: 'dom7s5' },
  'half-diminished': { quality: 'half' },
  'major-minor': { quality: 'minmaj7' },
  'major-sixth': { quality: 'six' },
  'minor-sixth': { quality: 'min6' },
  'dominant-ninth': { quality: 'dom9' },
  'major-ninth': { quality: 'maj9' },
  'minor-ninth': { quality: 'min9' },
  'dominant-11th': { quality: 'dom11' },
  'major-11th': { quality: 'maj9', approx: true },
  'minor-11th': { quality: 'min11' },
  'dominant-13th': { quality: 'dom13' },
  'major-13th': { quality: 'maj13' },
  'minor-13th': { quality: 'min13' },
  'suspended-second': { quality: 'sus2' },
  'suspended-fourth': { quality: 'sus4' },
  power: { quality: 'power' },
  Neapolitan: { quality: 'maj' },
  Italian: { quality: 'dom7', approx: true },
  French: { quality: 'dom7b5', approx: true },
  German: { quality: 'dom7', approx: true },
  Tristan: { quality: 'half', approx: true },
};

/**
 * Qualities reached by `<degree>` alterations: base quality → "type value alter" → new quality.
 * `add 9` on a dominant is a ninth chord, `alter 5 -1` a flat-five chord, and so on.
 */
const DEGREE_RULES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  maj: {
    'add 9 0': 'add9',
    'add 2 0': 'add9',
    'add 11 0': 'add11',
    'add 4 0': 'add11',
    'add 6 0': 'six',
    'add 7 -1': 'dom7',
    'add 7 0': 'maj7',
  },
  min: {
    'add 9 0': 'minadd9',
    'add 2 0': 'minadd9',
    'add 6 0': 'min6',
    'add 7 -1': 'min7',
    'add 7 0': 'minmaj7',
  },
  six: { 'add 9 0': 'six9' },
  dom7: {
    'add 9 0': 'dom9',
    'add 9 -1': 'dom7b9',
    'add 9 1': 'dom7s9',
    'alter 5 -1': 'dom7b5',
    'alter 5 1': 'dom7s5',
    'add 11 1': 'dom7s11',
    'alter 11 1': 'dom7s11',
    'add 13 -1': 'dom7b13',
    'add 13 0': 'dom13',
    'subtract 3 0 add 4 0': 'sus7',
  },
  dom9: {
    'add 11 1': 'dom9s11',
    'alter 11 1': 'dom9s11',
    'alter 9 -1': 'dom7b9',
    'alter 9 1': 'dom7s9',
    'alter 5 -1': 'dom7b5',
  },
  dom13: { 'alter 9 -1': 'dom13b9', 'add 9 -1': 'dom13b9' },
  maj7: { 'add 11 1': 'maj7s11', 'alter 11 1': 'maj7s11', 'add 9 0': 'maj9' },
  maj9: { 'add 11 1': 'maj9s11', 'alter 11 1': 'maj9s11' },
  minmaj7: { 'add 9 0': 'minmaj9' },
  min7: { 'alter 5 -1': 'half', 'add 9 0': 'min9', 'add 11 0': 'min11' },
  sus4: { 'add 7 -1': 'sus7', 'add 7 0': 'sus7' },
  sus2: { 'add 7 -1': 'sus27' },
};

const CHORD_KIND_ALIASES: Readonly<Record<string, string>> = {
  'minor-major': 'major-minor', // written by some exporters
  'minor-major-seventh': 'major-minor',
  'dominant-seventh': 'dominant',
  'major-major': 'major-seventh',
};

function chordKind(kind: string): (typeof MUSICXML_CHORD_KINDS)[string] | undefined {
  const exact = MUSICXML_CHORD_KINDS[kind] ?? MUSICXML_CHORD_KINDS[CHORD_KIND_ALIASES[kind] ?? ''];
  if (exact) return exact;
  const lower = kind.toLowerCase();
  const key = Object.keys(MUSICXML_CHORD_KINDS).find((k) => k.toLowerCase() === lower);
  return key ? MUSICXML_CHORD_KINDS[key] : undefined;
}

const TEMPO_WORDS: readonly (readonly [RegExp, number])[] = [
  [/^(prestissimo)\b/i, 200],
  [/^(presto)\b/i, 180],
  [/^(vivacissimo|allegrissimo)\b/i, 172],
  [/^(vivace)\b/i, 160],
  [/^(allegro)\b/i, 132],
  [/^(allegretto)\b/i, 112],
  [/^(moderato)\b/i, 108],
  [/^(andantino)\b/i, 92],
  [/^(andante)\b/i, 80],
  [/^(adagietto)\b/i, 72],
  [/^(larghetto)\b/i, 60],
  [/^(adagio)\b/i, 66],
  [/^(lento)\b/i, 52],
  [/^(largo|grave)\b/i, 46],
  [/^(tempo di marcia|alla marcia)\b/i, 116],
];

function tempoFromWords(text: string): number | null {
  for (const [re, bpm] of TEMPO_WORDS) if (re.test(text.trim())) return bpm;
  return null;
}

const BARLINES: Readonly<Record<string, BarlineStyle>> = {
  regular: 'single',
  dotted: 'dashed',
  dashed: 'dashed',
  'light-light': 'double',
  'light-heavy': 'final',
  'heavy-light': 'double',
  'heavy-heavy': 'double',
  heavy: 'single',
  tick: 'single',
  short: 'single',
  none: 'none',
};

// ------------------------------------------------------------------------------- raw material

/** A time position as read: a bar (index) and an offset in it (whole notes). */
interface Pos {
  readonly measure: number;
  readonly offset: Rational;
}

interface RawNote {
  readonly pitch: Pitch;
  /** Tied (MusicXML tie or tied start) to the next note of the same pitch. */
  tie: boolean;
  readonly cautionary: boolean;
  tieForward: boolean;
}

interface RawGrace {
  readonly part: number;
  readonly staff: number;
  readonly voice: string;
  readonly measure: number;
  readonly offset: Rational;
  readonly order: number;
  readonly slash: boolean;
  readonly value: NoteValue;
  readonly notes: RawNote[];
  start: Rational;
  principal: RawEvent | null;
}

interface RawEvent {
  readonly part: number;
  /** Staff index inside the part. */
  readonly staff: number;
  readonly voice: string;
  readonly measure: number;
  readonly offset: Rational;
  readonly order: number;
  /** Duration as read (lines anchored to this note use it). */
  readonly length: Rational;
  duration: Rational;
  start: Rational;
  notes: RawNote[];
  articulations: Articulation[];
  ornament: Ornament | null;
  tremolo: number;
  arpeggio: Arpeggio | null;
  breath: Breath | null;
  cue: boolean;
  graces: RawGrace[];
  mergedInto: RawEvent | null;
  slot: number;
  dropped: boolean;
  id: ID;
}

type Endpoint = RawEvent | RawGrace;

interface RawSlur {
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly placement: 'above' | 'below' | null;
}

interface RawLine {
  readonly kind: 'hairpin' | 'ottava' | 'pedal';
  readonly part: number;
  /** Staff inside the part; -1 = the part's lowest staff (pedal marks). */
  readonly staff: number;
  readonly start: Pos;
  readonly end: Pos;
  readonly direction?: 'crescendo' | 'diminuendo';
  readonly octaves?: number;
  readonly style?: 'line';
}

interface RawTuplet {
  readonly part: number;
  readonly staff: number;
  readonly voice: string;
  readonly measure: number;
  readonly offset: Rational;
  readonly length: Rational;
  readonly actual: number;
  readonly normal: number;
}

interface MeasureFacts {
  /** Furthest time reached by notes, rests and forwards (not by whole-bar rests). */
  end: Rational;
  hasNotes: boolean;
  implicit: boolean;
  barline: BarlineStyle | null;
  leftBarline: BarlineStyle | null;
  repeatStart: boolean;
  repeatEnd: boolean;
  rehearsal: string | null;
}

interface ParsedPart {
  staves: number;
  partSymbol: StaffGroup['kind'] | 'none' | null;
  readonly firstClefs: (ClefType | null)[];
  readonly clefs: { staff: number; pos: Pos; clef: ClefType }[];
  readonly staffLines: (number | null)[];
  readonly keys: { pos: Pos; key: KeySignature; transposing: boolean }[];
  readonly times: { pos: Pos; time: TimeSignature }[];
  transposition: Interval | null;
  readonly measures: MeasureFacts[];
  readonly events: RawEvent[];
  readonly graces: RawGrace[];
  readonly tuplets: RawTuplet[];
  readonly slurs: RawSlur[];
  readonly lines: RawLine[];
  readonly trills: { from: RawEvent; to: RawEvent }[];
  readonly dynamics: { staff: number; pos: Pos; value: DynamicValue }[];
  readonly harmony: {
    pos: Pos;
    root: { step: Step; alter: number };
    bass: { step: Step; alter: number } | null;
    quality: string;
  }[];
  readonly tempos: {
    pos: Pos;
    bpm: number | null;
    beatUnit: Rational | null;
    text: string | null;
  }[];
  hasLyrics: boolean;
  unpitched: boolean;
  percussionClef: boolean;
}

interface ScorePartInfo {
  readonly id: string;
  readonly name: string;
  readonly abbreviation: string;
  readonly instrumentNames: readonly string[];
  readonly sounds: readonly string[];
  readonly program: number | null;
  readonly percussionChannel: boolean;
}

interface PartGroupInfo {
  readonly first: number;
  readonly last: number;
  readonly symbol: string;
  readonly barline: boolean;
  readonly name: string;
}

// ------------------------------------------------------------------------------- header

function displayText(el: XmlElement | undefined): string {
  if (!el) return '';
  const parts = xmlChildren(el, 'display-text').map((d) => xmlText(d));
  return parts.join('').replace(/\s+/g, ' ').trim();
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

function readPartList(root: XmlElement): { parts: ScorePartInfo[]; groups: PartGroupInfo[] } {
  const parts: ScorePartInfo[] = [];
  const groups: PartGroupInfo[] = [];
  const open = new Map<string, { first: number; symbol: string; barline: boolean; name: string }>();
  for (const el of xmlChildren(xmlChild(root, 'part-list'))) {
    if (el.name === 'part-group') {
      const number = el.attributes.number ?? '1';
      if (el.attributes.type === 'start') {
        const barlineText = xmlChildText(el, 'group-barline');
        open.set(number, {
          first: parts.length,
          symbol: xmlChildText(el, 'group-symbol') ?? 'none',
          barline: barlineText === undefined ? true : barlineText === 'yes',
          name: clean(xmlChildText(el, 'group-name') ?? ''),
        });
      } else if (el.attributes.type === 'stop') {
        const g = open.get(number);
        open.delete(number);
        if (g && parts.length - 1 >= g.first) groups.push({ ...g, last: parts.length - 1 });
      }
    } else if (el.name === 'score-part') {
      const instruments = xmlChildren(el, 'score-instrument');
      const midi = xmlChildren(el, 'midi-instrument');
      const program = midi
        .map((m) => intOf(xmlChildText(m, 'midi-program')))
        .find((p) => p !== null);
      parts.push({
        id: el.attributes.id ?? `P${parts.length + 1}`,
        name:
          displayText(xmlChild(el, 'part-name-display')) ||
          clean(xmlChildText(el, 'part-name') ?? ''),
        abbreviation:
          displayText(xmlChild(el, 'part-abbreviation-display')) ||
          clean(xmlChildText(el, 'part-abbreviation') ?? ''),
        instrumentNames: instruments.map((i) => clean(xmlChildText(i, 'instrument-name') ?? '')),
        sounds: instruments.map((i) => xmlChildText(i, 'instrument-sound') ?? '').filter(Boolean),
        program:
          program !== undefined && program !== null
            ? Math.max(0, Math.min(127, program - 1))
            : null,
        percussionChannel: midi.some((m) => intOf(xmlChildText(m, 'midi-channel')) === 10),
      });
    }
  }
  for (const g of open.values())
    if (parts.length - 1 >= g.first) groups.push({ ...g, last: parts.length - 1 });
  return { parts, groups };
}

function readMeta(
  root: XmlElement,
  fileName: string | undefined,
  lang: Lang,
): Omit<ScoreMeta, 'createdAt' | 'modifiedAt'> {
  const work = xmlChild(root, 'work');
  const workTitle = clean(xmlChildText(work, 'work-title') ?? '');
  const movementTitle = clean(xmlChildText(root, 'movement-title') ?? '');
  const identification = xmlChild(root, 'identification');
  const creator = (type: string) =>
    xmlChildren(identification, 'creator')
      .filter((c) => (c.attributes.type ?? '') === type)
      .map((c) => clean(xmlText(c)))
      .filter(Boolean)
      .join(', ');
  const rights = xmlChildren(identification, 'rights')
    .map((r) => clean(xmlText(r)))
    .filter(Boolean)
    .join(' ');
  // Credits (page text): typed credits first, else the largest text on page 1 as the title.
  const credits = xmlChildren(root, 'credit').filter((c) => (c.attributes.page ?? '1') === '1');
  const credit = (type: string) =>
    credits
      .filter((c) => xmlChildren(c, 'credit-type').some((t) => xmlText(t).trim() === type))
      .map((c) => clean(xmlChildren(c, 'credit-words').map(xmlText).join(' ')))
      .filter(Boolean)
      .join(' ');
  let creditTitle = credit('title');
  if (!creditTitle) {
    let best = 0;
    for (const c of credits) {
      if (xmlChildren(c, 'credit-type').length) continue;
      for (const w of xmlChildren(c, 'credit-words')) {
        const size = Number.parseFloat(w.attributes['font-size'] ?? '0') || 0;
        const text = clean(xmlText(w));
        if (text && size > best && !/©|copyright/i.test(text)) {
          best = size;
          creditTitle = text;
        }
      }
    }
  }
  const baseName = fileName
    ? fileName.replace(/^.*[\\/]/, '').replace(MUSICXML_FILE_PATTERN, '')
    : '';
  let title =
    workTitle ||
    movementTitle ||
    creditTitle ||
    baseName ||
    (lang === 'zh' ? '未命名乐谱' : 'Untitled Score');
  let subtitle = credit('subtitle');
  if (workTitle && movementTitle && workTitle !== movementTitle) {
    title = workTitle;
    subtitle ||= movementTitle;
  }
  const composer = creator('composer') || credit('composer');
  const lyricist = creator('lyricist') || creator('poet') || credit('lyricist');
  const arranger = creator('arranger') || credit('arranger');
  const copyright = rights || credit('rights');
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(composer ? { composer } : {}),
    ...(arranger ? { arranger } : {}),
    ...(lyricist ? { lyricist } : {}),
    ...(copyright ? { copyright } : {}),
  };
}

function readSettings(root: XmlElement): ScoreSettings {
  const defaults = xmlChild(root, 'defaults');
  const scaling = xmlChild(defaults, 'scaling');
  const mm = numberOf(xmlChildText(scaling, 'millimeters'));
  const tenths = numberOf(xmlChildText(scaling, 'tenths'));
  let settings: ScoreSettings = {
    ...DEFAULT_SETTINGS,
    concertPitch: !!xmlChild(defaults, 'concert-score'),
  };
  if (!mm || !tenths || mm <= 0 || tenths <= 0) return settings;
  const toMm = (t: number | null) =>
    t === null ? null : Math.round(((t * mm) / tenths) * 10) / 10;
  // 40 tenths are one staff height (four staff spaces).
  const space = Math.round((mm / 4) * (40 / tenths) * 100) / 100;
  if (space >= 0.9 && space <= 2.6) settings = { ...settings, staffSpaceMm: space };
  const page = xmlChild(defaults, 'page-layout');
  const width = toMm(numberOf(xmlChildText(page, 'page-width')));
  const height = toMm(numberOf(xmlChildText(page, 'page-height')));
  if (width && height && width >= 90 && width <= 700 && height >= 90 && height <= 1000) {
    settings = { ...settings, pageSize: { widthMm: width, heightMm: height } };
    const margins =
      xmlChildren(page, 'page-margins').find((m) => (m.attributes.type ?? 'both') !== 'even') ??
      xmlChild(page, 'page-margins');
    const side = (name: string) => toMm(numberOf(xmlChildText(margins, name)));
    const [top, bottom, left, right] = [
      side('top-margin'),
      side('bottom-margin'),
      side('left-margin'),
      side('right-margin'),
    ];
    const ok = (v: number | null): v is number => v !== null && v >= 0 && v <= width / 3;
    if (ok(top) && ok(bottom) && ok(left) && ok(right))
      settings = { ...settings, pageMarginsMm: { top, bottom, left, right } };
  }
  return settings;
}

/** `<score-timewise>` → `<score-partwise>` (same header; measures regrouped by part). */
function timewiseToPartwise(root: XmlElement): XmlElement {
  const header = root.children.filter((c) => typeof c === 'string' || c.name !== 'measure');
  const byPart = new Map<string, XmlElement[]>();
  for (const m of xmlChildren(root, 'measure')) {
    for (const p of xmlChildren(m, 'part')) {
      const id = p.attributes.id ?? '';
      const list = byPart.get(id) ?? byPart.set(id, []).get(id)!;
      list.push({ name: 'measure', attributes: m.attributes, children: p.children });
    }
  }
  const parts: XmlElement[] = [...byPart].map(([id, measures]) => ({
    name: 'part',
    attributes: { id },
    children: measures,
  }));
  return { name: 'score-partwise', attributes: root.attributes, children: [...header, ...parts] };
}

// ------------------------------------------------------------------------------- clefs, keys, times

function clefOf(el: XmlElement, log: WarningLog, bar: number): ClefType | null {
  const sign = (xmlChildText(el, 'sign') ?? '').toUpperCase();
  const line = intOf(xmlChildText(el, 'line'));
  const octave = intOf(xmlChildText(el, 'clef-octave-change')) ?? 0;
  const approx = (clef: ClefType): ClefType => {
    log.add('Clefs without an exact equivalent were approximated', bar);
    return clef;
  };
  switch (sign) {
    case 'G': {
      const base: ClefType = octave < 0 ? 'treble8vb' : octave > 0 ? 'treble8va' : 'treble';
      return (line ?? 2) === 2 && Math.abs(octave) <= 1 ? base : approx(base);
    }
    case 'F': {
      const base: ClefType = octave < 0 ? 'bass8vb' : 'bass';
      return (line ?? 4) === 4 && octave >= -1 && octave <= 0 ? base : approx(base);
    }
    case 'C': {
      const l = line ?? 3;
      if (octave !== 0) log.add('Clefs without an exact equivalent were approximated', bar);
      if (l === 1) return 'soprano';
      if (l === 3) return 'alto';
      if (l === 4) return 'tenor';
      return approx(l === 2 ? 'soprano' : 'bass');
    }
    case 'PERCUSSION':
      return 'percussion';
    case 'TAB':
      log.add('Tablature staves are imported as ordinary staves (treble 8vb clef)', bar);
      return 'treble8vb';
    case 'JIANPU':
      return approx('treble');
    default:
      return null;
  }
}

function timeOf(el: XmlElement, log: WarningLog, bar: number): TimeSignature | null {
  if (xmlChild(el, 'senza-misura')) {
    log.add('Unmetered (senza misura) bars keep their actual length', bar);
    return null;
  }
  const beatsList = xmlChildren(el, 'beats').map((b) => xmlText(b).trim());
  const typeList = xmlChildren(el, 'beat-type').map((b) => intOf(xmlText(b)));
  if (!beatsList.length || !typeList.length) return null;
  const symbol = el.attributes.symbol;
  const extra =
    symbol === 'common' || symbol === 'cut' ? { symbol: symbol as 'common' | 'cut' } : {};
  if (beatsList.length === 1 && typeList.length === 1) {
    const groups = beatsList[0]!.split('+').map((b) => intOf(b) ?? 0);
    const type = typeList[0]!;
    if (!type || groups.some((g) => g <= 0)) return null;
    const beats = groups.reduce((a, b) => a + b, 0);
    return { beats, beatType: type, ...extra, ...(groups.length > 1 ? { groups } : {}) };
  }
  // Composite meters such as 2/4 + 3/8: one signature with the same bar length.
  let total = ZERO;
  for (let k = 0; k < beatsList.length; k++) {
    const beats = (beatsList[k] ?? '').split('+').reduce((a, b) => a + (intOf(b) ?? 0), 0);
    const type = typeList[k] ?? typeList[typeList.length - 1]!;
    if (!type || beats <= 0) return null;
    total = add(total, rat(beats, type));
  }
  log.add('Composite time signatures were simplified to one signature', bar);
  return { beats: total.n, beatType: total.d };
}

// ------------------------------------------------------------------------------- part parsing

interface ParseContext {
  readonly log: WarningLog;
  readonly concertScore: boolean;
  order: number;
}

function parsePart(partEl: XmlElement, partIndex: number, ctx: ParseContext): ParsedPart {
  const { log } = ctx;
  const out: ParsedPart = {
    staves: 1,
    partSymbol: null,
    firstClefs: [],
    clefs: [],
    staffLines: [],
    keys: [],
    times: [],
    transposition: null,
    measures: [],
    events: [],
    graces: [],
    tuplets: [],
    slurs: [],
    lines: [],
    trills: [],
    dynamics: [],
    harmony: [],
    tempos: [],
    hasLyrics: false,
    unpitched: false,
    percussionClef: false,
  };
  let divisions = rat(1);
  let transposition: Interval | null = null;
  const seenTranspositions = new Set<string>();
  const openSlurs = new Map<string, { from: Endpoint; placement: 'above' | 'below' | null }>();
  const openWedges = new Map<
    string,
    { staff: number; start: Pos; direction: 'crescendo' | 'diminuendo' }
  >();
  const openOttavas = new Map<string, { staff: number; start: Pos; octaves: number }>();
  let openPedal: { start: Pos; style?: 'line' } | null = null;
  const openTrills = new Map<string, RawEvent>();
  // tuplets: explicit (<tuplet> start/stop) per staff+voice, implicit groups from time-modification
  const openTuplets = new Map<
    string,
    {
      measure: number;
      offset: Rational;
      actual: number;
      normal: number;
      number: string;
      nested: number;
    }
  >();
  const implicitTuplets = new Map<
    string,
    {
      measure: number;
      offset: Rational;
      actual: number;
      normal: number;
      target: Rational;
      sum: Rational;
    }
  >();

  const toWhole = (amount: Rational) => div(amount, mulInt(divisions, 4));
  const toConcert = (p: Pitch): Pitch =>
    transposition && !ctx.concertScore ? normalizeSpelling(transpose(p, transposition)) : p;

  const closeImplicit = (key: string, staff: number, voice: string) => {
    const g = implicitTuplets.get(key);
    implicitTuplets.delete(key);
    if (!g || !isPositive(g.sum)) return;
    out.tuplets.push({
      part: partIndex,
      staff,
      voice,
      measure: g.measure,
      offset: g.offset,
      length: g.sum,
      actual: g.actual,
      normal: g.normal,
    });
  };

  const measureEls = xmlChildren(partEl, 'measure');
  measureEls.forEach((measureEl, mi) => {
    const bar = mi + 1;
    const facts: MeasureFacts = {
      end: ZERO,
      hasNotes: false,
      implicit: measureEl.attributes.implicit === 'yes',
      barline: null,
      leftBarline: null,
      repeatStart: false,
      repeatEnd: false,
      rehearsal: null,
    };
    out.measures.push(facts);
    let cursor = ZERO;
    // the file's own time grid (in divisions); `cursor` differs from it only inside tuplets whose
    // durations the file had to round, and is brought back to it at every <backup> / <forward>
    let fileCursor = ZERO;
    let lastStart = ZERO;
    // written and actual length of the current chord's first note
    let chordHead: { notated: Rational | null; duration: Rational; staff: number; voice: string } =
      {
        notated: null,
        duration: ZERO,
        staff: 0,
        voice: '1',
      };
    // events of the current chord by staff|voice|duration (chord notes may sit on another staff)
    let chord = new Map<string, RawEvent>();
    let lastGrace: RawGrace | null = null;

    const staffOf = (text: string | undefined): number => {
      const s = Math.max(1, intOf(text) ?? 1);
      if (s > out.staves) out.staves = s;
      return s - 1;
    };
    const advance = (to: Rational) => {
      cursor = to;
      if (lt(facts.end, cursor)) facts.end = cursor;
    };
    /** The length a note is written as: type, dots and tuplet ratio. */
    const notatedLength = (el: XmlElement): Rational | null => {
      const value = noteValueOf(xmlChildText(el, 'type'));
      const dots = xmlChildren(el, 'dot').length;
      if (!value || dots > 2) return null;
      const tm = xmlChild(el, 'time-modification');
      const a = intOf(xmlChildText(tm, 'actual-notes'));
      const b = intOf(xmlChildText(tm, 'normal-notes'));
      const written = writtenLength({ value, dots });
      return a && b && a > 0 && b > 0 ? div(mulInt(written, b), rat(a)) : written;
    };
    const durationOf = (el: XmlElement): Rational | null => {
      const d = decimal(xmlChildText(el, 'duration'));
      return d && isPositive(d) ? toWhole(d) : null;
    };
    const posAt = (offset: Rational): Pos => ({ measure: mi, offset });

    // ---------------------------------------------------------------- slurs and lines
    const slurStart = (number: string, from: Endpoint, placement: 'above' | 'below' | null) => {
      if (openSlurs.has(number)) log.add('Slurs with only one end were dropped', bar);
      openSlurs.set(number, { from, placement });
    };
    const slurStop = (number: string, to: Endpoint) => {
      const open = openSlurs.get(number);
      if (open) {
        openSlurs.delete(number);
        out.slurs.push({ from: open.from, to, placement: open.placement });
      } else log.add('Slurs with only one end were dropped', bar);
    };
    const readSlurs = (notations: XmlElement[], endpoint: Endpoint) => {
      for (const n of notations)
        for (const s of xmlChildren(n, 'slur')) {
          const number = s.attributes.number ?? '1';
          const placement =
            s.attributes.placement === 'above' || s.attributes.placement === 'below'
              ? s.attributes.placement
              : null;
          if (s.attributes.type === 'start') slurStart(number, endpoint, placement);
          else if (s.attributes.type === 'stop') slurStop(number, endpoint);
        }
    };

    // ---------------------------------------------------------------- tuplets
    const readTuplets = (
      el: XmlElement,
      notations: XmlElement[],
      staff: number,
      voice: string,
      start: Rational,
      duration: Rational,
    ) => {
      const key = `${staff}|${voice}`;
      const tm = xmlChild(el, 'time-modification');
      const actualNotes = intOf(xmlChildText(tm, 'actual-notes'));
      const normalNotes = intOf(xmlChildText(tm, 'normal-notes'));
      const tuplets = notations.flatMap((n) => xmlChildren(n, 'tuplet'));
      for (const t of tuplets) {
        if (t.attributes.type !== 'start') continue;
        const number = t.attributes.number ?? '1';
        const open = openTuplets.get(key);
        if (open) {
          open.nested++;
          log.add('Nested tuplets keep only the outer bracket', bar);
          continue;
        }
        closeImplicit(key, staff, voice);
        const a = intOf(xmlChildText(xmlChild(t, 'tuplet-actual'), 'tuplet-number')) ?? actualNotes;
        const b = intOf(xmlChildText(xmlChild(t, 'tuplet-normal'), 'tuplet-number')) ?? normalNotes;
        if (!a || !b || a <= 0 || b <= 0) continue;
        openTuplets.set(key, {
          measure: mi,
          offset: start,
          actual: a,
          normal: b,
          number,
          nested: 0,
        });
      }
      const inExplicit = openTuplets.has(key);
      if (!inExplicit && actualNotes && normalNotes && actualNotes !== normalNotes) {
        // no <tuplet> brackets: group notes until the written span of the tuplet is complete
        const normalType =
          noteValueOf(xmlChildText(tm, 'normal-type')) ?? noteValueOf(xmlChildText(el, 'type'));
        const dots = xmlChildren(tm, 'normal-dot').length;
        let g = implicitTuplets.get(key);
        if (g && (g.actual !== actualNotes || g.normal !== normalNotes || g.measure !== mi)) {
          closeImplicit(key, staff, voice);
          g = undefined;
        }
        if (!g && normalType) {
          g = {
            measure: mi,
            offset: start,
            actual: actualNotes,
            normal: normalNotes,
            target: mulInt(
              writtenLength({ value: normalType, dots: Math.min(dots, 2) }),
              normalNotes,
            ),
            sum: ZERO,
          };
          implicitTuplets.set(key, g);
        }
        if (g) {
          g.sum = add(g.sum, duration);
          if (!lt(g.sum, g.target)) closeImplicit(key, staff, voice);
        }
      } else if (!inExplicit) closeImplicit(key, staff, voice);
      for (const t of tuplets) {
        if (t.attributes.type !== 'stop') continue;
        const open = openTuplets.get(key);
        if (!open) continue;
        if (open.nested > 0) {
          open.nested--;
          continue;
        }
        openTuplets.delete(key);
        if (open.measure !== mi) {
          log.add('Tuplets that cross a barline are written without a bracket', bar);
          continue;
        }
        const end = add(start, duration);
        if (lt(open.offset, end))
          out.tuplets.push({
            part: partIndex,
            staff,
            voice,
            measure: mi,
            offset: open.offset,
            length: sub(end, open.offset),
            actual: open.actual,
            normal: open.normal,
          });
      }
    };

    // ---------------------------------------------------------------- note marks
    const readMarks = (notations: XmlElement[], ev: RawEvent, note: RawNote | null) => {
      const addArticulation = (a: Articulation) => {
        if (ev.articulations.includes(a)) return;
        const group = EXCLUSIVE_ARTICULATIONS.find((g) => g.includes(a));
        if (group && ev.articulations.some((x) => group.includes(x))) return;
        ev.articulations.push(a);
      };
      for (const n of notations) {
        for (const item of xmlChildren(n)) {
          switch (item.name) {
            case 'tied':
              if (item.attributes.type === 'start' || item.attributes.type === 'continue') {
                if (note) note.tie = true;
              } else if (item.attributes.type === 'let-ring')
                log.add('"Let ring" ties are not supported', bar);
              break;
            case 'slur':
            case 'tuplet':
              break; // read elsewhere
            case 'articulations':
              for (const a of xmlChildren(item)) {
                const mapped = ARTICULATION_MAP[a.name];
                if (mapped) {
                  mapped.forEach(addArticulation);
                  if (a.name === 'spiccato') log.add('Spiccato is shown as staccatissimo', bar);
                } else if (a.name === 'breath-mark') ev.breath = 'breath';
                else if (a.name === 'caesura') ev.breath = 'caesura';
                else log.add(`Articulation "${a.name}" is not supported`, bar);
              }
              break;
            case 'technical':
              for (const t of xmlChildren(item)) {
                const mapped = TECHNICAL_MAP[t.name];
                if (mapped) addArticulation(mapped);
                else if (t.name === 'fingering') log.add('Fingerings are not supported yet', bar);
                else log.add(`Technical mark "${t.name}" is not supported`, bar);
              }
              break;
            case 'fermata': {
              const shape = xmlText(item).trim();
              const f: Articulation =
                shape === 'angled' || shape === 'double-angled'
                  ? 'fermataShort'
                  : shape === 'square' || shape === 'double-square'
                    ? 'fermataLong'
                    : 'fermata';
              if (shape && !['normal', 'angled', 'square'].includes(shape))
                log.add('Fermata shapes without an equivalent were approximated', bar);
              addArticulation(f);
              break;
            }
            case 'ornaments':
              for (const o of xmlChildren(item)) {
                const mapped = ORNAMENT_MAP[o.name];
                if (mapped) {
                  if (ev.ornament && ev.ornament !== mapped)
                    log.add('Only one ornament per note is kept', bar);
                  else ev.ornament = mapped;
                  if (APPROXIMATE_ORNAMENTS.has(o.name))
                    log.add(`Ornament "${o.name}" was approximated`, bar);
                } else if (o.name === 'wavy-line') {
                  const number = o.attributes.number ?? '1';
                  if (o.attributes.type === 'start') openTrills.set(number, ev);
                  else if (o.attributes.type === 'stop') {
                    const from = openTrills.get(number);
                    openTrills.delete(number);
                    if (from) out.trills.push({ from, to: ev });
                  }
                } else if (o.name === 'tremolo') {
                  const type = o.attributes.type ?? 'single';
                  if (type === 'single') {
                    const strokes = intOf(xmlText(o)) ?? 3;
                    ev.tremolo = Math.max(1, Math.min(4, strokes));
                    if (strokes > 4) log.add('Tremolos with more than 4 strokes show 4', bar);
                  } else if (type === 'start')
                    log.add('Two-note tremolos are not supported yet', bar);
                  else if (type === 'unmeasured')
                    log.add('Unmeasured (buzz) tremolos are not supported', bar);
                } else if (o.name === 'accidental-mark')
                  log.add('Accidentals on ornaments are not supported', bar);
                else log.add(`Ornament "${o.name}" is not supported`, bar);
              }
              break;
            case 'arpeggiate': {
              const d = item.attributes.direction;
              ev.arpeggio = d === 'up' ? 'up' : d === 'down' ? 'down' : 'normal';
              break;
            }
            case 'non-arpeggiate':
              log.add('Non-arpeggio brackets are not supported', bar);
              break;
            case 'glissando':
            case 'slide':
              if (item.attributes.type === 'start')
                log.add('Glissandi and slides are not supported yet', bar);
              break;
            case 'dynamics':
              for (const d of xmlChildren(item)) addDynamic(d, ev.staff, posAt(ev.offset));
              break;
            case 'accidental-mark':
              log.add('Accidentals above or below notes are not supported', bar);
              break;
            default:
              log.add(`Notation "${item.name}" is not supported`, bar);
          }
        }
      }
    };

    const addDynamic = (d: XmlElement, staff: number, pos: Pos) => {
      let name = d.name;
      if (name === 'other-dynamics') name = xmlText(d).trim().toLowerCase();
      const value = DYNAMICS[name];
      if (!value) {
        log.add(`Dynamic "${name}" is not supported`, bar);
        return;
      }
      if (!EXACT_DYNAMICS.has(name)) log.add(`Dynamic "${name}" is shown as "${value}"`, bar);
      out.dynamics.push({ staff, pos, value });
    };

    // ---------------------------------------------------------------- elements
    const onAttributes = (el: XmlElement) => {
      const d = decimal(xmlChildText(el, 'divisions'));
      if (d && isPositive(d)) divisions = d;
      const staves = intOf(xmlChildText(el, 'staves'));
      if (staves && staves > out.staves) out.staves = Math.min(staves, 16);
      const symbol = xmlChildText(el, 'part-symbol');
      if (symbol !== undefined)
        out.partSymbol =
          symbol === 'bracket' || symbol === 'line'
            ? 'bracket'
            : symbol === 'square'
              ? 'square'
              : symbol === 'none'
                ? 'none'
                : 'brace';
      // <transpose> comes after <key> in MusicXML, but the key must be read with it
      for (const t of xmlChildren(el, 'transpose')) {
        if (t.attributes.number && t.attributes.number !== '1') continue;
        const chromatic = intOf(xmlChildText(t, 'chromatic')) ?? 0;
        const octaves = intOf(xmlChildText(t, 'octave-change')) ?? 0;
        const diatonic = intOf(xmlChildText(t, 'diatonic')) ?? Math.round((chromatic * 7) / 12);
        const next = interval(diatonic + 7 * octaves, chromatic + 12 * octaves);
        if (xmlChild(t, 'double')) log.add('Octave doubling in transpositions is ignored', bar);
        transposition = isUnison(next) ? null : next;
        const key = `${next.diatonic}/${next.chromatic}`;
        if (!seenTranspositions.has(key)) {
          seenTranspositions.add(key);
          if (seenTranspositions.size > 1)
            log.add(
              'An instrument changes its transposition; written notes are shown with the first one',
              bar,
            );
          else out.transposition = transposition;
        }
      }
      for (const k of xmlChildren(el, 'key')) {
        if (k.attributes.number && k.attributes.number !== '1') continue;
        const fifths = intOf(xmlChildText(k, 'fifths'));
        if (fifths === null) {
          if (xmlChild(k, 'key-step'))
            log.add('Non-traditional key signatures are not supported', bar);
          continue;
        }
        const modeText = xmlChildText(k, 'mode');
        if (modeText && modeText !== 'major' && modeText !== 'minor' && modeText !== 'none')
          log.add('Key modes other than major and minor are imported without a mode', bar);
        const written: KeySignature =
          modeText === 'major' || modeText === 'minor'
            ? { fifths: Math.max(-7, Math.min(7, fifths)), mode: modeText }
            : { fifths: Math.max(-7, Math.min(7, fifths)) };
        const transposing = !!transposition && !ctx.concertScore && !isUnison(transposition);
        out.keys.push({
          pos: posAt(cursor),
          key: transposing ? transposeKey(written, transposition!) : written,
          transposing,
        });
      }
      for (const t of xmlChildren(el, 'time')) {
        if (t.attributes.number && t.attributes.number !== '1') continue;
        const time = timeOf(t, log, bar);
        if (time) out.times.push({ pos: posAt(cursor), time });
      }
      for (const c of xmlChildren(el, 'clef')) {
        const staff = staffOf(c.attributes.number);
        const clef = clefOf(c, log, bar);
        if (!clef) continue;
        if (clef === 'percussion') out.percussionClef = true;
        if (mi === 0 && cursor.n === 0) out.firstClefs[staff] = clef;
        else out.clefs.push({ staff, pos: posAt(cursor), clef });
      }
      for (const sd of xmlChildren(el, 'staff-details')) {
        const staff = staffOf(sd.attributes.number);
        const lines = intOf(xmlChildText(sd, 'staff-lines'));
        if (lines !== null && lines >= 1 && lines <= 5) out.staffLines[staff] = lines;
      }
      for (const ms of xmlChildren(el, 'measure-style')) {
        if (xmlChild(ms, 'measure-repeat')?.attributes.type === 'start')
          log.add('Measure repeat signs are not expanded (the bars stay empty)', bar);
        if (xmlChild(ms, 'beat-repeat')?.attributes.type === 'start')
          log.add('Beat repeat signs are not expanded', bar);
        if (xmlChild(ms, 'slash')?.attributes.type === 'start')
          log.add('Slash notation is not supported', bar);
      }
    };

    const onNote = (el: XmlElement) => {
      const grace = xmlChild(el, 'grace');
      const isChord = !!xmlChild(el, 'chord');
      const restEl = xmlChild(el, 'rest');
      const pitchEl = xmlChild(el, 'pitch');
      // chord notes without their own <staff> / <voice> belong with the chord's first note
      const staffText = xmlChildText(el, 'staff');
      const voiceText = xmlChildText(el, 'voice');
      const inherit = grace ? lastGrace : chordHead;
      const staff =
        isChord && staffText === undefined && inherit ? inherit.staff : staffOf(staffText);
      const voice = voiceText || (isChord && inherit ? inherit.voice : '1');
      const notations = xmlChildren(el, 'notations');
      const lyrics = xmlChildren(el, 'lyric').length;
      if (lyrics) {
        out.hasLyrics = true;
        log.add('Lyrics are not supported yet (syllables skipped)', bar, lyrics);
      }
      const readPitch = (): Pitch | null => {
        const step = xmlChildText(pitchEl, 'step')?.toUpperCase();
        const octave = intOf(xmlChildText(pitchEl, 'octave'));
        const alterText = xmlChildText(pitchEl, 'alter');
        const alterValue = alterText !== undefined ? Number(alterText) : 0;
        if (!isStep(step) || octave === null || !Number.isFinite(alterValue)) {
          log.add('Notes with an unreadable pitch were skipped', bar);
          return null;
        }
        const alter = Math.round(alterValue);
        if (alter !== alterValue) log.add('Microtonal alterations were rounded to semitones', bar);
        return toConcert(normalizeSpelling({ step, alter, octave }));
      };
      const accidental = xmlChild(el, 'accidental');
      const cautionary =
        !!accidental &&
        (accidental.attributes.cautionary === 'yes' ||
          accidental.attributes.parentheses === 'yes' ||
          accidental.attributes.editorial === 'yes');

      if (grace) {
        if (!pitchEl) {
          if (xmlChild(el, 'unpitched')) log.add('Unpitched (percussion) notes were skipped', bar);
          return;
        }
        const pitch = readPitch();
        if (!pitch) return;
        const note: RawNote = { pitch, tie: false, cautionary, tieForward: false };
        if (
          isChord &&
          lastGrace &&
          lastGrace.staff === staff &&
          lastGrace.voice === voice &&
          eq(lastGrace.offset, cursor)
        )
          lastGrace.notes.push(note);
        else {
          lastGrace = {
            part: partIndex,
            staff,
            voice,
            measure: mi,
            offset: cursor,
            order: ctx.order++,
            slash: grace.attributes.slash === 'yes',
            value: noteValueOf(xmlChildText(el, 'type')) ?? 'eighth',
            notes: [note],
            start: ZERO,
            principal: null,
          };
          out.graces.push(lastGrace);
        }
        readSlurs(notations, lastGrace);
        return;
      }
      lastGrace = null;

      const given = durationOf(el);
      const notated = restEl?.attributes.measure === 'yes' ? null : notatedLength(el);
      let duration = given ?? notated;
      if (!duration) {
        log.add('Notes without a duration were skipped', bar);
        return;
      }
      if (!given) log.add('Notes without a duration took it from their written value', bar);
      else if (notated && !eq(given, notated) && lt(abs(sub(given, notated)), toWhole(rat(1))))
        // durations the divisions cannot express exactly (e.g. triplets with 256 divisions per
        // quarter) are rounded by the exporter: use the written value
        duration = notated;
      // notes of a chord share a stem: the same written value means the same duration
      if (isChord && notated && chordHead.notated && eq(notated, chordHead.notated))
        duration = chordHead.duration;
      if (!isChord) chordHead = { notated, duration, staff, voice };
      const start = isChord ? lastStart : cursor;
      if (!isChord) {
        lastStart = cursor;
        fileCursor = add(fileCursor, given ?? duration);
        if (restEl?.attributes.measure === 'yes') cursor = add(cursor, duration);
        else advance(add(cursor, duration));
        chord = new Map();
        readTuplets(el, notations, staff, voice, start, duration);
      }

      if (restEl || !pitchEl) {
        if (!restEl) {
          facts.hasNotes = true;
          out.unpitched = true;
          log.add('Unpitched (percussion) notes were skipped', bar);
        }
        for (const n of notations) {
          if (xmlChild(n, 'fermata')) log.add('Fermatas on rests are not supported', bar);
          for (const d of xmlChildren(n, 'dynamics'))
            for (const x of xmlChildren(d)) addDynamic(x, staff, posAt(start));
        }
        return;
      }
      facts.hasNotes = true;
      if (el.attributes['print-object'] === 'no') {
        // hidden notes are playback aids in practice (e.g. written-out trills in a hidden voice)
        log.add('Invisible (playback-only) notes were skipped', bar);
        return;
      }
      const pitch = readPitch();
      if (!pitch) return;
      const note: RawNote = {
        pitch,
        tie: xmlChildren(el, 'tie').some((t) => t.attributes.type === 'start'),
        cautionary,
        tieForward: false,
      };
      const key = `${staff}|${voice}|${duration.n}/${duration.d}`;
      let ev = isChord ? chord.get(key) : undefined;
      if (ev) ev.notes.push(note);
      else {
        ev = {
          part: partIndex,
          staff,
          voice,
          measure: mi,
          offset: start,
          order: ctx.order++,
          length: duration,
          duration,
          start: ZERO,
          notes: [note],
          articulations: [],
          ornament: null,
          tremolo: 0,
          arpeggio: null,
          breath: null,
          cue: false,
          graces: [],
          mergedInto: null,
          slot: -1,
          dropped: false,
          id: '',
        };
        chord.set(key, ev);
        out.events.push(ev);
      }
      if (xmlChild(el, 'cue') || xmlChild(el, 'type')?.attributes.size === 'cue') ev.cue = true;
      const head = xmlChildText(el, 'notehead');
      if (head && head !== 'normal')
        log.add('Special noteheads (x, diamond, slash, …) are drawn as normal noteheads', bar);
      readMarks(notations, ev, note);
      readSlurs(notations, ev);
    };

    const onDirection = (el: XmlElement) => {
      const staff = staffOf(xmlChildText(el, 'staff'));
      const offsetEl = xmlChild(el, 'offset');
      let at = cursor;
      if (offsetEl?.attributes.sound === 'yes') {
        const d = decimal(xmlText(offsetEl));
        if (d) at = max(ZERO, add(cursor, toWhole(d)));
      }
      const pos = posAt(at);
      const words: string[] = [];
      let metronome: { bpm: number; beatUnit: Rational | null } | null = null;
      for (const type of xmlChildren(el, 'direction-type')) {
        for (const item of xmlChildren(type)) {
          switch (item.name) {
            case 'dynamics':
              for (const d of xmlChildren(item)) addDynamic(d, staff, pos);
              break;
            case 'wedge': {
              const number = item.attributes.number ?? '1';
              const type = item.attributes.type;
              if (type === 'crescendo' || type === 'diminuendo') {
                const open = openWedges.get(number);
                if (open)
                  out.lines.push({
                    kind: 'hairpin',
                    part: partIndex,
                    staff: open.staff,
                    start: open.start,
                    end: pos,
                    direction: open.direction,
                  });
                openWedges.set(number, { staff, start: pos, direction: type });
              } else if (type === 'stop') {
                const open = openWedges.get(number);
                openWedges.delete(number);
                if (open)
                  out.lines.push({
                    kind: 'hairpin',
                    part: partIndex,
                    staff: open.staff,
                    start: open.start,
                    end: pos,
                    direction: open.direction,
                  });
              }
              break;
            }
            case 'octave-shift': {
              const number = item.attributes.number ?? '1';
              const type = item.attributes.type;
              const size = intOf(item.attributes.size) ?? 8;
              if (type === 'up' || type === 'down') {
                const amount = size >= 15 ? 2 : 1;
                if (size > 15) log.add('Octave lines of three octaves are shown as two', bar);
                // "down": the notes are displayed lower than they sound (8va); "up" is 8vb
                openOttavas.set(number, {
                  staff,
                  start: pos,
                  octaves: type === 'down' ? amount : -amount,
                });
              } else if (type === 'stop') {
                const open = openOttavas.get(number);
                openOttavas.delete(number);
                if (open)
                  out.lines.push({
                    kind: 'ottava',
                    part: partIndex,
                    staff: open.staff,
                    start: open.start,
                    end: pos,
                    octaves: open.octaves,
                  });
              }
              break;
            }
            case 'pedal': {
              const type = item.attributes.type;
              const style = item.attributes.line === 'yes' ? ({ style: 'line' } as const) : {};
              const close = () => {
                if (openPedal)
                  out.lines.push({
                    kind: 'pedal',
                    part: partIndex,
                    staff: -1,
                    start: openPedal.start,
                    end: pos,
                    ...(openPedal.style ? { style: openPedal.style } : {}),
                  });
                openPedal = null;
              };
              if (type === 'start' || type === 'resume') {
                close();
                openPedal = { start: pos, ...style };
              } else if (type === 'change') {
                close();
                openPedal = { start: pos, ...style };
              } else if (type === 'stop' || type === 'discontinue') close();
              else if (type === 'sostenuto')
                log.add('Sostenuto pedal marks are not supported', bar);
              break;
            }
            case 'metronome': {
              const units = xmlChildren(item, 'beat-unit');
              const perMinute = numberOf(xmlChildText(item, 'per-minute'));
              if (units.length === 1 && perMinute && perMinute > 0) {
                const value = noteValueOf(xmlText(units[0]));
                const dots = xmlChildren(item, 'beat-unit-dot').length;
                metronome = {
                  bpm: perMinute,
                  beatUnit: value ? writtenLength({ value, dots: Math.min(dots, 2) }) : null,
                };
              } else log.add('Metronome marks other than "note = number" are not supported', bar);
              break;
            }
            case 'words': {
              const text = clean(xmlText(item));
              if (text) words.push(text);
              break;
            }
            case 'rehearsal': {
              const text = clean(xmlText(item));
              if (text && !facts.rehearsal) facts.rehearsal = text;
              break;
            }
            case 'segno':
            case 'coda':
              log.add('Segno and coda signs are not supported yet', bar);
              break;
            case 'dashes':
              if (item.attributes.type === 'start')
                log.add('Dashed text lines are not supported', bar);
              break;
            case 'bracket':
              if (item.attributes.type === 'start') log.add('Bracket lines are not supported', bar);
              break;
            default:
              log.add(`Direction "${item.name}" is not supported`, bar);
          }
        }
      }
      const sound = xmlChild(el, 'sound');
      const soundTempo = readSound(sound);
      const text = words.join(' ');
      const wordsTempo = text ? tempoFromWords(text) : null;
      const bpm = metronome?.bpm ?? soundTempo ?? wordsTempo;
      if (bpm !== null) {
        addTempo(pos, bpm, metronome?.beatUnit ?? null, text || null);
      } else if (words.length)
        log.add('Text directions (expression and technique text) were skipped', bar);
    };

    const readSound = (sound: XmlElement | undefined): number | null => {
      if (!sound) return null;
      const a = sound.attributes;
      if (a.dacapo || a.dalsegno || a.segno || a.coda || a.tocoda || a.fine)
        log.add('Repeat jumps (D.C., D.S., coda, fine) are not supported yet', bar);
      const tempo = numberOf(a.tempo);
      return tempo && tempo > 0 ? tempo : null;
    };

    const addTempo = (
      pos: Pos,
      bpm: number | null,
      beatUnit: Rational | null,
      text: string | null,
    ) => {
      const last = out.tempos[out.tempos.length - 1];
      if (last && last.pos.measure === pos.measure && eq(last.pos.offset, pos.offset)) {
        if (bpm !== null) {
          last.bpm = bpm;
          last.beatUnit = beatUnit;
        }
        last.text ??= text;
        return;
      }
      out.tempos.push({ pos, bpm, beatUnit, text });
    };

    const onHarmony = (el: XmlElement) => {
      const offset = decimal(xmlChildText(el, 'offset'));
      const at = offset ? max(ZERO, add(cursor, toWhole(offset))) : cursor;
      const root = xmlChild(el, 'root');
      if (!root) {
        log.add('Chord symbols without a root (functions, numerals) were skipped', bar);
        return;
      }
      const spelled = (stepText: string | undefined, alterText: string | undefined) => {
        const step = stepText?.trim().toUpperCase();
        if (!isStep(step)) return null;
        const p = toConcert({ step, alter: Math.round(Number(alterText ?? 0) || 0), octave: 4 });
        return { step: p.step, alter: p.alter };
      };
      const r = spelled(xmlChildText(root, 'root-step'), xmlChildText(root, 'root-alter'));
      if (!r) return;
      const kindEl = xmlChild(el, 'kind');
      const kind = xmlText(kindEl).trim() || 'major';
      if (kind === 'none') {
        log.add('"No chord" (N.C.) symbols were skipped', bar);
        return;
      }
      const mapped = chordKind(kind);
      if (!mapped) {
        log.add(`Chord kind "${kind}" is not supported; the chord symbol was skipped`, bar);
        return;
      }
      if (mapped.approx) log.add(`Chord kind "${kind}" was approximated`, bar);
      let quality = mapped.quality;
      const degrees = xmlChildren(el, 'degree').map((d) => {
        const type = xmlChildText(d, 'degree-type') ?? 'add';
        const value = intOf(xmlChildText(d, 'degree-value')) ?? 0;
        const alter = Math.round(Number(xmlChildText(d, 'degree-alter') ?? 0) || 0);
        return `${type} ${value} ${alter}`;
      });
      if (degrees.length) {
        const joined = degrees.join(' ');
        const rules = DEGREE_RULES[quality];
        const all = rules?.[joined];
        if (all) quality = all;
        else {
          let ok = true;
          for (const d of degrees) {
            const next = DEGREE_RULES[quality]?.[d];
            if (next) quality = next;
            else ok = false;
          }
          if (!ok)
            log.add('Chord symbol alterations without an equivalent quality were ignored', bar);
        }
      }
      const bassEl = xmlChild(el, 'bass');
      const bass = bassEl
        ? spelled(xmlChildText(bassEl, 'bass-step'), xmlChildText(bassEl, 'bass-alter'))
        : null;
      out.harmony.push({ pos: posAt(at), root: r, bass, quality });
    };

    const onBarline = (el: XmlElement) => {
      const location = el.attributes.location ?? 'right';
      const styleText = xmlChildText(el, 'bar-style');
      const style = styleText ? (BARLINES[styleText] ?? null) : null;
      const repeat = xmlChild(el, 'repeat')?.attributes.direction;
      const ending = xmlChild(el, 'ending');
      if (ending?.attributes.type === 'start')
        log.add('Volta brackets (1st/2nd endings) are not supported yet', bar);
      if (xmlChild(el, 'segno') || xmlChild(el, 'coda'))
        log.add('Segno and coda signs are not supported yet', bar);
      if (xmlChild(el, 'fermata')) log.add('Fermatas on barlines are not supported', bar);
      if (location === 'left') {
        if (repeat === 'forward') facts.repeatStart = true;
        else if (style && style !== 'single') facts.leftBarline = style;
      } else if (location === 'right') {
        if (repeat === 'backward') facts.repeatEnd = true;
        if (style) facts.barline = style;
      } else if (style && style !== 'single')
        log.add('Barlines inside a bar are not supported', bar);
    };

    for (const el of xmlChildren(measureEl)) {
      switch (el.name) {
        case 'attributes':
          onAttributes(el);
          break;
        case 'note':
          onNote(el);
          break;
        case 'backup': {
          const d = durationOf(el);
          if (d) {
            fileCursor = sub(fileCursor, d);
            if (lt(fileCursor, ZERO)) {
              fileCursor = ZERO;
              log.add('Backups before the start of the bar were clamped', bar);
            }
            cursor = fileCursor;
          }
          chord = new Map();
          lastGrace = null;
          break;
        }
        case 'forward': {
          const d = durationOf(el);
          if (d) {
            fileCursor = add(fileCursor, d);
            advance(fileCursor);
          }
          chord = new Map();
          lastGrace = null;
          break;
        }
        case 'direction':
          onDirection(el);
          break;
        case 'harmony':
          onHarmony(el);
          break;
        case 'figured-bass':
          log.add('Figured bass is not supported', bar);
          break;
        case 'sound': {
          const bpm = readSound(el);
          if (bpm !== null) addTempo(posAt(cursor), bpm, null, null);
          break;
        }
        case 'barline':
          onBarline(el);
          break;
        default:
          break; // print, grouping, link, bookmark, listening: layout or non-musical data
      }
    }
    for (const [key, g] of [...implicitTuplets]) {
      if (g.measure === mi) {
        const [staff, voice] = key.split('|') as [string, string];
        closeImplicit(key, Number(staff), voice);
      }
    }
  });
  if (openWedges.size) log.add('Hairpins without an end were dropped', null, openWedges.size);
  if (openOttavas.size) log.add('Octave lines without an end were dropped', null, openOttavas.size);
  if (openPedal) log.add('Pedal marks without an end were dropped');
  if (openSlurs.size) log.add('Slurs with only one end were dropped', null, openSlurs.size);
  for (const ev of openTrills.values()) ev.ornament ??= 'trill';
  if (openTrills.size)
    log.add('Trill lines without an end are shown as a "tr" sign', null, openTrills.size);
  if (openTuplets.size) log.add('Tuplets without an end were dropped', null, openTuplets.size);
  return out;
}

// ------------------------------------------------------------------------------- the import

/** Import a MusicXML document (the text of a `.musicxml` / `.xml` file). */
export function importMusicXml(xml: string, options: MusicXmlImportOptions): MusicXmlImportResult {
  const log = new WarningLog();
  const ids = options.ids;
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (e) {
    if (e instanceof XmlError) throw new MusicXmlError(`not a well-formed XML file: ${e.message}`);
    throw e;
  }
  if (root.name === 'score-timewise') root = timewiseToPartwise(root);
  else if (root.name === 'opus')
    throw new MusicXmlError('MusicXML opus files (collections of scores) are not supported');
  else if (root.name !== 'score-partwise')
    throw new MusicXmlError(`not a MusicXML score (the root element is <${root.name}>)`);

  const settings = readSettings(root);
  const ctx: ParseContext = { log, concertScore: settings.concertPitch, order: 0 };
  const list = readPartList(root);
  const bodies = new Map(xmlChildren(root, 'part').map((p) => [p.attributes.id ?? '', p]));
  const partInfos = [...list.parts];
  for (const id of bodies.keys())
    if (!partInfos.some((p) => p.id === id)) {
      partInfos.push({
        id,
        name: '',
        abbreviation: '',
        instrumentNames: [],
        sounds: [],
        program: null,
        percussionChannel: false,
      });
      log.add('Parts missing from the part list were added at the end');
    }
  if (!partInfos.length) throw new MusicXmlError('the score has no parts');
  const parsed = partInfos.map((info, i) => {
    const body = bodies.get(info.id);
    if (!body) log.add('Parts without music were imported empty');
    return parsePart(body ?? { name: 'part', attributes: {}, children: [] }, i, ctx);
  });

  // -------------------------------------------------------------- bars
  const measureCount = Math.max(1, ...parsed.map((p) => p.measures.length));
  if (parsed.some((p) => p.measures.length !== measureCount && p.measures.length > 0))
    log.add('Parts have different numbers of bars; the shorter ones end with empty bars');
  const contentEnd: Rational[] = [];
  for (let m = 0; m < measureCount; m++) {
    let withNotes: Rational | null = null;
    let any = ZERO;
    for (const p of parsed) {
      const f = p.measures[m];
      if (!f) continue;
      any = max(any, f.end);
      if (f.hasNotes) withNotes = withNotes ? max(withNotes, f.end) : f.end;
    }
    contentEnd.push(withNotes ?? any);
  }
  /** Key and time changes written at the end of a bar belong to the next bar. */
  const changeBar = (pos: Pos, what: string): number => {
    const end = contentEnd[pos.measure]!;
    if (pos.offset.n === 0) return pos.measure;
    if (isPositive(end) && le(end, pos.offset)) return Math.min(pos.measure + 1, measureCount - 1);
    log.add(`${what} changes inside a bar were moved to the start of the bar`, pos.measure + 1);
    return pos.measure;
  };
  const timeAt = new Map<number, TimeSignature>();
  parsed.forEach((p) => {
    for (const t of p.times) {
      const m = changeBar(t.pos, 'Time signature');
      const existing = timeAt.get(m);
      if (!existing) timeAt.set(m, t.time);
      else if (existing.beats !== t.time.beats || existing.beatType !== t.time.beatType)
        log.add('Parts disagree on the time signature; the first part wins', m + 1);
    }
  });
  if (!timeAt.has(0)) {
    if (parsed.some((p) => p.times.length)) timeAt.set(0, [...timeAt.values()][0]!);
    else log.add('The score has no time signature; 4/4 is used');
  }
  const lengths: Rational[] = [];
  const nominals: Rational[] = [];
  {
    let ts: TimeSignature = timeAt.get(0) ?? { beats: 4, beatType: 4 };
    for (let m = 0; m < measureCount; m++) {
      ts = timeAt.get(m) ?? ts;
      const nominal = barLength(ts);
      const content = contentEnd[m]!;
      lengths.push(isPositive(content) ? content : nominal);
      nominals.push(nominal);
    }
  }
  const starts: Rational[] = [];
  let total = ZERO;
  for (const l of lengths) {
    starts.push(total);
    total = add(total, l);
  }
  const scoreEnd = total;
  for (let m = 1; m + 1 < measureCount; m++) {
    if (eq(lengths[m]!, nominals[m]!) || parsed.some((p) => p.measures[m]?.implicit)) continue;
    // a bar split in two (e.g. at a repeat sign inside the bar) is fine
    const split = (a: number, b: number) =>
      eq(nominals[a]!, nominals[b]!) && eq(add(lengths[a]!, lengths[b]!), nominals[a]!);
    if (split(m - 1, m) || split(m, m + 1)) continue;
    log.add('Bars whose content does not match the time signature keep their actual length', m + 1);
  }
  /** Bar index containing t (a time at a barline belongs to the next bar), or -1 past the end. */
  const barAt = (t: Rational): number => {
    let lo = 0;
    let hi = measureCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lt(t, starts[mid]!)) hi = mid - 1;
      else if (!lt(t, add(starts[mid]!, lengths[mid]!))) lo = mid + 1;
      else return mid;
    }
    return -1;
  };
  /** Bar index whose span ends at or after t (for end positions). */
  const barEndingAt = (t: Rational): number => {
    const b = barAt(t);
    let m = b < 0 ? measureCount - 1 : b;
    while (m > 0 && !lt(starts[m]!, t)) m--;
    return m;
  };
  const absolute = (pos: Pos): Rational =>
    add(starts[pos.measure]!, min(max(pos.offset, ZERO), lengths[pos.measure]!));

  // -------------------------------------------------------------- keys
  const keyAt = new Map<number, KeySignature>();
  {
    const candidates = new Map<
      number,
      { key: KeySignature; transposing: boolean; percussion: boolean }[]
    >();
    parsed.forEach((p) => {
      const percussion = p.percussionClef || p.unpitched;
      for (const k of p.keys) {
        const m = changeBar(k.pos, 'Key signature');
        const list = candidates.get(m) ?? candidates.set(m, []).get(m)!;
        list.push({ key: k.key, transposing: k.transposing, percussion });
      }
    });
    for (const [m, list] of candidates) {
      // the key most non-transposing pitched parts agree on (transposed keys can be respelled)
      const pitched = list.filter((c) => !c.percussion);
      const concert = pitched.filter((c) => !c.transposing);
      const pool = concert.length ? concert : pitched.length ? pitched : list;
      const votes = new Map<number, number>();
      for (const c of pool) votes.set(c.key.fifths, (votes.get(c.key.fifths) ?? 0) + 1);
      const best = Math.max(...votes.values());
      const chosen = pool.find((c) => votes.get(c.key.fifths) === best)!;
      keyAt.set(m, chosen.key);
      if (pool.some((c) => c.key.fifths !== chosen.key.fifths))
        log.add('Parts disagree on the (concert) key signature; the majority key is used', m + 1);
    }
  }

  // -------------------------------------------------------------- parts, staves, groups
  const identities: PartIdentity[] = partInfos.map((info, i) => {
    const p = parsed[i]!;
    return {
      names: [info.name, ...info.instrumentNames, info.abbreviation].filter(Boolean),
      sounds: info.sounds,
      program: info.program,
      percussion: info.percussionChannel || p.percussionClef || p.unpitched,
      staves: p.staves,
      clefs: Array.from({ length: p.staves }, (_, s) => p.firstClefs[s] ?? 'treble'),
      hasLyrics: p.hasLyrics,
    };
  });
  const guesses = guessInstruments(identities);
  const lang = options.lang ?? 'en';
  const staffOffset: number[] = [];
  const staffIds: ID[] = [];
  const parts: Part[] = partInfos.map((info, i) => {
    const p = parsed[i]!;
    const guess = guesses[i]!;
    const def: InstrumentDef = findInstrument(guess.instrument) ?? getInstrument('piano');
    if (guess.by === 'fallback')
      log.add(`Part "${info.name || info.id}": instrument not recognized, using ${def.name.en}`);
    staffOffset.push(staffIds.length);
    const staves = Array.from({ length: p.staves }, (_, s) => {
      const id = ids.next('st');
      staffIds.push(id);
      const clef =
        p.firstClefs[s] ?? def.staves[s] ?? def.staves[def.staves.length - 1] ?? 'treble';
      return { id, clef, lines: p.staffLines[s] ?? 5 };
    });
    // <transpose> describes the instrument; without one the notes are concert pitch and the
    // catalog transposition (if any) is used for written-pitch display.
    const catalog = def.transposition ?? interval(0, 0);
    const own = p.transposition;
    const transposition =
      own && (own.diatonic !== catalog.diatonic || own.chromatic !== catalog.chromatic)
        ? own
        : null;
    const name = info.name && !isGenericName(info.name) ? info.name : def.name[lang];
    const abbreviation =
      info.abbreviation && !isGenericName(info.abbreviation)
        ? info.abbreviation
        : def.abbreviation[lang];
    return {
      id: ids.next('pt'),
      instrument: def.id,
      name,
      abbreviation,
      staves,
      ...(transposition ? { transposition } : {}),
      ...(guess.by === 'fallback' && info.program !== null && info.program !== def.gmProgram
        ? { midiProgram: info.program }
        : {}),
    };
  });
  const groups: StaffGroup[] = [];
  parts.forEach((part, i) => {
    const symbol = parsed[i]!.partSymbol;
    if (part.staves.length > 1 && symbol !== 'none') {
      groups.push({
        id: ids.next('gr'),
        kind: symbol ?? 'brace',
        firstStaff: part.staves[0]!.id,
        lastStaff: part.staves[part.staves.length - 1]!.id,
        barlineThrough: true,
      });
    }
  });
  for (const g of list.groups) {
    const kind: StaffGroup['kind'] | null =
      g.symbol === 'brace'
        ? 'brace'
        : g.symbol === 'bracket'
          ? 'bracket'
          : g.symbol === 'square'
            ? 'square'
            : g.symbol === 'line'
              ? 'bracket'
              : null;
    if (g.symbol === 'line') log.add('Line-style part groups are shown as brackets');
    const first = parts[g.first]?.staves[0];
    const lastPart = parts[g.last];
    const last = lastPart?.staves[lastPart.staves.length - 1];
    if (!first || !last) continue;
    if (!kind) {
      if (g.barline) {
        // no symbol, but barlines through the group: keep that as a group without a bracket? The
        // model always draws the bracket, so only the barlines are lost.
        log.add('Part groups without a bracket symbol were dropped');
      }
      continue;
    }
    // a brace around exactly one multi-staff part already exists
    if (groups.some((x) => x.firstStaff === first.id && x.lastStaff === last.id && x.kind === kind))
      continue;
    groups.push({
      id: ids.next('gr'),
      kind,
      firstStaff: first.id,
      lastStaff: last.id,
      barlineThrough: g.barline,
      ...(g.name ? { name: g.name } : {}),
    });
  }
  const order = new Map(staffIds.map((id, i) => [id, i]));
  groups.sort(
    (a, b) =>
      order.get(a.firstStaff)! - order.get(b.firstStaff)! ||
      order.get(b.lastStaff)! - order.get(a.lastStaff)!,
  );
  const globalStaff = (part: number, staff: number) => staffOffset[part]! + staff;

  // -------------------------------------------------------------- events: time, graces, ties
  const source: Provenance = {
    kind: 'import',
    format: 'musicxml',
    ...(options.fileName ? { file: options.fileName } : {}),
  };
  const allEvents: RawEvent[] = parsed.flatMap((p) => p.events);
  for (const e of allEvents) {
    e.start = add(starts[e.measure]!, e.offset);
    if (lt(scoreEnd, add(e.start, e.duration))) {
      e.duration = sub(scoreEnd, e.start);
      log.add('Notes running past the end of the score were shortened', e.measure + 1);
    }
  }
  const voiceKey = (e: { part: number; staff: number; voice: string }) =>
    `${e.part}|${e.staff}|${e.voice}`;
  const byVoice = new Map<string, RawEvent[]>();
  for (const e of allEvents) {
    const list = byVoice.get(voiceKey(e)) ?? byVoice.set(voiceKey(e), []).get(voiceKey(e))!;
    list.push(e);
  }
  for (const list of byVoice.values()) list.sort((a, b) => a.order - b.order);
  // grace notes lead into the next note of their voice
  for (const g of parsed.flatMap((p) => p.graces)) {
    g.start = add(starts[g.measure]!, min(g.offset, lengths[g.measure]!));
    const list = byVoice.get(voiceKey(g)) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.order < g.order) lo = mid + 1;
      else hi = mid;
    }
    const next = list[lo];
    if (next && eq(next.start, g.start)) {
      g.principal = next;
      next.graces.push(g);
    } else log.add('Grace notes not followed by a note of their voice were skipped', g.measure + 1);
  }
  for (const list of byVoice.values())
    list.sort((a, b) => cmp(a.start, b.start) || a.order - b.order);
  const sameNotes = (a: RawEvent, b: RawEvent) =>
    a.notes.length === b.notes.length &&
    a.notes.every((n) => b.notes.some((m) => pitchEquals(m.pitch, n.pitch))) &&
    b.notes.every((n) => a.notes.some((m) => pitchEquals(m.pitch, n.pitch)));
  for (const list of byVoice.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      if (a.mergedInto) continue;
      let j = i + 1;
      // merge whole tied chords into one event (one sounding note = one event)
      while (a.notes.every((n) => n.tie)) {
        const end = add(a.start, a.duration);
        while (j < list.length && lt(list[j]!.start, end)) j++;
        let b: RawEvent | undefined;
        for (let k = j; k < list.length && eq(list[k]!.start, end); k++) {
          const c = list[k]!;
          if (!c.mergedInto && sameNotes(a, c) && !c.graces.length && c.cue === a.cue) {
            b = c;
            break;
          }
        }
        if (!b) break;
        b.mergedInto = a;
        a.duration = add(a.duration, b.duration);
        a.notes = a.notes.map((n) => ({
          ...n,
          tie: b.notes.find((m) => pitchEquals(m.pitch, n.pitch))!.tie,
        }));
        for (const art of b.articulations)
          if (!a.articulations.includes(art)) a.articulations.push(art);
        a.breath = b.breath ?? a.breath;
        a.ornament ??= b.ornament;
        if (!a.tremolo) a.tremolo = b.tremolo;
      }
      // remaining ties connect to the same pitch in the next event of the voice
      if (a.notes.some((n) => n.tie)) {
        const end = add(a.start, a.duration);
        const followers = list.filter((x) => !x.mergedInto && eq(x.start, end));
        for (const n of a.notes) {
          if (!n.tie) continue;
          if (followers.some((x) => x.notes.some((m) => midiOf(m.pitch) === midiOf(n.pitch))))
            n.tieForward = true;
          else
            log.add('Ties without a following note of the same pitch were dropped', a.measure + 1);
        }
      }
    }
  }
  const live = allEvents.filter((e) => !e.mergedInto);
  const resolve = (x: Endpoint | null): RawEvent | null => {
    let e: RawEvent | null = x && 'graces' in x ? x : (x?.principal ?? null);
    while (e?.mergedInto) e = e.mergedInto;
    return e;
  };

  // -------------------------------------------------------------- voices
  const barsOf = (e: RawEvent): number[] => {
    const last = barEndingAt(add(e.start, e.duration));
    const out: number[] = [];
    for (let m = e.measure; m <= Math.max(e.measure, last); m++) out.push(m);
    return out;
  };
  // home staff of each MusicXML voice: where most of its notes are
  const homeStaff = new Map<string, number>();
  {
    const counts = new Map<string, Map<number, number>>();
    for (const e of live) {
      const k = `${e.part}|${e.voice}`;
      const c = counts.get(k) ?? counts.set(k, new Map()).get(k)!;
      c.set(e.staff, (c.get(e.staff) ?? 0) + e.notes.length);
    }
    for (const [k, c] of counts) {
      let best = -1;
      let bestCount = -1;
      for (const [s, n] of [...c].sort((a, b) => a[0] - b[0]))
        if (n > bestCount) {
          best = s;
          bestCount = n;
        }
      homeStaff.set(k, best);
    }
  }
  const byStaff = new Map<number, RawEvent[]>();
  for (const e of live) {
    const s = globalStaff(e.part, e.staff);
    const list = byStaff.get(s) ?? byStaff.set(s, []).get(s)!;
    list.push(e);
  }
  const slotOf = new Map<string, number>(); // voiceKey -> preferred slot
  let crossStaff = 0;
  for (const events of byStaff.values()) {
    const voices = new Map<string, { first: number; home: boolean; bars: Set<number> }>();
    for (const e of events) {
      const k = voiceKey(e);
      let v = voices.get(k);
      if (!v) {
        v = {
          first: e.order,
          home: homeStaff.get(`${e.part}|${e.voice}`) === e.staff,
          bars: new Set(),
        };
        voices.set(k, v);
      }
      v.first = Math.min(v.first, e.order);
      for (const m of barsOf(e)) v.bars.add(m);
      if (!v.home) crossStaff++;
    }
    const ordered = [...voices].sort(
      (a, b) => Number(b[1].home) - Number(a[1].home) || a[1].first - b[1].first,
    );
    const slots: Set<number>[] = Array.from({ length: VOICES_PER_STAFF }, () => new Set());
    for (const [k, v] of ordered) {
      const free = slots.findIndex((bars) => ![...v.bars].some((m) => bars.has(m)));
      if (free >= 0) {
        for (const m of v.bars) slots[free]!.add(m);
        slotOf.set(k, free);
      }
    }
  }
  if (crossStaff)
    log.add('Cross-staff notes were placed on their staff with their own stems', null, crossStaff);
  // place events: preferred slot, else a free one; overlaps shorten the earlier note
  for (const events of byStaff.values()) {
    events.sort(
      (a, b) =>
        cmp(a.start, b.start) ||
        (slotOf.get(voiceKey(a)) ?? 9) - (slotOf.get(voiceKey(b)) ?? 9) ||
        a.order - b.order,
    );
    const lastIn: (RawEvent | null)[] = Array.from({ length: VOICES_PER_STAFF }, () => null);
    const endOf = (e: RawEvent | null) => (e ? add(e.start, e.duration) : ZERO);
    const free = (slot: number, t: Rational) => le(endOf(lastIn[slot] ?? null), t);
    const place = (e: RawEvent, slot: number) => {
      e.slot = slot;
      lastIn[slot] = e;
    };
    for (const e of events) {
      const preferred = slotOf.get(voiceKey(e)) ?? -1;
      if (preferred >= 0 && free(preferred, e.start)) {
        place(e, preferred);
        continue;
      }
      const occupant = preferred >= 0 ? (lastIn[preferred] ?? null) : null;
      if (occupant && voiceKey(occupant) === voiceKey(e) && lt(occupant.start, e.start)) {
        occupant.duration = sub(e.start, occupant.start);
        for (const n of occupant.notes) n.tieForward = false;
        log.add('Overlapping notes in a voice were shortened', e.measure + 1);
        place(e, preferred);
        continue;
      }
      const other = [0, 1, 2, 3].find((s) => free(s, e.start));
      if (other !== undefined) {
        place(e, other);
        log.add(
          preferred >= 0
            ? 'Overlapping notes were moved to another voice'
            : 'Staves with more than four voices: extra voices share free voices',
          e.measure + 1,
        );
        continue;
      }
      const occupants = lastIn.filter((x): x is RawEvent => x !== null);
      const victim = occupants
        .filter((x) => lt(x.start, e.start))
        .sort((a, b) => cmp(b.start, a.start))[0];
      if (victim) {
        victim.duration = sub(e.start, victim.start);
        for (const n of victim.notes) n.tieForward = false;
        place(e, victim.slot);
        log.add('Overlapping notes in a voice were shortened', e.measure + 1);
        continue;
      }
      const twin = occupants.find((x) => eq(x.start, e.start) && eq(x.duration, e.duration));
      if (twin) {
        for (const n of e.notes)
          if (!twin.notes.some((m) => pitchEquals(m.pitch, n.pitch))) twin.notes.push(n);
        e.dropped = true;
        e.mergedInto = twin;
        log.add(
          'More than four simultaneous voices: notes were merged into a chord',
          e.measure + 1,
        );
        continue;
      }
      e.dropped = true;
      log.add('More than four simultaneous voices: notes were dropped', e.measure + 1);
    }
  }
  const placed = live.filter((e) => !e.dropped);

  // -------------------------------------------------------------- content
  const measureIds: ID[] = Array.from({ length: measureCount }, () => ids.next('m'));
  type DraftMeasure = {
    voices: NoteEvent[][];
    tuplets: TupletSpan[];
    clefChanges: ClefChange[];
    dynamics: DynamicMark[];
  };
  const drafts = new Map<string, DraftMeasure>();
  const draft = (staff: number, m: number): DraftMeasure => {
    const k = `${staff}|${m}`;
    let d = drafts.get(k);
    if (!d) {
      d = { voices: [], tuplets: [], clefChanges: [], dynamics: [] };
      drafts.set(k, d);
    }
    return d;
  };
  let duplicates = 0;
  const notesOf = (raw: readonly RawNote[]): Note[] => {
    const unique: RawNote[] = [];
    for (const n of raw) {
      if (unique.some((u) => pitchEquals(u.pitch, n.pitch))) duplicates++;
      else unique.push(n);
    }
    return unique
      .sort((a, b) => comparePitch(a.pitch, b.pitch))
      .map((n) => ({
        id: ids.next('n'),
        pitch: n.pitch,
        ...(n.tieForward ? { tieForward: true } : {}),
        ...(n.cautionary ? { accidental: 'cautionary' as const } : {}),
      }));
  };
  // trill lines replace the "tr" sign on their first note
  const trillStarts = new Set(parsed.flatMap((p) => p.trills.map((t) => resolve(t.from))));
  placed.sort(
    (a, b) =>
      globalStaff(a.part, a.staff) - globalStaff(b.part, b.staff) ||
      a.measure - b.measure ||
      a.slot - b.slot ||
      cmp(a.offset, b.offset),
  );
  for (const e of placed) {
    e.id = ids.next('e');
    const notes = notesOf(e.notes);
    const graces: GraceNote[] = e.graces.map((g) => ({
      id: ids.next('gc'),
      ...(g.slash ? { slash: true } : {}),
      value: g.value,
      notes: notesOf(g.notes),
    }));
    const articulations = [...e.articulations].sort(
      (a, b) => ARTICULATIONS.indexOf(a) - ARTICULATIONS.indexOf(b),
    );
    const ornament = e.ornament === 'trill' && trillStarts.has(e) ? null : e.ornament;
    const event: NoteEvent = {
      id: e.id,
      kind: 'note',
      offset: e.offset,
      duration: e.duration,
      notes,
      ...(articulations.length ? { articulations } : {}),
      ...(ornament ? { ornament } : {}),
      ...(e.tremolo ? { tremolo: e.tremolo } : {}),
      ...(e.arpeggio ? { arpeggio: e.arpeggio } : {}),
      ...(e.cue ? { cue: true } : {}),
      ...(graces.length ? { graces } : {}),
      ...(e.breath ? { breath: e.breath } : {}),
      source,
    };
    const d = draft(globalStaff(e.part, e.staff), e.measure);
    while (d.voices.length <= e.slot) d.voices.push([]);
    d.voices[e.slot]!.push(event);
  }
  if (duplicates) log.add('Duplicate notes in a chord were merged', null, duplicates);

  // tuplets go to the voice that holds their notes
  {
    const eventsOfVoice = new Map<string, RawEvent[]>();
    for (const e of placed) {
      const k = voiceKey(e);
      (eventsOfVoice.get(k) ?? eventsOfVoice.set(k, []).get(k)!).push(e);
    }
    for (const t of parsed.flatMap((p) => p.tuplets)) {
      const staff = globalStaff(t.part, t.staff);
      const tStart = add(starts[t.measure]!, t.offset);
      const tEnd = add(tStart, t.length);
      if (lt(lengths[t.measure]!, add(t.offset, t.length))) {
        log.add('Tuplets that cross a barline are written without a bracket', t.measure + 1);
        continue;
      }
      const inside = (eventsOfVoice.get(voiceKey(t)) ?? []).find(
        (e) => le(tStart, e.start) && lt(e.start, tEnd),
      );
      const slot = inside?.slot ?? slotOf.get(voiceKey(t));
      if (slot === undefined) continue; // only rests: the bracket is lost with them
      const d = draft(staff, t.measure);
      if (
        d.tuplets.some(
          (x) =>
            x.voice === slot &&
            lt(x.offset, add(t.offset, t.length)) &&
            lt(t.offset, add(x.offset, x.length)),
        )
      ) {
        log.add('Overlapping tuplets in a voice keep only the first bracket', t.measure + 1);
        continue;
      }
      d.tuplets.push({
        id: ids.next('tu'),
        voice: slot,
        offset: t.offset,
        length: t.length,
        actual: t.actual,
        normal: t.normal,
      });
    }
  }

  // clefs: the first one is the staff's clef, later ones are changes
  parsed.forEach((p, i) => {
    const changes = p.clefs
      .map((c) => ({ ...c, t: absolute(c.pos) }))
      .sort((a, b) => a.staff - b.staff || cmp(a.t, b.t));
    const current = parts[i]!.staves.map((s) => s.clef);
    for (const c of changes) {
      const m = barAt(c.t);
      if (m < 0 || current[c.staff] === c.clef) continue;
      current[c.staff] = c.clef;
      const d = draft(globalStaff(i, c.staff), m);
      const offset = sub(c.t, starts[m]!);
      d.clefChanges = d.clefChanges.filter((x) => !eq(x.offset, offset));
      d.clefChanges.push({ id: ids.next('cl'), offset, clef: c.clef });
    }
  });

  // dynamics
  parsed.forEach((p, i) => {
    for (const dyn of p.dynamics) {
      const t = absolute(dyn.pos);
      const m = barAt(t);
      if (m < 0) {
        log.add('Dynamics after the last note were dropped');
        continue;
      }
      const d = draft(globalStaff(i, Math.min(dyn.staff, p.staves - 1)), m);
      const offset = sub(t, starts[m]!);
      if (d.dynamics.some((x) => eq(x.offset, offset))) continue;
      d.dynamics.push({ id: ids.next('dy'), offset, value: dyn.value, source });
    }
  });

  const content: Record<ID, Record<ID, StaffMeasure>> = {};
  staffIds.forEach((staffId, s) => {
    const bars: Record<ID, StaffMeasure> = {};
    for (let m = 0; m < measureCount; m++) {
      const d = drafts.get(`${s}|${m}`);
      if (!d) continue;
      const voices = d.voices.map((v) => v.sort((a, b) => cmp(a.offset, b.offset)));
      while (voices.length && voices[voices.length - 1]!.length === 0) voices.pop();
      const sm: StaffMeasure = {
        voices,
        ...(d.tuplets.length
          ? { tuplets: d.tuplets.sort((a, b) => a.voice - b.voice || cmp(a.offset, b.offset)) }
          : {}),
        ...(d.clefChanges.length
          ? { clefChanges: d.clefChanges.sort((a, b) => cmp(a.offset, b.offset)) }
          : {}),
        ...(d.dynamics.length
          ? { dynamics: d.dynamics.sort((a, b) => cmp(a.offset, b.offset)) }
          : {}),
      };
      if (sm.voices.length || sm.tuplets || sm.clefChanges || sm.dynamics)
        bars[measureIds[m]!] = sm;
    }
    content[staffId] = bars;
  });

  // -------------------------------------------------------------- measures
  const tempoByBar = new Map<number, TempoMark[]>();
  {
    const seen = new Set<string>();
    for (const p of parsed)
      for (const tm of p.tempos) {
        if (tm.bpm === null) continue;
        const t = absolute(tm.pos);
        const m = barAt(t);
        if (m < 0) continue;
        const offset = sub(t, starts[m]!);
        const key = `${m}|${offset.n}/${offset.d}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const beatUnit = tm.beatUnit && !eq(tm.beatUnit, rat(1, 4)) ? tm.beatUnit : null;
        const list = tempoByBar.get(m) ?? tempoByBar.set(m, []).get(m)!;
        list.push({
          id: '',
          offset,
          bpm: Math.round(tm.bpm * 100) / 100,
          ...(beatUnit ? { beatUnit } : {}),
          ...(tm.text ? { text: tm.text } : {}),
        });
      }
  }
  const measures: Measure[] = [];
  let lastTime: TimeSignature | null = null;
  let lastKey: KeySignature | null = null;
  for (let m = 0; m < measureCount; m++) {
    const facts = parsed.map((p) => p.measures[m]).filter((f): f is MeasureFacts => !!f);
    const time = timeAt.get(m);
    let timeSig: TimeSignature | undefined;
    if (m === 0) timeSig = time ?? { beats: 4, beatType: 4 };
    else if (
      time &&
      lastTime &&
      (time.beats !== lastTime.beats ||
        time.beatType !== lastTime.beatType ||
        time.symbol !== lastTime.symbol ||
        (time.groups ?? []).join() !== (lastTime.groups ?? []).join())
    )
      timeSig = time;
    if (timeSig) lastTime = timeSig;
    const key = keyAt.get(m);
    let keySig: KeySignature | undefined;
    if (m === 0) keySig = key ?? { fifths: 0 };
    else if (key && lastKey && (key.fifths !== lastKey.fifths || key.mode !== lastKey.mode))
      keySig = key;
    if (keySig) lastKey = keySig;
    const right = facts.map((f) => f.barline).find((b) => b !== null) ?? null;
    const nextLeft =
      parsed.map((p) => p.measures[m + 1]?.leftBarline ?? null).find((b) => b !== null) ?? null;
    const repeatEnd = facts.some((f) => f.repeatEnd);
    let barline = right && right !== 'single' ? right : nextLeft;
    if (repeatEnd && barline === 'final') barline = null; // the repeat sign draws it
    const tempo = (tempoByBar.get(m) ?? [])
      .sort((a, b) => cmp(a.offset, b.offset))
      .map((t) => ({ ...t, id: ids.next('tm') }));
    const rehearsal = facts.map((f) => f.rehearsal).find((r) => r !== null) ?? null;
    measures.push({
      id: measureIds[m]!,
      ...(timeSig ? { timeSig } : {}),
      ...(keySig ? { keySig } : {}),
      ...(!eq(lengths[m]!, nominals[m]!) ? { actualLength: lengths[m]! } : {}),
      ...(barline && barline !== 'single' ? { barline } : {}),
      ...(facts.some((f) => f.repeatStart) ? { repeatStart: true } : {}),
      ...(repeatEnd ? { repeatEnd: true } : {}),
      ...(rehearsal ? { rehearsalMark: rehearsal } : {}),
      ...(tempo.length ? { tempo } : {}),
    });
  }

  // -------------------------------------------------------------- harmony
  const harmony: ChordSymbol[] = [];
  {
    const seen = new Set<string>();
    const all = parsed
      .flatMap((p) => p.harmony)
      .map((h) => ({ ...h, t: absolute(h.pos) }))
      .sort((a, b) => cmp(a.t, b.t));
    for (const h of all) {
      const m = barAt(h.t);
      if (m < 0) {
        log.add('Chord symbols after the last note were dropped');
        continue;
      }
      const offset = sub(h.t, starts[m]!);
      const key = `${m}|${offset.n}/${offset.d}`;
      if (seen.has(key)) continue;
      seen.add(key);
      harmony.push({
        id: ids.next('ch'),
        measureId: measureIds[m]!,
        offset,
        root: h.root,
        quality: h.quality,
        ...(h.bass && (h.bass.step !== h.root.step || h.bass.alter !== h.root.alter)
          ? { bass: h.bass }
          : {}),
        source,
      });
    }
  }

  // -------------------------------------------------------------- spanners
  const spanners: Spanner[] = [];
  const startAnchor = (t: Rational): MeasureAnchor => {
    const m = barAt(t);
    return { measureId: measureIds[m]!, offset: sub(t, starts[m]!) };
  };
  const endAnchor = (t: Rational): MeasureAnchor => {
    const m = barEndingAt(t);
    return { measureId: measureIds[m]!, offset: sub(t, starts[m]!) };
  };
  for (const p of parsed)
    for (const s of p.slurs) {
      let from = resolve(s.from);
      let to = resolve(s.to);
      if (!from || !to || from.dropped || to.dropped) {
        log.add('Slurs on notes that were not imported were dropped');
        continue;
      }
      if (from === to) {
        log.add('Slurs that begin and end on the same (tied) note were dropped');
        continue;
      }
      if (lt(to.start, from.start)) [from, to] = [to, from];
      if (
        from.part !== to.part ||
        from.staff !== to.staff ||
        from.slot !== to.slot ||
        eq(from.start, to.start)
      ) {
        log.add('Slurs between staves or voices are not supported yet', from.measure + 1);
        continue;
      }
      spanners.push({
        id: ids.next('sp'),
        kind: 'slur',
        staffId: staffIds[globalStaff(from.part, from.staff)]!,
        from: from.id,
        to: to.id,
        ...(s.placement ? { placement: s.placement } : {}),
        source,
      });
    }
  /** Events of a staff starting at t: their longest end (lines on a single note). */
  const noteEndAt = (staff: number, t: Rational): Rational | null => {
    let best: Rational | null = null;
    for (const e of byStaff.get(staff) ?? [])
      if (!e.dropped && eq(e.start, t))
        best = best ? max(best, add(e.start, e.duration)) : add(e.start, e.duration);
    return best;
  };
  const ottavas: { staff: number; start: Rational; end: Rational }[] = [];
  const lineKeys = new Set<string>();
  for (const p of parsed) {
    const lines = p.lines.map((l) => ({ ...l, s: absolute(l.start), e: absolute(l.end) }));
    for (const l of lines) {
      const partIndex = l.part;
      const staves = parts[partIndex]!.staves.length;
      const staff = globalStaff(
        partIndex,
        l.staff < 0 ? staves - 1 : Math.min(l.staff, staves - 1),
      );
      let start = l.s;
      let end = l.e;
      if (!lt(start, end)) {
        if (!lt(l.start.offset, lengths[l.start.measure]!) && l.start.offset.n > 0) {
          // written after the last note of a bar (bar-attached marks): the line covers that bar
          start = starts[l.start.measure]!;
          end = l.s;
        } else end = noteEndAt(staff, start) ?? start;
      }
      end = min(end, scoreEnd);
      if (!lt(start, end) || !lt(start, scoreEnd)) {
        log.add('Lines of zero length were dropped', barAt(start) + 1);
        continue;
      }
      const key = `${l.kind}|${staff}|${start.n}/${start.d}|${end.n}/${end.d}|${l.direction ?? l.octaves ?? ''}`;
      if (lineKeys.has(key)) continue;
      lineKeys.add(key);
      if (l.kind === 'ottava') {
        if (ottavas.some((o) => o.staff === staff && lt(o.start, end) && lt(start, o.end))) {
          log.add('Overlapping octave lines keep only the first', barAt(start) + 1);
          continue;
        }
        ottavas.push({ staff, start, end });
      }
      const base = {
        id: ids.next('sp'),
        staffId: staffIds[staff]!,
        start: startAnchor(start),
        end: endAnchor(end),
        source,
      };
      if (l.kind === 'hairpin')
        spanners.push({ ...base, kind: 'hairpin', direction: l.direction! });
      else if (l.kind === 'ottava') spanners.push({ ...base, kind: 'ottava', octaves: l.octaves! });
      else spanners.push({ ...base, kind: 'pedal', ...(l.style ? { style: l.style } : {}) });
    }
    for (const tr of p.trills) {
      const from = resolve(tr.from);
      if (!from || from.dropped) continue;
      const s = tr.from.start;
      const end = min(add(tr.to.start, tr.to.length), scoreEnd);
      if (!lt(s, end)) continue;
      spanners.push({
        id: ids.next('sp'),
        kind: 'trill',
        staffId: staffIds[globalStaff(from.part, from.staff)]!,
        start: startAnchor(s),
        end: endAnchor(end),
        source,
      });
    }
  }

  // -------------------------------------------------------------- document
  const meta = readMeta(root, options.fileName, lang);
  const doc: ScoreDoc = {
    format: SCORE_FORMAT,
    version: SCORE_FORMAT_VERSION,
    id: ids.next('sc'),
    meta: { ...meta, createdAt: options.now, modifiedAt: options.now },
    settings,
    parts,
    groups,
    measures,
    content,
    harmony,
    spanners,
  };
  const sorted: ScoreDoc = { ...doc, spanners: [...spanners].sort(compareSpanners(doc)) };
  const problems = validateScore(sorted);
  for (const p of problems) log.add(`Validation: ${p.path} — ${p.message}`);
  return { doc: sorted, warnings: log.list() };
}
