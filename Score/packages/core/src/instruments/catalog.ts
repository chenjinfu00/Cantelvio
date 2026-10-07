import type { ClefType } from '../model/clef';
import { type Interval, interval } from '../pitch/pitch';

/** Cantelvio's six native instrument groups (see Cantelvio training/orchestra/groups.py). */
export const AILEGRO_GROUPS = [
  'woodwinds',
  'brass',
  'percussion',
  'keys',
  'high_strings',
  'low_strings',
] as const;
export type AilegroGroup = (typeof AILEGRO_GROUPS)[number];

export type InstrumentFamily =
  'woodwinds' | 'brass' | 'percussion' | 'keyboards' | 'plucked' | 'voices' | 'strings';

export interface InstrumentDef {
  readonly id: string;
  readonly name: { readonly en: string; readonly zh: string };
  readonly abbreviation: { readonly en: string; readonly zh: string };
  readonly family: InstrumentFamily;
  /** One clef per staff, top to bottom. */
  readonly staves: readonly ClefType[];
  /** Brace multi-staff instruments (piano, harp, organ). */
  readonly brace?: boolean;
  /** Written -> sounding. Absent = concert pitch instrument. */
  readonly transposition?: Interval;
  /** Professional sounding range as MIDI numbers [low, high]. */
  readonly range: readonly [number, number];
  /** General MIDI program (0-based). */
  readonly gmProgram: number;
  /** Unpitched percussion plays on the GM drum channel. */
  readonly unpitched?: boolean;
  /** Group used when exporting to Cantelvio; null = not mapped (e.g. voices). */
  readonly ailegroGroup: AilegroGroup | null;
  /** Orchestral score order (lower = higher on the page). */
  readonly order: number;
}

const OCTAVE_UP = interval(7, 12);
const OCTAVE_DOWN = interval(-7, -12);

function def(d: InstrumentDef): InstrumentDef {
  return d;
}

