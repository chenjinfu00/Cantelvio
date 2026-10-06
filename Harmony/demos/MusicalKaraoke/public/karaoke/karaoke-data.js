import { CHORDS, pitchClass, PROGRESSIONS } from "../shared/music-data.js";

export const VOICE_PARTS = Object.freeze([
  { id: "1", midis: [48, 47, 48, 48], notes: ["C", "B", "C", "C"] },
  { id: "2", midis: [52, 50, 52, 53], notes: ["E", "D", "E", "F"] },
  { id: "3", midis: [55, 55, 57, 57], notes: ["G", "G", "A", "A"] }
]);

export const KARAOKE_PROGRESSIONS = Object.freeze([
  PROGRESSIONS[5], ...PROGRESSIONS.slice(1, 5), PROGRESSIONS[0],
  Object.freeze({ romans: Object.freeze(["IV", "V", "♭VI", "♭VII", "I"]), chords: Object.freeze(["F", "G", "A♭", "B♭", "C"]) }),
  Object.freeze({ romans: Object.freeze(["IV", "V", "iii", "vi", "ii", "V", "I"]), chords: Object.freeze(["F", "G", "Em", "Am", "Dm", "G", "C"]) })
]);
export const FINAL_CADENCE = Object.freeze({
  chords: ["F", "G7", "C"], romans: ["IV", "V7", "I"],
  // Four voices: soprano A4–B4–C5; seventh F4–E4; root-position V7–I.
  midis: [[41, 57, 60, 69], [43, 62, 65, 71], [48, 55, 64, 72]]
});

export const CHORD_SHAPES = Object.freeze({
  C: { coords: [[0, 0], [0, 1], [1, 0]], midis: [60, 64, 67], quality: "major" },
  F: { coords: [[-1, 0], [-1, 1], [0, 0]], midis: [53, 57, 60], quality: "major" },
  G: { coords: [[1, 0], [1, 1], [2, 0]], midis: [55, 59, 62], quality: "major" },
  Am: { coords: [[-1, 1], [0, 0], [0, 1]], midis: [57, 60, 64], quality: "minor" },
  Em: { coords: [[0, 1], [1, 0], [1, 1]], midis: [52, 55, 59], quality: "minor" },
  Dm: { coords: [[2, 0], [3, 0], [3, -1]], midis: [50, 53, 57], quality: "minor" },
  Dm7: { coords: [[2, 0], [3, 0], [3, -1], [4, -1]], midis: [50, 53, 57, 60], quality: "minor" },
  G7: { coords: [[1, 0], [1, 1], [2, 0], [3, -1]], midis: [55, 59, 62, 65], quality: "tension" },
  Cmaj7: { coords: [[0, 0], [0, 1], [1, 0], [1, 1]], midis: [60, 64, 67, 71], quality: "major" },
  Cmaj9: { coords: [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]], midis: [60, 64, 67, 71, 74], quality: "major" },
  C7: { coords: [[0, 0], [0, 1], [1, 0], [2, -1]], midis: [60, 64, 67, 70], quality: "tension" },
  Cm: { coords: [[0, 0], [1, -1], [1, 0]], midis: [60, 63, 67], quality: "minor" },
  Cm7: { coords: [[0, 0], [1, -1], [1, 0], [2, -1]], midis: [60, 63, 67, 70], quality: "minor" },
  Cm9: { coords: [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0]], midis: [60, 63, 67, 70, 74], quality: "minor" },
  Cdim7: { coords: [[0, 0], [1, -1], [2, -2], [3, -3]], midis: [60, 63, 66, 69], quality: "tension" },
  "A♭": { coords: [[0, -1], [1, -1], [0, 0]], midis: [56, 60, 63], quality: "major" },
  "B♭": { coords: [[2, -1], [2, 0], [3, -1]], midis: [58, 62, 65], quality: "major" }
});

export const CHORD_DEMOS = Object.freeze(CHORDS.map((chord) => Object.freeze({ ...chord })));
export const HARMONIC_CHORDS = Object.freeze(["C", "G", "Am", "F", "Dm", "G7"]);
export const CLASSIC_CHORDS = Object.freeze(["C", "G", "Am", "F", "Dm", "G7"]);
export const CLASSIC_VOICINGS = Object.freeze({
  C: [60, 64, 67], G: [55, 59, 62], Am: [57, 60, 64],
  F: [53, 57, 60], Dm: [50, 53, 57], G7: [55, 59, 62, 65]
});

export const CHROMATIC_LABELS = Object.freeze(["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]);
export const FIFTH_LABELS = Object.freeze(["C", "G", "D", "A", "E", "B", "F♯", "C♯", "A♭", "E♭", "B♭", "F"]);
export const FIFTH_PCS = Object.freeze(FIFTH_LABELS.map((_, index) => (index * 7) % 12));
export const TONNETZ_CELL = Object.freeze(
  Array.from({ length: 3 }, (_, j) => Array.from({ length: 4 }, (_, i) => Object.freeze({ i, j, pc: pitchClass([i, j]) }))).flat()
);
export const PERIOD_VECTORS = Object.freeze([[0, 3], [4, -1]]);

export const translatedCell = (a = 0, b = 0) => TONNETZ_CELL.map(({ i, j, pc }) => ({
  i: i + a * PERIOD_VECTORS[0][0] + b * PERIOD_VECTORS[1][0],
  j: j + a * PERIOD_VECTORS[0][1] + b * PERIOD_VECTORS[1][1], pc
}));

export const midiPitchClasses = (midis) => midis.map((midi) => ((midi % 12) + 12) % 12);
export const validateShape = (shape) => {
  const coordinates = shape.coords.map(pitchClass).sort((a, b) => a - b);
  const pitches = midiPitchClasses(shape.midis).sort((a, b) => a - b);
  return coordinates.length === pitches.length && coordinates.every((pc, index) => pc === pitches[index]);
};

export const PURE_FIFTH_RATIO = 3 / 2;
export const EQUAL_FIFTH_RATIO = 2 ** (7 / 12);
export const PYTHAGOREAN_COMMA_CENTS = 1200 * Math.log2((PURE_FIFTH_RATIO ** 12) / (2 ** 7));
export function foldedFifths(ratio, count = 12, base = 261.625565) {
  return Array.from({ length: count + 1 }, (_, n) => {
    const rawRatio = ratio ** n;
    return base * rawRatio / (2 ** Math.floor(Math.log2(rawRatio)));
  });
}
