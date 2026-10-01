/**
 * Spelled pitches and intervals.
 *
 * Notes in the score store their CONCERT (sounding) pitch with an explicit spelling
 * (step + alteration + octave). Written pitch for transposing instruments is derived by
 * diatonic transposition, so spelling stays musically correct (concert Bb -> written C for a
 * Bb clarinet). Octaves follow scientific pitch notation: C4 = middle C = MIDI 60.
 */

export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
export type Step = (typeof STEPS)[number];

const STEP_SEMITONES: Readonly<Record<Step, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export interface Pitch {
  readonly step: Step;
  /** Chromatic alteration in semitones: -2 (double flat) ... +2 (double sharp). */
  readonly alter: number;
  readonly octave: number;
}

export function pitch(step: Step, alter = 0, octave = 4): Pitch {
  return { step, alter, octave };
}

export const stepIndex = (step: Step): number => STEPS.indexOf(step);
export const stepSemitone = (step: Step): number => STEP_SEMITONES[step];

/** MIDI note number (C4 = 60). */
export function midiOf(p: Pitch): number {
  return (p.octave + 1) * 12 + STEP_SEMITONES[p.step] + p.alter;
}

/** Diatonic number: C0 = 0, D0 = 1, ..., C4 = 28. Staff positions are derived from this. */
export function diatonicOf(p: Pitch): number {
  return p.octave * 7 + stepIndex(p.step);
}

export function pitchFromDiatonic(diatonic: number, alter = 0): Pitch {
  const octave = Math.floor(diatonic / 7);
  const step = STEPS[((diatonic % 7) + 7) % 7]!;
  return { step, alter, octave };
}

export function pitchEquals(a: Pitch, b: Pitch): boolean {
  return a.step === b.step && a.alter === b.alter && a.octave === b.octave;
}

export function comparePitch(a: Pitch, b: Pitch): number {
  return midiOf(a) - midiOf(b) || diatonicOf(a) - diatonicOf(b);
}

const ALTER_TEXT: Record<number, string> = { [-2]: 'bb', [-1]: 'b', 0: '', 1: '#', 2: '##' };

/** "C#4", "Bb3", "F##5". */
export function pitchName(p: Pitch): string {
  return `${p.step}${ALTER_TEXT[p.alter] ?? `(${p.alter})`}${p.octave}`;
}

