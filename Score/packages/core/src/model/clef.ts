import { type Pitch, diatonicOf, pitchFromDiatonic } from '../pitch/pitch';

export const CLEF_TYPES = [
  'treble',
  'treble8vb',
  'treble8va',
  'bass',
  'bass8vb',
  'alto',
  'tenor',
  'soprano',
  'percussion',
] as const;
export type ClefType = (typeof CLEF_TYPES)[number];

export interface ClefInfo {
  readonly sign: 'G' | 'F' | 'C' | 'percussion';
  /** Staff line the clef sits on, 1 = bottom line of a 5-line staff. */
  readonly line: number;
  /** -1 for "8vb" clefs, +1 for "8va". */
  readonly octaveChange: number;
  /** Diatonic number (C4 = 28) of the pitch on the TOP line. */
  readonly topLineDiatonic: number;
}

const REFERENCE_DIATONIC = {
  G: 32 /* G4 */,
  F: 24 /* F3 */,
  C: 28 /* C4 */,
  percussion: 32,
} as const;

function info(sign: ClefInfo['sign'], line: number, octaveChange = 0): ClefInfo {
  const ref = REFERENCE_DIATONIC[sign] + octaveChange * 7;
  return { sign, line, octaveChange, topLineDiatonic: ref + (5 - line) * 2 };
}

export const CLEFS: Readonly<Record<ClefType, ClefInfo>> = {
  treble: info('G', 2),
  treble8vb: info('G', 2, -1),
  treble8va: info('G', 2, 1),
  bass: info('F', 4),
  bass8vb: info('F', 4, -1),
  alto: info('C', 3),
  tenor: info('C', 4),
  soprano: info('C', 1),
  percussion: info('percussion', 3),
};

/**
 * Staff position of a pitch in half staff-spaces below the top line:
 * 0 = top line, 1 = first space, ..., 8 = bottom line; negative = above the staff.
 */
export function staffPosition(p: Pitch, clef: ClefType): number {
  return CLEFS[clef].topLineDiatonic - diatonicOf(p);
}

/** Natural pitch at a staff position (used for mouse input and rest placement). */
export function pitchAtPosition(position: number, clef: ClefType, alter = 0): Pitch {
  return pitchFromDiatonic(CLEFS[clef].topLineDiatonic - position, alter);
}

/** Pitch on the middle line: the default reference for the first note entered on a staff. */
export function middleLinePitch(clef: ClefType): Pitch {
  return pitchAtPosition(4, clef);
}
