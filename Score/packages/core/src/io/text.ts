/**
 * Cantelvio text notation (v1): a compact, LilyPond-inspired way to type music, used by the editor's
 * text input mode, by tests and fixtures, and as an easy format for language models to write.
 *
 *   c d e f | g2 g2 | a4 a a a | g1          relative octaves, durations carry over
 *   c'4 d, e8. f16 g4~ g8 r8 <c e g>2 R     ' up an octave, , down; ~ tie; r rest; R rest to barline
 *                                            (rests overwrite like notes)
 *   3{ c8 d e } f#4 bb4 en4                  tuplets; # ## b bb accidentals, n forces a natural
 *   c4-. d-> e-- f-^ g\fermata a\trill      articulations and ornaments after the note
 *   c4\p\< d( e f) g\f                       dynamics, hairpins (\< \> \!), slurs ( )
 *   \acciaccatura d8 c4  \grace { c16 d } e4  grace notes before the next note
 *   \8va c d e \loco f  c\sustainOn d e\sustainOff  c1\startTrillSpan d\stopTrillSpan  c4:16
 *
 * Pitches are chosen like LilyPond's relative mode: each note goes to the octave closest to the
 * previous note (within a fourth); in a chord the reference is the previous chord note and after
 * the chord it is the chord's first note. By default letters follow the key signature (in G major
 * `f` is F#), as with keyboard input; `n` writes a natural. `|` is an optional bar check.
 */
import { type Command } from '../commands/types';
import { type IdGenerator } from '../model/ids';
import { clefAt, locate, measureInfo, measureInfos, scoreLength, staffInfo } from '../model/query';
import { spannerTimes } from '../model/spanners';
import { middleLinePitch } from '../model/clef';
import type {
  Arpeggio,
  Articulation,
  Breath,
  DynamicValue,
  ID,
  MeasureAnchor,
  Ornament,
  ScoreDoc,
  ScorePosition,
  Spanner,
} from '../model/types';
import {
  type KeySignature,
  type Pitch,
  type Step,
  diatonicOf,
  keyAlter,
  nearestPitchForStep,
} from '../pitch/pitch';
import {
  NOTE_VALUE_BEAMS,
  type NoteValue,
  type WrittenDuration,
  writtenLength,
  tupletActual,
} from '../time/duration';
import { type Rational, add, cmp, eq, lt, rat, sub, ZERO } from '../time/rational';

export interface TextNote {
  readonly step: Step;
  /** Explicit alteration, or null to use the key signature. */
  readonly alter: number | null;
  readonly octaveShift: number;
}

/** Line starts and stops written after a note or rest, in written order. */
export type TextLineMark =
  | 'slurStart'
  | 'slurEnd'
  | 'crescendo'
  | 'diminuendo'
  | 'hairpinEnd'
  | 'pedalOn'
  | 'pedalOff'
  | 'trillStart'
  | 'trillStop';

/** Marks written after a note (rests only carry dynamics and line marks). */
export interface TextMarks {
  readonly articulations: readonly Articulation[];
  readonly ornament?: Ornament;
  readonly tremolo?: number;
  readonly arpeggio?: Arpeggio;
  readonly breath?: Breath;
  readonly dynamic?: DynamicValue;
  readonly lines: readonly TextLineMark[];
}

export interface TextGrace {
  readonly slash: boolean;
  readonly written: WrittenDuration;
  readonly notes: readonly TextNote[];
}

export type TextItem =
  | {
      readonly kind: 'note';
      readonly notes: readonly TextNote[];
      readonly written: WrittenDuration;
      readonly tie: boolean;
      readonly tuplet?: TextTuplet;
      readonly marks?: TextMarks;
      readonly graces?: readonly TextGrace[];
    }
  | {
      readonly kind: 'rest';
      readonly written: WrittenDuration;
      readonly tuplet?: TextTuplet;
      readonly marks?: TextMarks;
    }
  | { readonly kind: 'measureRest'; readonly marks?: TextMarks }
  | { readonly kind: 'barCheck'; readonly index: number }
  /** \ottava #n (or \8va, \8vb, \15ma, \15mb, \loco): octave line from the next item on. */
  | { readonly kind: 'ottava'; readonly octaves: number };