// prettier-ignore
export const INSTRUMENTS: readonly InstrumentDef[] = [
  // ---------------------------------------------------------------- woodwinds
  def({ id: 'piccolo', name: { en: 'Piccolo', zh: '短笛' }, abbreviation: { en: 'Picc.', zh: '短笛' }, family: 'woodwinds', staves: ['treble'], transposition: OCTAVE_UP, range: [74, 108], gmProgram: 72, ailegroGroup: 'woodwinds', order: 100 }),
  def({ id: 'flute', name: { en: 'Flute', zh: '长笛' }, abbreviation: { en: 'Fl.', zh: '长笛' }, family: 'woodwinds', staves: ['treble'], range: [60, 98], gmProgram: 73, ailegroGroup: 'woodwinds', order: 110 }),
  def({ id: 'alto-flute', name: { en: 'Alto Flute', zh: '中音长笛' }, abbreviation: { en: 'A. Fl.', zh: '中长笛' }, family: 'woodwinds', staves: ['treble'], transposition: interval(-3, -5), range: [55, 91], gmProgram: 73, ailegroGroup: 'woodwinds', order: 115 }),
  def({ id: 'recorder', name: { en: 'Recorder', zh: '竖笛' }, abbreviation: { en: 'Rec.', zh: '竖笛' }, family: 'woodwinds', staves: ['treble'], transposition: OCTAVE_UP, range: [72, 98], gmProgram: 74, ailegroGroup: 'woodwinds', order: 118 }),
  def({ id: 'oboe', name: { en: 'Oboe', zh: '双簧管' }, abbreviation: { en: 'Ob.', zh: '双簧' }, family: 'woodwinds', staves: ['treble'], range: [58, 93], gmProgram: 68, ailegroGroup: 'woodwinds', order: 120 }),
  def({ id: 'english-horn', name: { en: 'English Horn', zh: '英国管' }, abbreviation: { en: 'E. Hn.', zh: '英管' }, family: 'woodwinds', staves: ['treble'], transposition: interval(-4, -7), range: [52, 84], gmProgram: 69, ailegroGroup: 'woodwinds', order: 125 }),
  def({ id: 'clarinet-eb', name: { en: 'Clarinet in E♭', zh: '降E调单簧管' }, abbreviation: { en: 'E♭ Cl.', zh: '降E单簧' }, family: 'woodwinds', staves: ['treble'], transposition: interval(2, 3), range: [55, 99], gmProgram: 71, ailegroGroup: 'woodwinds', order: 128 }),
  def({ id: 'clarinet-bb', name: { en: 'Clarinet in B♭', zh: '降B调单簧管' }, abbreviation: { en: 'Cl.', zh: '单簧' }, family: 'woodwinds', staves: ['treble'], transposition: interval(-1, -2), range: [50, 94], gmProgram: 71, ailegroGroup: 'woodwinds', order: 130 }),
  def({ id: 'clarinet-a', name: { en: 'Clarinet in A', zh: 'A调单簧管' }, abbreviation: { en: 'Cl. (A)', zh: 'A单簧' }, family: 'woodwinds', staves: ['treble'], transposition: interval(-2, -3), range: [49, 93], gmProgram: 71, ailegroGroup: 'woodwinds', order: 131 }),
  def({ id: 'bass-clarinet', name: { en: 'Bass Clarinet', zh: '低音单簧管' }, abbreviation: { en: 'B. Cl.', zh: '低单簧' }, family: 'woodwinds', staves: ['treble'], transposition: interval(-8, -14), range: [34, 77], gmProgram: 71, ailegroGroup: 'woodwinds', order: 135 }),
  def({ id: 'soprano-sax', name: { en: 'Soprano Saxophone', zh: '高音萨克斯' }, abbreviation: { en: 'S. Sax.', zh: '高萨' }, family: 'woodwinds', staves: ['treble'], transposition: interval(-1, -2), range: [56, 88], gmProgram: 64, ailegroGroup: 'woodwinds', order: 140 }),
  def({ id: 'alto-sax', name: { en: 'Alto Saxophone', zh: '中音萨克斯' }, abbreviation: { en: 'A. Sax.', zh: '中萨' }, family: 'woodwinds', staves: ['treble'], transposition: interval(-5, -9), range: [49, 80], gmProgram: 65, ailegroGroup: 'woodwinds', order: 141 }),
  def({ id: 'tenor-sax', name: { en: 'Tenor Saxophone', zh: '次中音萨克斯' }, abbreviation: { en: 'T. Sax.', zh: '次中萨' }, family: 'woodwinds', staves: ['treble'], transposition: interval(-8, -14), range: [44, 76], gmProgram: 66, ailegroGroup: 'woodwinds', order: 142 }),
  def({ id: 'baritone-sax', name: { en: 'Baritone Saxophone', zh: '上低音萨克斯' }, abbreviation: { en: 'Bar. Sax.', zh: '上低萨' }, family: 'woodwinds', staves: ['treble'], transposition: interval(-12, -21), range: [37, 68], gmProgram: 67, ailegroGroup: 'woodwinds', order: 143 }),
  def({ id: 'bassoon', name: { en: 'Bassoon', zh: '大管' }, abbreviation: { en: 'Bsn.', zh: '大管' }, family: 'woodwinds', staves: ['bass'], range: [34, 76], gmProgram: 70, ailegroGroup: 'woodwinds', order: 150 }),
  def({ id: 'contrabassoon', name: { en: 'Contrabassoon', zh: '低音大管' }, abbreviation: { en: 'Cbsn.', zh: '低大管' }, family: 'woodwinds', staves: ['bass'], transposition: OCTAVE_DOWN, range: [22, 55], gmProgram: 70, ailegroGroup: 'woodwinds', order: 155 }),
  // ---------------------------------------------------------------- brass
  def({ id: 'horn-f', name: { en: 'Horn in F', zh: 'F调圆号' }, abbreviation: { en: 'Hn.', zh: '圆号' }, family: 'brass', staves: ['treble'], transposition: interval(-4, -7), range: [35, 77], gmProgram: 60, ailegroGroup: 'brass', order: 200 }),
  def({ id: 'trumpet-bb', name: { en: 'Trumpet in B♭', zh: '降B调小号' }, abbreviation: { en: 'Tpt.', zh: '小号' }, family: 'brass', staves: ['treble'], transposition: interval(-1, -2), range: [52, 84], gmProgram: 56, ailegroGroup: 'brass', order: 210 }),
  def({ id: 'trumpet-c', name: { en: 'Trumpet in C', zh: 'C调小号' }, abbreviation: { en: 'Tpt. (C)', zh: 'C小号' }, family: 'brass', staves: ['treble'], range: [54, 86], gmProgram: 56, ailegroGroup: 'brass', order: 211 }),
  def({ id: 'cornet-bb', name: { en: 'Cornet in B♭', zh: '短号' }, abbreviation: { en: 'Cnt.', zh: '短号' }, family: 'brass', staves: ['treble'], transposition: interval(-1, -2), range: [52, 82], gmProgram: 56, ailegroGroup: 'brass', order: 215 }),
  def({ id: 'flugelhorn', name: { en: 'Flugelhorn', zh: '富鲁格号' }, abbreviation: { en: 'Flgh.', zh: '富鲁格' }, family: 'brass', staves: ['treble'], transposition: interval(-1, -2), range: [52, 82], gmProgram: 56, ailegroGroup: 'brass', order: 216 }),
  def({ id: 'trombone', name: { en: 'Trombone', zh: '长号' }, abbreviation: { en: 'Tbn.', zh: '长号' }, family: 'brass', staves: ['bass'], range: [40, 77], gmProgram: 57, ailegroGroup: 'brass', order: 220 }),
  def({ id: 'bass-trombone', name: { en: 'Bass Trombone', zh: '低音长号' }, abbreviation: { en: 'B. Tbn.', zh: '低长号' }, family: 'brass', staves: ['bass'], range: [34, 70], gmProgram: 57, ailegroGroup: 'brass', order: 225 }),
  def({ id: 'euphonium', name: { en: 'Euphonium', zh: '上低音号' }, abbreviation: { en: 'Euph.', zh: '上低音' }, family: 'brass', staves: ['bass'], range: [34, 70], gmProgram: 58, ailegroGroup: 'brass', order: 228 }),
  def({ id: 'tuba', name: { en: 'Tuba', zh: '大号' }, abbreviation: { en: 'Tba.', zh: '大号' }, family: 'brass', staves: ['bass'], range: [26, 65], gmProgram: 58, ailegroGroup: 'brass', order: 230 }),
  // ---------------------------------------------------------------- percussion
  def({ id: 'timpani', name: { en: 'Timpani', zh: '定音鼓' }, abbreviation: { en: 'Timp.', zh: '定音鼓' }, family: 'percussion', staves: ['bass'], range: [38, 60], gmProgram: 47, ailegroGroup: 'percussion', order: 300 }),
  def({ id: 'xylophone', name: { en: 'Xylophone', zh: '木琴' }, abbreviation: { en: 'Xyl.', zh: '木琴' }, family: 'percussion', staves: ['treble'], transposition: OCTAVE_UP, range: [65, 108], gmProgram: 13, ailegroGroup: 'percussion', order: 320 }),
  def({ id: 'glockenspiel', name: { en: 'Glockenspiel', zh: '钟琴' }, abbreviation: { en: 'Glk.', zh: '钟琴' }, family: 'percussion', staves: ['treble'], transposition: interval(14, 24), range: [79, 108], gmProgram: 9, ailegroGroup: 'percussion', order: 321 }),
  def({ id: 'vibraphone', name: { en: 'Vibraphone', zh: '颤音琴' }, abbreviation: { en: 'Vib.', zh: '颤音琴' }, family: 'percussion', staves: ['treble'], range: [53, 89], gmProgram: 11, ailegroGroup: 'percussion', order: 322 }),
  def({ id: 'marimba', name: { en: 'Marimba', zh: '马林巴' }, abbreviation: { en: 'Mar.', zh: '马林巴' }, family: 'percussion', staves: ['treble', 'bass'], brace: true, range: [36, 96], gmProgram: 12, ailegroGroup: 'percussion', order: 323 }),
  def({ id: 'snare-drum', name: { en: 'Snare Drum', zh: '小军鼓' }, abbreviation: { en: 'S.D.', zh: '小鼓' }, family: 'percussion', staves: ['percussion'], range: [38, 38], gmProgram: 0, unpitched: true, ailegroGroup: 'percussion', order: 330 }),
  def({ id: 'bass-drum', name: { en: 'Bass Drum', zh: '大鼓' }, abbreviation: { en: 'B.D.', zh: '大鼓' }, family: 'percussion', staves: ['percussion'], range: [36, 36], gmProgram: 0, unpitched: true, ailegroGroup: 'percussion', order: 331 }),
  def({ id: 'cymbals', name: { en: 'Cymbals', zh: '镲' }, abbreviation: { en: 'Cym.', zh: '镲' }, family: 'percussion', staves: ['percussion'], range: [49, 49], gmProgram: 0, unpitched: true, ailegroGroup: 'percussion', order: 332 }),
  def({ id: 'triangle', name: { en: 'Triangle', zh: '三角铁' }, abbreviation: { en: 'Tri.', zh: '三角铁' }, family: 'percussion', staves: ['percussion'], range: [81, 81], gmProgram: 0, unpitched: true, ailegroGroup: 'percussion', order: 333 }),
  def({ id: 'drum-set', name: { en: 'Drum Set', zh: '架子鼓' }, abbreviation: { en: 'D. Set', zh: '架子鼓' }, family: 'percussion', staves: ['percussion'], range: [35, 81], gmProgram: 0, unpitched: true, ailegroGroup: 'percussion', order: 340 }),
  // ---------------------------------------------------------------- keyboards & plucked
  def({ id: 'harp', name: { en: 'Harp', zh: '竖琴' }, abbreviation: { en: 'Hp.', zh: '竖琴' }, family: 'keyboards', staves: ['treble', 'bass'], brace: true, range: [23, 104], gmProgram: 46, ailegroGroup: 'keys', order: 400 }),
  def({ id: 'celesta', name: { en: 'Celesta', zh: '钢片琴' }, abbreviation: { en: 'Cel.', zh: '钢片琴' }, family: 'keyboards', staves: ['treble', 'bass'], brace: true, transposition: OCTAVE_UP, range: [60, 108], gmProgram: 8, ailegroGroup: 'keys', order: 410 }),
  def({ id: 'piano', name: { en: 'Piano', zh: '钢琴' }, abbreviation: { en: 'Pno.', zh: '钢琴' }, family: 'keyboards', staves: ['treble', 'bass'], brace: true, range: [21, 108], gmProgram: 0, ailegroGroup: 'keys', order: 420 }),
  def({ id: 'harpsichord', name: { en: 'Harpsichord', zh: '羽管键琴' }, abbreviation: { en: 'Hpsd.', zh: '羽管键琴' }, family: 'keyboards', staves: ['treble', 'bass'], brace: true, range: [29, 89], gmProgram: 6, ailegroGroup: 'keys', order: 425 }),
  def({ id: 'organ', name: { en: 'Organ', zh: '管风琴' }, abbreviation: { en: 'Org.', zh: '管风琴' }, family: 'keyboards', staves: ['treble', 'bass', 'bass'], brace: true, range: [24, 96], gmProgram: 19, ailegroGroup: 'keys', order: 430 }),
  def({ id: 'guitar', name: { en: 'Guitar', zh: '吉他' }, abbreviation: { en: 'Gtr.', zh: '吉他' }, family: 'plucked', staves: ['treble8vb'], range: [40, 83], gmProgram: 24, ailegroGroup: 'keys', order: 440 }),
  // ---------------------------------------------------------------- voices (not mapped to a Cantelvio group)
  def({ id: 'soprano', name: { en: 'Soprano', zh: '女高音' }, abbreviation: { en: 'S.', zh: '女高' }, family: 'voices', staves: ['treble'], range: [60, 84], gmProgram: 52, ailegroGroup: null, order: 500 }),
  def({ id: 'mezzo-soprano', name: { en: 'Mezzo-soprano', zh: '女中音' }, abbreviation: { en: 'Mz.', zh: '女中' }, family: 'voices', staves: ['treble'], range: [57, 81], gmProgram: 52, ailegroGroup: null, order: 505 }),
  def({ id: 'alto', name: { en: 'Alto', zh: '女低音' }, abbreviation: { en: 'A.', zh: '女低' }, family: 'voices', staves: ['treble'], range: [53, 77], gmProgram: 52, ailegroGroup: null, order: 510 }),
  def({ id: 'tenor', name: { en: 'Tenor', zh: '男高音' }, abbreviation: { en: 'T.', zh: '男高' }, family: 'voices', staves: ['treble8vb'], range: [48, 72], gmProgram: 52, ailegroGroup: null, order: 520 }),
  def({ id: 'baritone', name: { en: 'Baritone', zh: '男中音' }, abbreviation: { en: 'Bar.', zh: '男中' }, family: 'voices', staves: ['bass'], range: [43, 67], gmProgram: 52, ailegroGroup: null, order: 530 }),
  def({ id: 'bass-voice', name: { en: 'Bass', zh: '男低音' }, abbreviation: { en: 'B.', zh: '男低' }, family: 'voices', staves: ['bass'], range: [40, 64], gmProgram: 52, ailegroGroup: null, order: 540 }),
  // ---------------------------------------------------------------- strings
  def({ id: 'violin', name: { en: 'Violin', zh: '小提琴' }, abbreviation: { en: 'Vln.', zh: '小提' }, family: 'strings', staves: ['treble'], range: [55, 103], gmProgram: 40, ailegroGroup: 'high_strings', order: 600 }),
  def({ id: 'viola', name: { en: 'Viola', zh: '中提琴' }, abbreviation: { en: 'Vla.', zh: '中提' }, family: 'strings', staves: ['alto'], range: [48, 88], gmProgram: 41, ailegroGroup: 'high_strings', order: 620 }),
  def({ id: 'cello', name: { en: 'Violoncello', zh: '大提琴' }, abbreviation: { en: 'Vc.', zh: '大提' }, family: 'strings', staves: ['bass'], range: [36, 81], gmProgram: 42, ailegroGroup: 'low_strings', order: 630 }),
  def({ id: 'double-bass', name: { en: 'Contrabass', zh: '低音提琴' }, abbreviation: { en: 'Cb.', zh: '低提' }, family: 'strings', staves: ['bass'], transposition: OCTAVE_DOWN, range: [28, 67], gmProgram: 43, ailegroGroup: 'low_strings', order: 640 }),
];

const BY_ID = new Map(INSTRUMENTS.map((d) => [d.id, d]));

export function getInstrument(id: string): InstrumentDef {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`unknown instrument "${id}"`);
  return d;
}

export function findInstrument(id: string): InstrumentDef | undefined {
  return BY_ID.get(id);
}

export const FAMILY_NAMES: Readonly<Record<InstrumentFamily, { en: string; zh: string }>> = {
  woodwinds: { en: 'Woodwinds', zh: '木管' },
  brass: { en: 'Brass', zh: '铜管' },
  percussion: { en: 'Percussion', zh: '打击乐' },
  keyboards: { en: 'Keyboards & Harp', zh: '键盘与竖琴' },
  plucked: { en: 'Plucked', zh: '弹拨' },
  voices: { en: 'Voices', zh: '人声' },
  strings: { en: 'Strings', zh: '弦乐' },
};
