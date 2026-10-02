/**
 * The .ailegro.json file format: the ScoreDoc as canonical, git-friendly JSON.
 *
 * - Stable key order and content ordered by score order (staves) and bar order (measures),
 *   so saving the same document twice produces identical bytes.
 * - Rationals are written as strings ("1/4") and pitches as names ("C#4") for readability.
 * - One event per line, so `git diff` of a score shows musical edits line by line.
 */
import { pitchName, parsePitch } from '../pitch/pitch';
import { parseRational, toString as ratString } from '../time/rational';
import { SCORE_FORMAT, SCORE_FORMAT_VERSION, type ScoreDoc } from '../model/types';

const RATIONAL_KEYS = new Set(['offset', 'duration', 'length', 'actualLength', 'beatUnit']);
const PITCH_KEYS = new Set(['pitch']);

const KEY_ORDER = [
  'format',
  'version',
  'id',
  'kind',
  'type',
  'staffId',
  'from',
  'to',
  'start',
  'end',
  'direction',
  'octaves',
  'style',
  'placement',
  'title',
  'subtitle',
  'composer',
  'arranger',
  'lyricist',
  'copyright',
  'createdAt',
  'modifiedAt',
  'meta',
  'settings',
  'instrument',
  'name',
  'abbreviation',
  'clef',
  'lines',
  'staves',
  'parts',
  'groups',
  'measures',
  'content',
  'harmony',
  'spanners',
  'measureId',
  'voice',
  'offset',
  'duration',
  'length',
  'slash',
  'value',
  'graces',
  'notes',
  'pitch',
  'root',
  'quality',
  'bass',
  'timeSig',
  'keySig',
  'beats',
  'beatType',
  'fifths',
  'mode',
  'actualLength',
  'barline',
  'repeatStart',
  'repeatEnd',
  'rehearsalMark',
  'tempo',
  'breakAfter',
  'voices',
  'tuplets',
  'clefChanges',
  'dynamics',
];
const KEY_RANK = new Map(KEY_ORDER.map((k, i) => [k, i]));

function orderKeys(keys: string[]): string[] {
  return keys.sort((a, b) => {
    const ra = KEY_RANK.get(a) ?? 1000;
    const rb = KEY_RANK.get(b) ?? 1000;
    return ra - rb || (a < b ? -1 : a > b ? 1 : 0);
  });
}

function isRational(v: unknown): v is { n: number; d: number } {
  return typeof v === 'object' && v !== null && Object.keys(v).length === 2 && 'n' in v && 'd' in v;
}

function isPitch(v: unknown): v is { step: 'C'; alter: number; octave: number } {
  return typeof v === 'object' && v !== null && 'step' in v && 'alter' in v && 'octave' in v;
}

/** Convert in-memory values to their file representation (rationals/pitches as strings). */
function encode(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => encode(v, key));
  if (value && typeof value === 'object') {
    if (key && RATIONAL_KEYS.has(key) && isRational(value)) return ratString(value);
    if (key && PITCH_KEYS.has(key) && isPitch(value)) return pitchName(value);
    const out: Record<string, unknown> = {};
    for (const k of orderKeys(Object.keys(value))) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = encode(v, k);
    }
    return out;
  }
  return value;
}

function decode(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => decode(v, key));
  if (typeof value === 'string' && key && RATIONAL_KEYS.has(key)) return parseRational(value);
  if (typeof value === 'string' && key && PITCH_KEYS.has(key)) return parsePitch(value);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v, k);
    return out;
  }
  return value;
}

/** Order content maps by staff order and measure order. */
function canonicalContent(doc: ScoreDoc): ScoreDoc['content'] {
  const out: Record<string, Record<string, unknown>> = {};
  for (const part of doc.parts) {
    for (const staff of part.staves) {
      const measures = doc.content[staff.id] ?? {};
      const ordered: Record<string, unknown> = {};
      for (const m of doc.measures) if (measures[m.id]) ordered[m.id] = measures[m.id];
      out[staff.id] = ordered;
    }
  }
  return out as ScoreDoc['content'];
}

// Paths at which objects are written on one line: events, tuplets, clef changes, dynamics,
// harmony entries, spanners, tempo marks, staves and groups.
function inlineAt(path: readonly string[]): boolean {
  const n = path.length;
  if (n >= 6 && path[0] === 'content' && path[3] === 'voices') return n === 6; // content.st.m.voices.v.i
  if (n === 5 && path[0] === 'content' && ['tuplets', 'clefChanges', 'dynamics'].includes(path[3]!))
    return true;
  if (n === 2 && (path[0] === 'harmony' || path[0] === 'groups' || path[0] === 'spanners'))
    return true;
  if (n === 4 && path[0] === 'parts' && path[2] === 'staves') return true;
  if (n === 4 && path[0] === 'measures' && path[2] === 'tempo') return true;
  return false;
}

function stringify(value: unknown, path: string[], indent: string): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (inlineAt(path)) return JSON.stringify(value);
  const next = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) return JSON.stringify(value);
    const items = value.map((v, i) => next + stringify(v, [...path, String(i)], next));
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const compact = JSON.stringify(value);
  if (compact.length <= 72 && !compact.includes('[{')) return compact;
  const items = entries.map(
    ([k, v]) => `${next}${JSON.stringify(k)}: ${stringify(v, [...path, k], next)}`,
  );
  return `{\n${items.join(',\n')}\n${indent}}`;
}

export function serializeScore(doc: ScoreDoc): string {
  const encoded = encode({ ...doc, content: canonicalContent(doc) });
  return stringify(encoded, [], '') + '\n';
}

export class ScoreFormatError extends Error {
  override name = 'ScoreFormatError';
}

/**
 * Bring a decoded document of an older version up to SCORE_FORMAT_VERSION.
 * v1 -> v2: event marks and grace notes are new optional fields; `spanners` is a new list.
 */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let doc = raw;
  if (doc.version === 1) doc = { ...doc, version: 2, spanners: doc.spanners ?? [] };
  return doc;
}

export function parseScore(text: string): ScoreDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ScoreFormatError(`not JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') throw new ScoreFormatError('not a score document');
  const r = raw as Record<string, unknown>;
  if (r.format !== SCORE_FORMAT)
    throw new ScoreFormatError(`unexpected format "${String(r.format)}"`);
  if (typeof r.version !== 'number' || r.version > SCORE_FORMAT_VERSION) {
    throw new ScoreFormatError(
      `unsupported version ${String(r.version)} (this app reads up to ${SCORE_FORMAT_VERSION})`,
    );
  }
  if (!Number.isInteger(r.version) || (r.version as number) < 1)
    throw new ScoreFormatError(`invalid version ${String(r.version)}`);
  const doc = migrate(decode(r) as Record<string, unknown>) as unknown as ScoreDoc;
  for (const key of ['parts', 'measures', 'groups', 'harmony', 'spanners'] as const) {
    if (!Array.isArray(doc[key])) throw new ScoreFormatError(`missing ${key}`);
  }
  if (!doc.content || typeof doc.content !== 'object')
    throw new ScoreFormatError('missing content');
  return doc;
}