export interface TextTuplet {
  readonly group: number;
  readonly actual: number;
  readonly normal: number;
}

export class TextNotationError extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(`${message} (at character ${index})`);
    this.name = 'TextNotationError';
  }
}

const DURATIONS: Record<string, NoteValue> = {
  '1': 'whole',
  '2': 'half',
  '4': 'quarter',
  '8': 'eighth',
  '16': '16th',
  '32': '32nd',
  '64': '64th',
  '128': '128th',
};

const DEFAULT_NORMAL: Record<number, number> = { 2: 3, 3: 2, 4: 3, 5: 4, 6: 4, 7: 4, 9: 8 };

/** `-.` style shorthands (LilyPond). `-_` (portato) is tenuto plus staccato. */
const SHORTHAND: Record<string, readonly Articulation[]> = {
  '.': ['staccato'],
  '!': ['staccatissimo'],
  '-': ['tenuto'],
  '>': ['accent'],
  '^': ['marcato'],
  _: ['tenuto', 'staccato'],
  '+': ['stopped'],
};

const ARTICULATION_COMMANDS: Record<string, Articulation> = {
  staccato: 'staccato',
  staccatissimo: 'staccatissimo',
  tenuto: 'tenuto',
  accent: 'accent',
  marcato: 'marcato',
  fermata: 'fermata',
  shortfermata: 'fermataShort',
  longfermata: 'fermataLong',
  upbow: 'upBow',
  downbow: 'downBow',
  flageolet: 'harmonic',
  harmonic: 'harmonic',
  stopped: 'stopped',
  open: 'open',
  snappizzicato: 'snapPizzicato',
};

const ORNAMENT_COMMANDS: Record<string, Ornament> = {
  trill: 'trill',
  prall: 'shortTrill',
  mordent: 'mordent',
  turn: 'turn',
  reverseturn: 'invertedTurn',
};

