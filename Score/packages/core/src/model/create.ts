import { getInstrument, type InstrumentFamily } from '../instruments/catalog';
import {
  BRACKETED_FAMILIES,
  getTemplate,
  type ScoreTemplate,
  type TemplatePart,
} from '../instruments/templates';
import type { KeySignature } from '../pitch/pitch';
import type { TimeSignature } from '../time/meter';
import { type Rational } from '../time/rational';
import { type IdGenerator, randomIds } from './ids';
import {
  type ID,
  type Measure,
  type Part,
  SCORE_FORMAT,
  SCORE_FORMAT_VERSION,
  type ScoreDoc,
  type ScoreSettings,
  type StaffGroup,
} from './types';

export type Lang = 'en' | 'zh';

export interface CreateScoreOptions {
  readonly template?: string | ScoreTemplate;
  readonly title?: string;
  readonly subtitle?: string;
  readonly composer?: string;
  readonly measures?: number;
  readonly timeSig?: TimeSignature;
  readonly keySig?: KeySignature;
  /** Tempo in quarter notes per minute. */
  readonly tempo?: number;
  /** Length of a pickup (anacrusis) bar, e.g. {n:1,d:4}. */
  readonly pickup?: Rational;
  readonly lang?: Lang;
  readonly ids?: IdGenerator;
  /** ISO timestamp for createdAt (pass a fixed value in tests). */
  readonly now?: string;
}

export const DEFAULT_SETTINGS: ScoreSettings = {
  staffSpaceMm: 1.75,
  pageSize: { widthMm: 210, heightMm: 297 },
  pageMarginsMm: { top: 15, bottom: 15, left: 15, right: 15 },
  concertPitch: false,
  defaultTempo: 100,
};

export function createPart(
  instrumentId: string,
  ids: IdGenerator,
  options: {
    lang?: Lang;
    name?: TemplatePart['name'];
    abbreviation?: TemplatePart['abbreviation'];
  } = {},
): Part {
  const def = getInstrument(instrumentId);
  const lang = options.lang ?? 'en';
  return {
    id: ids.next('pt'),
    instrument: def.id,
    name: (options.name ?? def.name)[lang],
    abbreviation: (options.abbreviation ?? def.abbreviation)[lang],
    staves: def.staves.map((clef) => ({ id: ids.next('st'), clef, lines: 5 })),
  };
}

export function createMeasures(count: number, ids: IdGenerator): Measure[] {
  return Array.from({ length: count }, () => ({ id: ids.next('m') }));
}

/** Brackets/braces for a list of parts according to the template's bracketing style. */
export function defaultGroups(
  parts: readonly Part[],
  bracketing: ScoreTemplate['bracketing'],
  ids: IdGenerator,
): StaffGroup[] {
  const groups: StaffGroup[] = [];
  for (const part of parts) {
    const def = getInstrument(part.instrument);
    if (part.staves.length > 1 && def.brace !== false) {
      groups.push({
        id: ids.next('gr'),
        kind: 'brace',
        firstStaff: part.staves[0]!.id,
        lastStaff: part.staves[part.staves.length - 1]!.id,
        barlineThrough: true,
      });
    }
  }
  if (bracketing === 'none') return groups;

  const singleStaff = (p: Part) => p.staves.length === 1;
  if (bracketing === 'all') {
    const run = parts.filter(singleStaff);
    if (run.length > 1) {
      groups.unshift({
        id: ids.next('gr'),
        kind: 'bracket',
        firstStaff: run[0]!.staves[0]!.id,
        lastStaff: run[run.length - 1]!.staves[0]!.id,
        barlineThrough: true,
      });
    }
    return groups;
  }

  // 'families': bracket each run of consecutive parts from the same bracketed family.
  let i = 0;
  while (i < parts.length) {
    const family: InstrumentFamily = getInstrument(parts[i]!.instrument).family;
    let j = i;
    while (j + 1 < parts.length && getInstrument(parts[j + 1]!.instrument).family === family) j++;
    if (BRACKETED_FAMILIES.has(family) && j > i) {
      groups.push({
        id: ids.next('gr'),
        kind: 'bracket',
        firstStaff: parts[i]!.staves[0]!.id,
        lastStaff: parts[j]!.staves[parts[j]!.staves.length - 1]!.id,
        barlineThrough: family !== 'voices',
      });
    }
    i = j + 1;
  }
  return groups;
}

export function createScore(options: CreateScoreOptions = {}): ScoreDoc {
  const ids = options.ids ?? randomIds();
  const lang = options.lang ?? 'en';
  const template =
    typeof options.template === 'object'
      ? options.template
      : getTemplate(options.template ?? 'piano');
  const parts = template.parts.map((tp) =>
    createPart(tp.instrument, ids, {
      lang,
      ...(tp.name ? { name: tp.name } : {}),
      ...(tp.abbreviation ? { abbreviation: tp.abbreviation } : {}),
    }),
  );
  const count = Math.max(1, options.measures ?? 16);
  const measures = createMeasures(count, ids);
  const timeSig = options.timeSig ?? { beats: 4, beatType: 4 };
  const keySig = options.keySig ?? { fifths: 0 };
  const tempo = options.tempo ?? DEFAULT_SETTINGS.defaultTempo;
  const first: Measure = {
    ...measures[0]!,
    timeSig,
    keySig,
    tempo: [{ id: ids.next('tm'), offset: { n: 0, d: 1 }, bpm: tempo }],
    ...(options.pickup ? { actualLength: options.pickup } : {}),
  };
  measures[0] = first;
  const lastIndex = measures.length - 1;
  measures[lastIndex] = { ...measures[lastIndex]!, barline: 'final' };

  const content: Record<ID, Record<ID, never>> = {};
  for (const part of parts) for (const staff of part.staves) content[staff.id] = {};

  return {
    format: SCORE_FORMAT,
    version: SCORE_FORMAT_VERSION,
    id: ids.next('sc'),
    meta: {
      title: options.title ?? (lang === 'zh' ? '未命名乐谱' : 'Untitled Score'),
      ...(options.subtitle ? { subtitle: options.subtitle } : {}),
      ...(options.composer ? { composer: options.composer } : {}),
      ...(options.now ? { createdAt: options.now, modifiedAt: options.now } : {}),
    },
    settings: { ...DEFAULT_SETTINGS, staffSpaceMm: template.staffSpaceMm, defaultTempo: tempo },
    parts,
    groups: defaultGroups(parts, template.bracketing, ids),
    measures,
    content,
    harmony: [],
  };
}