/** Parse "C#4", "Bb3", "Ebb2", "F##5" (also accepts "x" for double sharp). */
export function parsePitch(text: string): Pitch {
  const m = /^\s*([A-Ga-g])(##|x|#|bb|b)?(-?\d+)\s*$/.exec(text);
  if (!m) throw new SyntaxError(`not a pitch name: "${text}"`);
  const step = m[1]!.toUpperCase() as Step;
  const acc = m[2] ?? '';
  const alter =
    acc === '#' ? 1 : acc === '##' || acc === 'x' ? 2 : acc === 'b' ? -1 : acc === 'bb' ? -2 : 0;
  return { step, alter, octave: Number(m[3]) };
}

// ---------------------------------------------------------------------------------- intervals

/**
 * An interval as (diatonic steps, semitones). Major second up = {1, 2}; perfect fifth down =
 * {-4, -7}; octave = {7, 12}. Used for transposition so spelling is preserved.
 */
export interface Interval {
  readonly diatonic: number;
  readonly chromatic: number;
}

export const interval = (diatonic: number, chromatic: number): Interval => ({
  diatonic,
  chromatic,
});
export const UNISON: Interval = interval(0, 0);
export const OCTAVE: Interval = interval(7, 12);
export const invertInterval = (i: Interval): Interval => interval(-i.diatonic, -i.chromatic);
export const isUnison = (i: Interval): boolean => i.diatonic === 0 && i.chromatic === 0;

export function transpose(p: Pitch, by: Interval): Pitch {
  const target = pitchFromDiatonic(diatonicOf(p) + by.diatonic, 0);
  const wantedMidi = midiOf(p) + by.chromatic;
  return { ...target, alter: wantedMidi - midiOf(target) };
}

/** Interval from a to b (b - a). */
export function intervalBetween(a: Pitch, b: Pitch): Interval {
  return interval(diatonicOf(b) - diatonicOf(a), midiOf(b) - midiOf(a));
}

// ---------------------------------------------------------------------------------- keys

/** Key signature: number of sharps (>0) or flats (<0); mode is informational. */
export interface KeySignature {
  readonly fifths: number;
  readonly mode?: 'major' | 'minor';
}

const SHARP_ORDER: readonly Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER: readonly Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

export function sharpOrder(): readonly Step[] {
  return SHARP_ORDER;
}
export function flatOrder(): readonly Step[] {
  return FLAT_ORDER;
}

/** Alteration the key signature applies to a step (e.g. F in G major -> +1). */
export function keyAlter(fifths: number, step: Step): number {
  if (fifths > 0) {
    const sharps = SHARP_ORDER.slice(0, Math.min(fifths, 7));
    const doubles = fifths > 7 ? SHARP_ORDER.slice(0, fifths - 7) : [];
    return (sharps.includes(step) ? 1 : 0) + (doubles.includes(step) ? 1 : 0);
  }
  if (fifths < 0) {
    const flats = FLAT_ORDER.slice(0, Math.min(-fifths, 7));
    const doubles = -fifths > 7 ? FLAT_ORDER.slice(0, -fifths - 7) : [];
    return -(flats.includes(step) ? 1 : 0) - (doubles.includes(step) ? 1 : 0) || 0; // never -0
  }
  return 0;
}

/** Tonic of the major key with this many fifths (0 -> C, 1 -> G, -1 -> F). */
export function majorTonic(fifths: number): { step: Step; alter: number } {
  // Walk the line of fifths from C.
  const p = transpose(pitch('C', 0, 4), interval(4 * fifths, 7 * fifths));
  return { step: p.step, alter: p.alter };
}

export function keyTonic(key: KeySignature): { step: Step; alter: number } {
  if (key.mode === 'minor') {
    const major = majorTonic(key.fifths);
    const p = transpose(pitch(major.step, major.alter, 4), interval(-2, -3));
    return { step: p.step, alter: p.alter };
  }
  return majorTonic(key.fifths);
}

/** Pitch class (0..11) of the key's tonic. */
export function keyTonicPitchClass(key: KeySignature): number {
  const t = keyTonic(key);
  return (((STEP_SEMITONES[t.step] + t.alter) % 12) + 12) % 12;
}

/** Position of a spelled pitch class on the line of fifths (C = 0, G = 1, F = -1, F# = 6). */
export function lineOfFifths(step: Step, alter: number): number {
  const base: Record<Step, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
  return base[step] + 7 * alter;
}

/** Spelled pitch class from a line-of-fifths position. */
export function fromLineOfFifths(pos: number): { step: Step; alter: number } {
  const order: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const idx = pos + 1; // F = -1 -> 0
  const step = order[((idx % 7) + 7) % 7]!;
  const alter = Math.floor(idx / 7);
  return { step, alter };
}

/**
 * Transpose a key signature (e.g. concert key -> written key of a Bb instrument). Keys beyond
 * 7 accidentals are respelled enharmonically (e.g. 8 sharps -> 4 flats), as engravers do.
 */
export function transposeKey(key: KeySignature, by: Interval): KeySignature {
  const tonic = majorTonic(key.fifths);
  const moved = transpose(pitch(tonic.step, tonic.alter, 4), by);
  let fifths = lineOfFifths(moved.step, moved.alter);
  if (fifths > 7) fifths -= 12;
  if (fifths < -7) fifths += 12;
  return key.mode ? { fifths, mode: key.mode } : { fifths };
}

/**
 * Spell a MIDI pitch. Diatonic notes of the key keep the key's spelling; chromatic notes use the
 * key's accidental direction (sharps in sharp keys, flats in flat keys), or `prefer` if given.
 */
export function spellMidi(
  midi: number,
  key: KeySignature = { fifths: 0 },
  prefer?: 'sharp' | 'flat',
): Pitch {
  const pc = ((midi % 12) + 12) % 12;
  // Diatonic match first.
  for (const step of STEPS) {
    const alter = keyAlter(key.fifths, step);
    if ((((STEP_SEMITONES[step] + alter) % 12) + 12) % 12 === pc) {
      return withOctave(step, alter, midi);
    }
  }
  const direction = prefer ?? (key.fifths < 0 ? 'flat' : 'sharp');
  for (const step of STEPS) {
    const alter = direction === 'sharp' ? 1 : -1;
    if ((((STEP_SEMITONES[step] + alter) % 12) + 12) % 12 === pc) {
      return withOctave(step, alter, midi);
    }
  }
  // Unreachable for 12-TET input, kept for type safety.
  return withOctave('C', 0, midi);
}

function withOctave(step: Step, alter: number, midi: number): Pitch {
  // octave such that midiOf({step, alter, octave}) === midi
  const octave = Math.floor((midi - STEP_SEMITONES[step] - alter) / 12) - 1;
  return { step, alter, octave };
}

/**
 * The pitch with the given step (altered by the key signature unless `alter` is given) closest to
 * `reference`. This is how letter-key note input chooses the octave (like MuseScore/Sibelius).
 */
export function nearestPitchForStep(
  step: Step,
  reference: Pitch,
  key: KeySignature,
  alter?: number,
): Pitch {
  const a = alter ?? keyAlter(key.fifths, step);
  const refMidi = midiOf(reference);
  let best: Pitch | null = null;
  for (let octave = reference.octave - 1; octave <= reference.octave + 1; octave++) {
    const candidate: Pitch = { step, alter: a, octave };
    if (!best) {
      best = candidate;
      continue;
    }
    const dCand = Math.abs(diatonicOf(candidate) - diatonicOf(reference));
    const dBest = Math.abs(diatonicOf(best) - diatonicOf(reference));
    if (
      dCand < dBest ||
      (dCand === dBest && Math.abs(midiOf(candidate) - refMidi) < Math.abs(midiOf(best) - refMidi))
    ) {
      best = candidate;
    }
  }
  return best!;
}

/**
 * Move a pitch by one semitone, respelling sensibly: diatonic key notes are preferred; otherwise
 * raising uses sharps and lowering uses flats (in C major) or the key's direction.
 */
export function moveBySemitone(p: Pitch, direction: 1 | -1, key: KeySignature): Pitch {
  const target = midiOf(p) + direction;
  const prefer =
    key.fifths > 0 ? 'sharp' : key.fifths < 0 ? 'flat' : direction > 0 ? 'sharp' : 'flat';
  return spellMidi(target, key, prefer);
}