const DYNAMICS = new Set<string>([
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

const LINE_COMMANDS: Record<string, TextLineMark> = {
  '<': 'crescendo',
  '>': 'diminuendo',
  '!': 'hairpinEnd',
  sustainOn: 'pedalOn',
  sustainOff: 'pedalOff',
  startTrillSpan: 'trillStart',
  stopTrillSpan: 'trillStop',
};

const OTTAVA_ALIASES: Record<string, number> = {
  '8va': 1,
  '8vb': -1,
  '15ma': 2,
  '15mb': -2,
  loco: 0,
};

const TREMOLO_STROKES: Record<string, number> = { '8': 1, '16': 2, '32': 3, '64': 4 };

/** `\name` at i: letters, the ottava aliases or one of < > !. */
const COMMAND = /^\\(8va|8vb|15ma|15mb|[A-Za-z]+|[<>!])/;

/** Tokenize and parse text into items. Durations carry over from the previous note or rest. */
export function parseText(
  text: string,
  initial: WrittenDuration = { value: 'quarter', dots: 0 },
): TextItem[] {
  const items: TextItem[] = [];
  let i = 0;
  let current = initial;
  let tuplet: TextTuplet | undefined;
  let tupletGroups = 0;
  let graces: TextGrace[] = [];
  const peek = () => text[i] ?? '';
  const skipSpace = () => {
    while (i < text.length) {
      if (/\s/.test(text[i]!)) i++;
      else if (text[i] === '%') while (i < text.length && text[i] !== '\n') i++;
      else break;
    }
  };
  const readNote = (): TextNote => {
    const start = i;
    const letter = text[i]!.toLowerCase();
    if (!/[a-g]/.test(letter)) throw new TextNotationError(`expected a note name`, start);
    i++;
    let alter: number | null = null;
    if (text.startsWith('##', i) || peek() === 'x') {
      alter = 2;
      i += peek() === 'x' ? 1 : 2;
    } else if (peek() === '#') {
      alter = 1;
      i++;
    } else if (text.startsWith('bb', i)) {
      alter = -2;
      i += 2;
    } else if (peek() === 'b') {
      alter = -1;
      i++;
    } else if (peek() === 'n') {
      alter = 0;
      i++;
    }
    let octaveShift = 0;
    while (peek() === "'" || peek() === ',') {
      octaveShift += peek() === "'" ? 1 : -1;
      i++;
    }
    return { step: letter.toUpperCase() as Step, alter, octaveShift };
  };
  const readDuration = (): WrittenDuration => {
    const m = /^(128|64|32|16|8|4|2|1)/.exec(text.slice(i));
    let value = current.value;
    let dots = current.dots;
    if (m) {
      value = DURATIONS[m[1]!]!;
      dots = 0;
      i += m[1]!.length;
      while (peek() === '.') {
        dots++;
        i++;
      }
    } else if (peek() === '.') {
      throw new TextNotationError('a dot needs an explicit duration (e.g. 4.)', i);
    }
    current = { value, dots };
    return current;
  };
  /** A note or a <chord>, without duration. */
  const readPitches = (at: number): TextNote[] => {
    if (peek() !== '<') return [readNote()];
    i++;
    const notes: TextNote[] = [];
    while (true) {
      skipSpace();
      if (peek() === '>') {
        i++;
        break;
      }
      if (i >= text.length) throw new TextNotationError('unterminated chord', at);
      notes.push(readNote());
    }
    if (notes.length === 0) throw new TextNotationError('empty chord', at);
    return notes;
  };
  /**
   * Marks after a note or rest. `full` = a note (rests carry dynamics and line marks only);
   * `onTie` accepts a `~` among the marks (`c4-.~`).
   */
  const readMarks = (full: boolean, onTie?: () => void): TextMarks | undefined => {
    const articulations: Articulation[] = [];
    const lines: TextLineMark[] = [];
    let ornament: Ornament | undefined;
    let tremolo: number | undefined;
    let arpeggio: Arpeggio | undefined;
    let breath: Breath | undefined;
    let dynamic: DynamicValue | undefined;
    let any = false;
    const noteOnly = (what: string, at: number) => {
      if (!full) throw new TextNotationError(`${what} needs a note`, at);
    };
    while (true) {
      const save = i;
      skipSpace();
      const at = i;
      const c = peek();
      if (c === '~' && onTie) {
        onTie();
        i++;
        continue;
      }
      if (c === '-' && SHORTHAND[text[i + 1] ?? '']) {
        noteOnly('an articulation', at);
        articulations.push(...SHORTHAND[text[i + 1]!]!);
        i += 2;
      } else if (c === '(' || c === ')') {
        noteOnly('a slur', at);
        lines.push(c === '(' ? 'slurStart' : 'slurEnd');
        i++;
      } else if (c === ':' && /^:(8|16|32|64)(?!\d)/.test(text.slice(i))) {
        noteOnly('a tremolo', at);
        const m = /^:(8|16|32|64)/.exec(text.slice(i))!;
        tremolo = TREMOLO_STROKES[m[1]!];
        i += m[0].length;
      } else if (c === '\\') {
        const m = COMMAND.exec(text.slice(i));
        const name = m?.[1] ?? '';
        if (ARTICULATION_COMMANDS[name]) {
          noteOnly(`\\${name}`, at);
          articulations.push(ARTICULATION_COMMANDS[name]!);
        } else if (ORNAMENT_COMMANDS[name]) {
          noteOnly(`\\${name}`, at);
          ornament = ORNAMENT_COMMANDS[name];
        } else if (name === 'arpeggio' || name === 'arpeggioUp' || name === 'arpeggioDown') {
          noteOnly(`\\${name}`, at);
          arpeggio = name === 'arpeggio' ? 'normal' : name === 'arpeggioUp' ? 'up' : 'down';
        } else if (name === 'breathe' || name === 'caesura') {
          noteOnly(`\\${name}`, at);
          breath = name === 'breathe' ? 'breath' : 'caesura';
        } else if (DYNAMICS.has(name)) {
          dynamic = name as DynamicValue;
        } else if (LINE_COMMANDS[name]) {
          lines.push(LINE_COMMANDS[name]!);
        } else {
          i = save; // a command for what follows (\ottava, \grace, ...)
          break;
        }
        i += m![0].length;
      } else {
        i = save;
        break;
      }
      any = true;
    }
    if (!any) return undefined;
    return {
      articulations: [...new Set(articulations)],
      ...(ornament ? { ornament } : {}),
      ...(tremolo ? { tremolo } : {}),
      ...(arpeggio ? { arpeggio } : {}),
      ...(breath ? { breath } : {}),
      ...(dynamic ? { dynamic } : {}),
      lines,
    };
  };
  /** Grace notes after \grace / \acciaccatura / \appoggiatura: one note, one chord or { … }. */
  const readGraces = (slash: boolean, at: number): TextGrace[] => {
    const saved = current;
    current = { value: 'eighth', dots: 0 };
    const out: TextGrace[] = [];
    skipSpace();
    const one = () => {
      const start = i;
      if (!/[a-gA-G<]/.test(peek())) throw new TextNotationError('expected a grace note', start);
      const notes = readPitches(start);
      out.push({ slash, written: readDuration(), notes });
    };
    if (peek() === '{') {
      i++;
      while (true) {
        skipSpace();
        if (peek() === '}') {
          i++;
          break;
        }
        if (i >= text.length) throw new TextNotationError('unterminated grace notes', at);
        one();
      }
      // several grace notes: only a single one is slashed
      if (out.length > 1)
        for (let k = 0; k < out.length; k++) out[k] = { ...out[k]!, slash: false };
    } else one();
    current = saved;
    return out;
  };
  const pushNote = (item: Extract<TextItem, { kind: 'note' }>) => {
    items.push(graces.length ? { ...item, graces } : item);
    graces = [];
  };
  const noPendingGraces = (at: number) => {
    if (graces.length) throw new TextNotationError('grace notes need a following note', at);
  };

  while (true) {
    skipSpace();
    if (i >= text.length) break;
    const c = peek();
    const at = i;
    if (c === '|') {
      noPendingGraces(at);
      i++;
      items.push({ kind: 'barCheck', index: at });
    } else if (c === '}') {
      if (!tuplet) throw new TextNotationError('unmatched }', at);
      tuplet = undefined;
      i++;
    } else if (/[0-9]/.test(c)) {
      const m = /^(\d+)(?::(\d+))?\s*\{/.exec(text.slice(i));
      if (!m) throw new TextNotationError('expected a tuplet like 3{ ... }', at);
      if (tuplet) throw new TextNotationError('nested tuplets are not supported yet', at);
      const actual = Number(m[1]);
      const normal = m[2] ? Number(m[2]) : DEFAULT_NORMAL[actual];
      if (!normal) throw new TextNotationError(`give the ratio explicitly, e.g. ${actual}:4{`, at);
      tuplet = { group: ++tupletGroups, actual, normal };
      i += m[0].length;
    } else if (c === '\\') {
      const m = COMMAND.exec(text.slice(i));
      const name = m?.[1] ?? '';
      if (name === 'grace' || name === 'acciaccatura' || name === 'appoggiatura') {
        i += m![0].length;
        graces = [...graces, ...readGraces(name === 'acciaccatura', at)];
      } else if (name === 'ottava') {
        i += m![0].length;
        const n = /^\s*#\s*(-?\d+)/.exec(text.slice(i));
        if (!n || ![-2, -1, 0, 1, 2].includes(Number(n[1])))
          throw new TextNotationError('expected \\ottava #1 (or #-1, #2, #-2, #0)', at);
        i += n[0].length;
        items.push({ kind: 'ottava', octaves: Number(n[1]) });
      } else if (name in OTTAVA_ALIASES) {
        i += m![0].length;
        items.push({ kind: 'ottava', octaves: OTTAVA_ALIASES[name]! });
      } else if (m) {
        throw new TextNotationError(`\\${name} must follow a note`, at);
      } else {
        throw new TextNotationError('unknown command', at);
      }
    } else if (c === 'R') {
      noPendingGraces(at);
      i++;
      const marks = readMarks(false);
      items.push(marks ? { kind: 'measureRest', marks } : { kind: 'measureRest' });
    } else if (c === 'r') {
      noPendingGraces(at);
      i++;
      const written = readDuration();
      const marks = readMarks(false);
      items.push({
        kind: 'rest',
        written,
        ...(tuplet ? { tuplet } : {}),
        ...(marks ? { marks } : {}),
      });
    } else if (c === '<' || /[a-gA-G]/.test(c)) {
      const notes = readPitches(at);
      const written = readDuration();
      let tie = false;
      let marks = readMarks(true, () => (tie = true));
      if (marks?.tremolo) {
        // c8:16 is a 16th tremolo: on an eighth (one flag) that is one stroke through the stem
        const strokes = marks.tremolo - NOTE_VALUE_BEAMS[written.value];
        marks = { ...marks, tremolo: Math.max(1, Math.min(4, strokes)) };
      }
      pushNote({
        kind: 'note',
        notes,
        written,
        tie,
        ...(tuplet ? { tuplet } : {}),
        ...(marks ? { marks } : {}),
      });
    } else {
      throw new TextNotationError(`unexpected "${c}"`, at);
    }
  }
  if (tuplet) throw new TextNotationError('unterminated tuplet', text.length);
  noPendingGraces(text.length);
  return items;
}

/** Resolve relative octaves: the pitch for each note given the running reference pitch. */
export function resolvePitch(
  note: TextNote,
  reference: Pitch,
  key: KeySignature,
  keyRelative: boolean,
): Pitch {
  const alter = note.alter ?? (keyRelative ? keyAlter(key.fifths, note.step) : 0);
  const base = nearestPitchForStep(note.step, reference, key, alter);
  return { ...base, octave: base.octave + note.octaveShift };
}

export interface TextInputOptions {
  readonly ids: IdGenerator;
  /** Letters follow the key signature (default true). */
  readonly keyRelative?: boolean;
  /** Append measures when the music runs past the end of the score (default true). */
  readonly extend?: boolean;
  /** Reference pitch for the first note (default: middle line of the staff's clef). */
  readonly reference?: Pitch;
}

export interface TextInputResult {
  readonly commands: Command[];
  /** Position after the last item. */
  readonly end: ScorePosition;
  readonly warnings: string[];
  /** Ids of created events in order. */
  readonly eventIds: ID[];
}

/**
 * Turn text into commands that write it at `at` (overwriting what is there). Apply the result
 * with `applyCommand(doc, { type: 'batch', commands })`.
 */
export function textToCommands(
  doc: ScoreDoc,
  at: ScorePosition,
  text: string,
  options: TextInputOptions,
): TextInputResult {
  const items = parseText(text);
  const ids = options.ids;
  const keyRelative = options.keyRelative ?? true;
  const extend = options.extend ?? true;
  const commands: Command[] = [];
  const warnings: string[] = [];
  const eventIds: ID[] = [];

  // Work in absolute time; measures are appended virtually when needed.
  const infos = measureInfos(doc);
  const measureIds = infos.map((m) => m.measure.id);
  const lengths = infos.map((m) => m.length);
  const starts = infos.map((m) => m.start);
  let total = scoreLength(doc);
  const lastLength = lengths[lengths.length - 1] ?? rat(1);
  const appended: ID[] = [];
  const ensure = (t: Rational) => {
    while (cmp(t, total) > 0) {
      if (!extend) return false;
      const id = ids.next('m');
      appended.push(id);
      measureIds.push(id);
      starts.push(total);
      lengths.push(lastLength);
      total = add(total, lastLength);
    }
    return true;
  };
  const position = (t: Rational): { measureId: ID; offset: Rational; index: number } => {
    let idx = 0;
    while (idx + 1 < starts.length && cmp(starts[idx + 1]!, t) <= 0) idx++;
    return { measureId: measureIds[idx]!, offset: sub(t, starts[idx]!), index: idx };
  };

  let t = add(measureInfo(doc, at.measureId).start, at.offset);
  const firstMeasureIndex = locate(doc, t)?.measureIndex ?? 0;
  let reference: Pitch =
    options.reference ?? middleLinePitch(clefAt(doc, at.staffId, firstMeasureIndex, at.offset));
  // Prefer the previous note in this voice as the reference (like keyboard input).
  if (!options.reference) {
    const prev = previousPitch(doc, at, t);
    if (prev) reference = prev;
  }
  let pendingTie = false;
  // Lines are collected while walking and added after the notes they refer to.
  const lineCommands: Command[] = [];
  const startAt = (tt: Rational): MeasureAnchor => {
    const p = position(tt);
    return { measureId: p.measureId, offset: p.offset };
  };
  const endAt = (tt: Rational): MeasureAnchor => {
    let idx = 0;
    while (idx + 1 < starts.length && cmp(starts[idx + 1]!, tt) < 0) idx++;
    return { measureId: measureIds[idx]!, offset: sub(tt, starts[idx]!) };
  };
  const openLines: {
    hairpin?: { direction: 'crescendo' | 'diminuendo'; start: Rational };
    pedal?: Rational;
    trill?: Rational;
    ottava?: { octaves: number; start: Rational };
  } = {};
  // pedal marks belong under the lowest staff of the instrument (as with the keypad)
  const part = staffInfo(doc, at.staffId).part;
  const pedalStaff = part.staves[part.staves.length - 1]!.id;
  // octave lines already on the staff: the new ones replace them where they overlap
  const ottavas = doc.spanners
    .filter((sp): sp is Extract<Spanner, { kind: 'ottava' }> => sp.kind === 'ottava')
    .filter((sp) => sp.staffId === at.staffId)
    .map((sp) => ({ sp, t: spannerTimes(doc, sp) }))
    .filter(
      (
        o,
      ): o is { sp: Extract<Spanner, { kind: 'ottava' }>; t: { start: Rational; end: Rational } } =>
        !!o.t,
    );
  const clearOttavas = (from: Rational, to: Rational) => {
    for (let k = ottavas.length - 1; k >= 0; k--) {
      const o = ottavas[k]!;
      if (!lt(o.t.start, to) || !lt(from, o.t.end)) continue;
      const before = lt(o.t.start, from);
      const after = lt(to, o.t.end);
      ottavas.splice(k, 1);
      if (!before && !after) {
        lineCommands.push({ type: 'spanners.delete', ids: [o.sp.id] });
        continue;
      }
      if (before) {
        const head = { ...o.sp, end: endAt(from) };
        lineCommands.push({ type: 'spanner.set', spanner: head });
        ottavas.push({ sp: head, t: { start: o.t.start, end: from } });
      }
      if (after) {
        const tail = { ...o.sp, ...(before ? { id: ids.next('sp') } : {}), start: startAt(to) };
        lineCommands.push({ type: before ? 'spanner.add' : 'spanner.set', spanner: tail });
        ottavas.push({ sp: tail, t: { start: to, end: o.t.end } });
      }
    }
  };
  const addLine = (from: Rational, to: Rational, line: Record<string, unknown>) => {
    if (!lt(from, to)) return;
    if (line.kind === 'ottava') clearOttavas(from, to);
    lineCommands.push({
      type: 'spanner.add',
      spanner: {
        id: ids.next('sp'),
        staffId: line.kind === 'pedal' ? pedalStaff : at.staffId,
        start: startAt(from),
        end: endAt(to),
        ...line,
      } as unknown as Spanner,
    });
  };
  const closeHairpin = (tt: Rational) => {
    const h = openLines.hairpin;
    if (h) addLine(h.start, tt, { kind: 'hairpin', direction: h.direction });
    delete openLines.hairpin;
  };
  const closePedal = (tt: Rational) => {
    if (openLines.pedal) addLine(openLines.pedal, tt, { kind: 'pedal' });
    delete openLines.pedal;
  };
  const closeTrill = (tt: Rational) => {
    if (openLines.trill) addLine(openLines.trill, tt, { kind: 'trill' });
    delete openLines.trill;
  };
  const closeOttava = (tt: Rational) => {
    const o = openLines.ottava;
    if (o) addLine(o.start, tt, { kind: 'ottava', octaves: o.octaves });
    delete openLines.ottava;
  };
  const slurStack: ID[] = [];
  /** Dynamics and line marks of an item starting at tt (eventId: the note's event, if any). */
  const applyMarks = (marks: TextMarks | undefined, tt: Rational, eventId: ID | null) => {
    if (!marks) return;
    if (marks.dynamic) {
      closeHairpin(tt);
      const p = position(tt);
      commands.push({
        type: 'dynamic.set',
        staffId: at.staffId,
        measureId: p.measureId,
        mark: { id: ids.next('dy'), offset: p.offset, value: marks.dynamic },
      });
    }
    for (const line of marks.lines) {
      if (line === 'crescendo' || line === 'diminuendo') {
        closeHairpin(tt);
        openLines.hairpin = { direction: line, start: tt };
      } else if (line === 'hairpinEnd') closeHairpin(tt);
      else if (line === 'pedalOn') {
        closePedal(tt);
        openLines.pedal = tt;
      } else if (line === 'pedalOff') closePedal(tt);
      else if (line === 'trillStart') {
        closeTrill(tt);
        openLines.trill = tt;
      } else if (line === 'trillStop') closeTrill(tt);
      else if (line === 'slurStart' && eventId) slurStack.push(eventId);
      else if (line === 'slurEnd' && eventId) {
        const from = slurStack.pop();
        if (from && from !== eventId)
          lineCommands.push({
            type: 'spanner.add',
            spanner: { id: ids.next('sp'), kind: 'slur', staffId: at.staffId, from, to: eventId },
          });
        else warnings.push('a slur needs a start ( and an end ) on different notes');
      }
    }
  };
  interface OpenTuplet {
    id: ID;
    length: Rational;
    actual: number;
    normal: number;
    measureId: ID;
    offset: Rational;
    measureIndex: number;
  }
  const tuplets = new Map<number, OpenTuplet>();

  const keyAtTime = (tt: Rational): KeySignature => {
    const p = position(tt);
    return p.index < infos.length ? infos[p.index]!.keySig : infos[infos.length - 1]!.keySig;
  };

  for (const item of items) {
    if (item.kind === 'ottava') {
      closeOttava(t);
      if (item.octaves !== 0) openLines.ottava = { octaves: item.octaves, start: t };
      continue;
    }
    if (item.kind === 'barCheck') {
      const p = position(t);
      if (!eq(p.offset, ZERO) && !eq(t, total))
        warnings.push(`bar check failed at character ${item.index}`);
      continue;
    }
    if (item.kind === 'measureRest') {
      // Rest to the next barline (a whole bar at a barline). Like every rest it overwrites.
      if (!ensure(add(t, rat(1, 1024)))) {
        warnings.push('text runs past the end of the score; truncated');
        break;
      }
      const p = position(t);
      const end = add(starts[p.index]!, lengths[p.index]!);
      commands.push({
        type: 'rest.enter',
        at: { staffId: at.staffId, voice: at.voice, measureId: p.measureId, offset: p.offset },
        duration: sub(end, t),
      });
      applyMarks(item.marks, t, null);
      t = end;
      pendingTie = false;
      continue;
    }
    let length = writtenLength(item.written);
    if (item.tuplet) {
      length = tupletActual(length, item.tuplet.actual, item.tuplet.normal);
      let open = tuplets.get(item.tuplet.group);
      if (!open) {
        const p = position(t);
        open = {
          id: ids.next('tu'),
          length: ZERO,
          actual: item.tuplet.actual,
          normal: item.tuplet.normal,
          measureId: p.measureId,
          offset: p.offset,
          measureIndex: p.index,
        };
        tuplets.set(item.tuplet.group, open);
      }
      open.length = add(open.length, length);
    }
    if (!ensure(add(t, length))) {
      warnings.push('text runs past the end of the score; truncated');
      break;
    }
    const p = position(t);
    const pos: ScorePosition = {
      staffId: at.staffId,
      voice: at.voice,
      measureId: p.measureId,
      offset: p.offset,
    };
    if (item.kind === 'rest') {
      commands.push({ type: 'rest.enter', at: pos, duration: length });
      pendingTie = false;
      applyMarks(item.marks, t, null);
    } else {
      const key = keyAtTime(t);
      const resolveChord = (notes: readonly TextNote[]): Pitch[] => {
        let ref = reference;
        const pitches: Pitch[] = [];
        notes.forEach((n, k) => {
          const resolved = resolvePitch(n, ref, key, keyRelative);
          pitches.push(resolved);
          ref = resolved;
          if (k === 0) reference = resolved;
        });
        return pitches;
      };
      // grace notes come first, also for the relative octave of the notes after them
      const gracePitches = (item.graces ?? []).map((g) => resolveChord(g.notes));
      const pitches = resolveChord(item.notes);
      const eventId = ids.next('e');
      eventIds.push(eventId);
      commands.push({
        type: 'note.enter',
        at: pos,
        duration: length,
        pitches,
        eventId,
        noteIds: pitches.map(() => ids.next('n')),
        ...(pendingTie ? { tieFromPrevious: true } : {}),
      });
      (item.graces ?? []).forEach((g, k) => {
        commands.push({
          type: 'grace.add',
          eventId,
          index: k,
          grace: {
            id: ids.next('gc'),
            ...(g.slash ? { slash: true } : {}),
            value: g.written.value,
            notes: gracePitches[k]!.map((pitch) => ({ id: ids.next('n'), pitch })),
          },
        });
      });
      const marks = item.marks;
      for (const articulation of marks?.articulations ?? [])
        commands.push({
          type: 'events.setArticulation',
          eventIds: [eventId],
          articulation,
          on: true,
        });
      if (marks && (marks.ornament || marks.tremolo || marks.arpeggio || marks.breath)) {
        commands.push({
          type: 'events.setProps',
          eventIds: [eventId],
          props: {
            ...(marks.ornament ? { ornament: marks.ornament } : {}),
            ...(marks.tremolo ? { tremolo: marks.tremolo } : {}),
            ...(marks.arpeggio ? { arpeggio: marks.arpeggio } : {}),
            ...(marks.breath ? { breath: marks.breath } : {}),
          },
        });
      }
      applyMarks(marks, t, eventId);
      pendingTie = item.tie;
    }
    t = add(t, length);
  }

  const prefix: Command[] = [];
  if (appended.length)
    prefix.push({ type: 'measures.insert', index: doc.measures.length, ids: appended });
  // Tuplet spans must exist before the notes inside them are entered.
  const tupletCommands: Command[] = [];
  for (const tu of tuplets.values()) {
    if (cmp(add(tu.offset, tu.length), lengths[tu.measureIndex]!) > 0) {
      warnings.push('a tuplet crosses a barline; it is entered without a tuplet bracket');
      continue;
    }
    tupletCommands.push({
      type: 'tuplet.create',
      at: { staffId: at.staffId, voice: at.voice, measureId: tu.measureId, offset: tu.offset },
      length: tu.length,
      actual: tu.actual,
      normal: tu.normal,
      id: tu.id,
    });
  }
  closeHairpin(t);
  closePedal(t);
  closeTrill(t);
  closeOttava(t);
  if (slurStack.length) warnings.push('a slur was started with ( but not ended with )');
  const end = position(t);
  return {
    commands: [...prefix, ...tupletCommands, ...commands, ...lineCommands],
    end: { staffId: at.staffId, voice: at.voice, measureId: end.measureId, offset: end.offset },
    warnings,
    eventIds,
  };
}

function previousPitch(doc: ScoreDoc, at: ScorePosition, t: Rational): Pitch | null {
  const infos = measureInfos(doc);
  for (let i = infos.length - 1; i >= 0; i--) {
    const info = infos[i]!;
    if (cmp(info.start, t) >= 0) continue;
    const events = doc.content[at.staffId]?.[info.measure.id]?.voices[at.voice] ?? [];
    for (let k = events.length - 1; k >= 0; k--) {
      const e = events[k]!;
      if (cmp(add(info.start, e.offset), t) < 0) return e.notes[0]!.pitch;
    }
  }
  return null;
}

/** Diatonic distance helper exported for tests. */
export const diatonicDistance = (a: Pitch, b: Pitch): number => diatonicOf(b) - diatonicOf(a);
