import type { InstrumentFamily } from './catalog';

export interface TemplatePart {
  readonly instrument: string;
  /** Custom names, e.g. "Violin I". Defaults to the catalog name. */
  readonly name?: { readonly en: string; readonly zh: string };
  readonly abbreviation?: { readonly en: string; readonly zh: string };
}

export interface ScoreTemplate {
  readonly id: string;
  readonly name: { readonly en: string; readonly zh: string };
  readonly category: 'solo' | 'chamber' | 'orchestra' | 'vocal';
  readonly parts: readonly TemplatePart[];
  /**
   * Bracketing: 'families' brackets consecutive parts of the same family (orchestral style);
   * 'all' brackets every single-staff part together (string quartet, wind quintet);
   * 'none' only braces multi-staff instruments.
   */
  readonly bracketing: 'families' | 'all' | 'none';
  /** Staff space in mm: smaller for big scores so more fits on a page. */
  readonly staffSpaceMm: number;
}

const n = (en: string, zh: string) => ({ en, zh });

export const TEMPLATES: readonly ScoreTemplate[] = [
  {
    id: 'piano',
    name: n('Piano', '钢琴独奏'),
    category: 'solo',
    parts: [{ instrument: 'piano' }],
    bracketing: 'none',
    staffSpaceMm: 1.75,
  },
  {
    id: 'violin-piano',
    name: n('Violin and Piano', '小提琴与钢琴'),
    category: 'chamber',
    parts: [{ instrument: 'violin' }, { instrument: 'piano' }],
    bracketing: 'none',
    staffSpaceMm: 1.7,
  },
  {
    id: 'cello-piano',
    name: n('Cello and Piano', '大提琴与钢琴'),
    category: 'chamber',
    parts: [{ instrument: 'cello' }, { instrument: 'piano' }],
    bracketing: 'none',
    staffSpaceMm: 1.7,
  },
  {
    id: 'piano-trio',
    name: n('Piano Trio', '钢琴三重奏'),
    category: 'chamber',
    parts: [{ instrument: 'violin' }, { instrument: 'cello' }, { instrument: 'piano' }],
    bracketing: 'none',
    staffSpaceMm: 1.6,
  },
  {
    id: 'string-quartet',
    name: n('String Quartet', '弦乐四重奏'),
    category: 'chamber',
    parts: [
      {
        instrument: 'violin',
        name: n('Violin I', '第一小提琴'),
        abbreviation: n('Vln. I', '小提一'),
      },
      {
        instrument: 'violin',
        name: n('Violin II', '第二小提琴'),
        abbreviation: n('Vln. II', '小提二'),
      },
      { instrument: 'viola' },
      { instrument: 'cello' },
    ],
    bracketing: 'all',
    staffSpaceMm: 1.6,
  },
  {
    id: 'wind-quintet',
    name: n('Wind Quintet', '木管五重奏'),
    category: 'chamber',
    parts: [
      { instrument: 'flute' },
      { instrument: 'oboe' },
      { instrument: 'clarinet-bb' },
      { instrument: 'horn-f' },
      { instrument: 'bassoon' },
    ],
    bracketing: 'all',
    staffSpaceMm: 1.6,
  },
  {
    id: 'brass-quintet',
    name: n('Brass Quintet', '铜管五重奏'),
    category: 'chamber',
    parts: [
      {
        instrument: 'trumpet-bb',
        name: n('Trumpet in B♭ 1', '降B调小号 1'),
        abbreviation: n('Tpt. 1', '小号1'),
      },
      {
        instrument: 'trumpet-bb',
        name: n('Trumpet in B♭ 2', '降B调小号 2'),
        abbreviation: n('Tpt. 2', '小号2'),
      },
      { instrument: 'horn-f' },
      { instrument: 'trombone' },
      { instrument: 'tuba' },
    ],
    bracketing: 'all',
    staffSpaceMm: 1.6,
  },
  {
    id: 'satb-piano',
    name: n('SATB Choir and Piano', '混声合唱与钢琴'),
    category: 'vocal',
    parts: [
      { instrument: 'soprano' },
      { instrument: 'alto' },
      { instrument: 'tenor' },
      { instrument: 'bass-voice' },
      { instrument: 'piano' },
    ],
    bracketing: 'families',
    staffSpaceMm: 1.5,
  },
  {
    id: 'classical-orchestra',
    name: n('Classical Orchestra', '古典管弦乐队'),
    category: 'orchestra',
    parts: [
      { instrument: 'flute', name: n('Flutes', '长笛'), abbreviation: n('Fl.', '长笛') },
      { instrument: 'oboe', name: n('Oboes', '双簧管'), abbreviation: n('Ob.', '双簧') },
      {
        instrument: 'clarinet-bb',
        name: n('Clarinets in B♭', '降B调单簧管'),
        abbreviation: n('Cl.', '单簧'),
      },
      { instrument: 'bassoon', name: n('Bassoons', '大管'), abbreviation: n('Bsn.', '大管') },
      { instrument: 'horn-f', name: n('Horns in F', 'F调圆号'), abbreviation: n('Hn.', '圆号') },
      {
        instrument: 'trumpet-bb',
        name: n('Trumpets in B♭', '降B调小号'),
        abbreviation: n('Tpt.', '小号'),
      },
      { instrument: 'timpani' },
      {
        instrument: 'violin',
        name: n('Violin I', '第一小提琴'),
        abbreviation: n('Vln. I', '小提一'),
      },
      {
        instrument: 'violin',
        name: n('Violin II', '第二小提琴'),
        abbreviation: n('Vln. II', '小提二'),
      },
      { instrument: 'viola' },
      { instrument: 'cello' },
      { instrument: 'double-bass' },
    ],
    bracketing: 'families',
    staffSpaceMm: 1.3,
  },
  {
    id: 'symphony-orchestra',
    name: n('Symphony Orchestra', '交响乐队（双管/三管）'),
    category: 'orchestra',
    parts: [
      { instrument: 'piccolo' },
      { instrument: 'flute', name: n('Flutes 1·2', '长笛 1·2'), abbreviation: n('Fl.', '长笛') },
      { instrument: 'oboe', name: n('Oboes 1·2', '双簧管 1·2'), abbreviation: n('Ob.', '双簧') },
      { instrument: 'english-horn' },
      {
        instrument: 'clarinet-bb',
        name: n('Clarinets in B♭ 1·2', '降B调单簧管 1·2'),
        abbreviation: n('Cl.', '单簧'),
      },
      { instrument: 'bass-clarinet' },
      {
        instrument: 'bassoon',
        name: n('Bassoons 1·2', '大管 1·2'),
        abbreviation: n('Bsn.', '大管'),
      },
      { instrument: 'contrabassoon' },
      {
        instrument: 'horn-f',
        name: n('Horns in F 1·2', 'F调圆号 1·2'),
        abbreviation: n('Hn. 1·2', '圆号1·2'),
      },
      {
        instrument: 'horn-f',
        name: n('Horns in F 3·4', 'F调圆号 3·4'),
        abbreviation: n('Hn. 3·4', '圆号3·4'),
      },
      {
        instrument: 'trumpet-bb',
        name: n('Trumpets in B♭ 1·2', '降B调小号 1·2'),
        abbreviation: n('Tpt.', '小号'),
      },
      {
        instrument: 'trombone',
        name: n('Trombones 1·2', '长号 1·2'),
        abbreviation: n('Tbn.', '长号'),
      },
      { instrument: 'bass-trombone' },
      { instrument: 'tuba' },
      { instrument: 'timpani' },
      { instrument: 'glockenspiel' },
      { instrument: 'cymbals' },
      { instrument: 'harp' },
      {
        instrument: 'violin',
        name: n('Violin I', '第一小提琴'),
        abbreviation: n('Vln. I', '小提一'),
      },
      {
        instrument: 'violin',
        name: n('Violin II', '第二小提琴'),
        abbreviation: n('Vln. II', '小提二'),
      },
      { instrument: 'viola' },
      { instrument: 'cello' },
      { instrument: 'double-bass' },
    ],
    bracketing: 'families',
    staffSpaceMm: 1.1,
  },
];

export function getTemplate(id: string): ScoreTemplate {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`unknown template "${id}"`);
  return t;
}

/** Families that share one bracket in orchestral bracketing. */
export const BRACKETED_FAMILIES: ReadonlySet<InstrumentFamily> = new Set([
  'woodwinds',
  'brass',
  'percussion',
  'voices',
  'strings',
]);
