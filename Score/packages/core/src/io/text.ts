/**
 * AIlegro text notation (v0): a compact, LilyPond-inspired way to type music, used by the editor's
 * text input mode, by tests and fixtures, and as an easy format for language models to write.
 *
 *   c d e f | g2 g2 | a4 a a a | g1          relative octaves, durations carry over
 *   c'4 d, e8. f16 g4~ g8 r8 <c e g>2 R     ' up an octave, , down; ~ tie; r rest; R rest to barline
 *                                            (rests overwrite like notes)
 *   3{ c8 d e } f#4 bb4 en4                  tuplets; # ## b bb accidentals, n forces a natural
 *
 * Pitches are chosen like LilyPond's relative mode: each note goes to the octave closest to the
 * previous note (within a fourth); in a chord the reference is the previous chord note and after
 * the chord it is the chord's first note. By default letters follow the key signature (in G major
 * `f` is F#), as with keyboard input; `n` writes a natural. `|` is an optional bar check.
 */
import { type Command } from '../commands/types';
import { type IdGenerator } from '../model/ids';
import { clefAt, locate, measureInfo, measureInfos, scoreLength, staffInfo } from '../model/query';
import { middleLinePitch } from '../model/clef';
import type { ID, ScoreDoc, ScorePosition } from '../model/types';
import {
  type KeySignature,
  type Pitch,
  type Step,
  diatonicOf,
  keyAlter,
  nearestPitchForStep,
} from '../pitch/pitch';
import {
  type NoteValue,
  type WrittenDuration,
  writtenLength,
  tupletActual,
} from '../time/duration';
import { type Rational, add, cmp, eq, rat, sub, ZERO } from '../time/rational';

export interface TextNote {
  readonly step: Step;
  /** Explicit alteration, or null to use the key signature. */
  readonly alter: number | null;
  readonly octaveShift: number;
}

export type TextItem =
  | {
      readonly kind: 'note';
      readonly notes: readonly TextNote[];
      readonly written: WrittenDuration;
      readonly tie: boolean;
      readonly tuplet?: TextTuplet;
    }
  | { readonly kind: 'rest'; readonly written: WrittenDuration; readonly tuplet?: TextTuplet }
  | { readonly kind: 'measureRest' }
  | { readonly kind: 'barCheck'; readonly index: number };

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

  while (true) {
    skipSpace();
    if (i >= text.length) break;
    const c = peek();
    const at = i;
    if (c === '|') {
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
    } else if (c === 'R') {
      i++;
      items.push({ kind: 'measureRest' });
    } else if (c === 'r') {
      i++;
      const written = readDuration();
      items.push(tuplet ? { kind: 'rest', written, tuplet } : { kind: 'rest', written });
    } else if (c === '<') {
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
      const written = readDuration();
      const tie = peek() === '~';
      if (tie) i++;
      items.push(
        tuplet
          ? { kind: 'note', notes, written, tie, tuplet }
          : { kind: 'note', notes, written, tie },
      );
    } else if (/[a-gA-G]/.test(c)) {
      const note = readNote();
      const written = readDuration();
      const tie = peek() === '~';
      if (tie) i++;
      items.push(
        tuplet
          ? { kind: 'note', notes: [note], written, tie, tuplet }
          : { kind: 'note', notes: [note], written, tie },
      );
    } else {
      throw new TextNotationError(`unexpected "${c}"`, at);
    }
  }
  if (tuplet) throw new TextNotationError('unterminated tuplet', text.length);
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
  staffInfo(doc, at.staffId); // throws for unknown staff
  let pendingTie = false;
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
    } else {
      const key = keyAtTime(t);
      let ref = reference;
      const pitches: Pitch[] = [];
      item.notes.forEach((n, k) => {
        const resolved = resolvePitch(n, ref, key, keyRelative);
        pitches.push(resolved);
        ref = resolved;
        if (k === 0) reference = resolved;
      });
      if (item.notes.length === 1) reference = pitches[0]!;
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
  const end = position(t);
  return {
    commands: [...prefix, ...tupletCommands, ...commands],
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
