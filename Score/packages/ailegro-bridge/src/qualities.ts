/**
 * Cantelvio's chord-quality vocabulary, in Cantelvio's order (training/data/chord-qualities.json).
 * The ORDER matters: Cantelvio's sampler reports qualities as indices into this list.
 */
export interface ChordQuality {
  readonly id: string;
  readonly suffix: string;
  /** Semitones above the root, root first. */
  readonly intervals: readonly number[];
  readonly group: 'triad' | 'sixth' | 'seventh' | 'extension' | 'altered';
}

// prettier-ignore
export const CHORD_QUALITIES: readonly ChordQuality[] = [
  { id: 'maj', suffix: '', intervals: [0, 4, 7], group: 'triad' },
  { id: 'min', suffix: 'm', intervals: [0, 3, 7], group: 'triad' },
  { id: 'dim', suffix: 'dim', intervals: [0, 3, 6], group: 'triad' },
  { id: 'aug', suffix: 'aug', intervals: [0, 4, 8], group: 'triad' },
  { id: 'sus2', suffix: 'sus2', intervals: [0, 2, 7], group: 'triad' },
  { id: 'sus4', suffix: 'sus4', intervals: [0, 5, 7], group: 'triad' },
  { id: 'power', suffix: '5', intervals: [0, 7], group: 'triad' },
  { id: 'six', suffix: '6', intervals: [0, 4, 7, 9], group: 'sixth' },
  { id: 'min6', suffix: 'm6', intervals: [0, 3, 7, 9], group: 'sixth' },
  { id: 'six9', suffix: '6/9', intervals: [0, 4, 7, 9, 2], group: 'sixth' },
  { id: 'dom7', suffix: '7', intervals: [0, 4, 7, 10], group: 'seventh' },
  { id: 'maj7', suffix: 'maj7', intervals: [0, 4, 7, 11], group: 'seventh' },
  { id: 'min7', suffix: 'm7', intervals: [0, 3, 7, 10], group: 'seventh' },
  { id: 'minmaj7', suffix: 'mMaj7', intervals: [0, 3, 7, 11], group: 'seventh' },
  { id: 'dim7', suffix: 'dim7', intervals: [0, 3, 6, 9], group: 'seventh' },
  { id: 'half', suffix: 'ø7', intervals: [0, 3, 6, 10], group: 'seventh' },
  { id: 'sus7', suffix: '7sus4', intervals: [0, 5, 7, 10], group: 'seventh' },
  { id: 'sus27', suffix: '7sus2', intervals: [0, 2, 7, 10], group: 'seventh' },
  { id: 'add9', suffix: 'add9', intervals: [0, 4, 7, 2], group: 'extension' },
  { id: 'minadd9', suffix: 'madd9', intervals: [0, 3, 7, 2], group: 'extension' },
  { id: 'add11', suffix: 'add11', intervals: [0, 4, 7, 5], group: 'extension' },
  { id: 'dom9', suffix: '9', intervals: [0, 4, 7, 10, 2], group: 'extension' },
  { id: 'maj9', suffix: 'maj9', intervals: [0, 4, 7, 11, 2], group: 'extension' },
  { id: 'min9', suffix: 'm9', intervals: [0, 3, 7, 10, 2], group: 'extension' },
  { id: 'dom11', suffix: '11', intervals: [0, 4, 7, 10, 2, 5], group: 'extension' },
  { id: 'min11', suffix: 'm11', intervals: [0, 3, 7, 10, 2, 5], group: 'extension' },
  { id: 'dom13', suffix: '13', intervals: [0, 4, 7, 10, 2, 5, 9], group: 'extension' },
  { id: 'maj13', suffix: 'maj13', intervals: [0, 4, 7, 11, 2, 5, 9], group: 'extension' },
  { id: 'min13', suffix: 'm13', intervals: [0, 3, 7, 10, 2, 5, 9], group: 'extension' },
  { id: 'dom7b5', suffix: '7♭5', intervals: [0, 4, 6, 10], group: 'altered' },
  { id: 'dom7s5', suffix: '7♯5', intervals: [0, 4, 8, 10], group: 'altered' },
  { id: 'dom7b9', suffix: '7♭9', intervals: [0, 4, 7, 10, 1], group: 'altered' },
  { id: 'dom7s9', suffix: '7♯9', intervals: [0, 4, 7, 10, 3], group: 'altered' },
  { id: 'dom7s11', suffix: '7♯11', intervals: [0, 4, 7, 10, 6], group: 'altered' },
  { id: 'dom7b13', suffix: '7♭13', intervals: [0, 4, 7, 10, 8], group: 'altered' },
  { id: 'dom9s11', suffix: '9♯11', intervals: [0, 4, 7, 10, 2, 6], group: 'altered' },
  { id: 'dom13b9', suffix: '13♭9', intervals: [0, 4, 7, 10, 1, 9], group: 'altered' },
  { id: 'maj7s11', suffix: 'maj7♯11', intervals: [0, 4, 7, 11, 6], group: 'altered' },
  { id: 'maj9s11', suffix: 'maj9♯11', intervals: [0, 4, 7, 11, 2, 6], group: 'altered' },
  { id: 'minmaj9', suffix: 'mMaj9', intervals: [0, 3, 7, 11, 2], group: 'extension' },
];

const BY_ID = new Map(CHORD_QUALITIES.map((q, i) => [q.id, i]));

export function qualityIndex(id: string): number {
  const i = BY_ID.get(id);
  if (i === undefined) throw new Error(`unknown chord quality "${id}"`);
  return i;
}

export function qualityOf(idOrIndex: string | number): ChordQuality {
  const q =
    typeof idOrIndex === 'number'
      ? CHORD_QUALITIES[idOrIndex]
      : CHORD_QUALITIES[BY_ID.get(idOrIndex) ?? -1];
  if (!q) throw new Error(`unknown chord quality ${String(idOrIndex)}`);
  return q;
}

/** Diatonic steps above the root for a chord interval, read in the context of a quality. */
export function chordToneSteps(semitones: number, quality: ChordQuality): number {
  switch (semitones) {
    case 0:
      return 0;
    case 1:
      return 1; // b9
    case 2:
      return 1; // 9 / sus2
    case 3:
      // #9 in dominant chords that also have a major third, otherwise a minor third
      return quality.intervals.includes(4) ? 1 : 2;
    case 4:
      return 2;
    case 5:
      return 3; // sus4 / 11
    case 6:
      // #11 when a perfect fifth is present, otherwise a diminished fifth
      return quality.intervals.includes(7) ? 3 : 4;
    case 7:
      return 4;
    case 8:
      // b13 when a perfect fifth is present, otherwise an augmented fifth
      return quality.intervals.includes(7) ? 5 : 4;
    case 9:
      return quality.id === 'dim7' ? 6 : 5; // diminished seventh or sixth/13th
    case 10:
    case 11:
      return 6;
    default:
      return Math.round((semitones * 7) / 12);
  }
}
