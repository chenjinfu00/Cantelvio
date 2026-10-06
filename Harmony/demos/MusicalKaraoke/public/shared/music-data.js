export const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
export const mod = (n, m = 12) => ((n % m) + m) % m;
export const pitchClass = ([i, j]) => mod(7 * i + 4 * j);

export const CHORDS = [
  { id: "C", quality: "major", notes: "C E G", pcs: [0, 4, 7], coords: [[0, 0], [0, 1], [1, 0]] },
  { id: "Cmaj7", quality: "major", notes: "C E G B", pcs: [0, 4, 7, 11], coords: [[0, 0], [0, 1], [1, 0], [1, 1]] },
  { id: "Cmaj9", quality: "major", notes: "C E G B D", pcs: [0, 4, 7, 11, 2], coords: [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]] },
  { id: "C7", quality: "tension", notes: "C E G B♭", pcs: [0, 4, 7, 10], coords: [[0, 0], [0, 1], [1, 0], [2, -1]] },
  { id: "Cm", quality: "minor", notes: "C E♭ G", pcs: [0, 3, 7], coords: [[0, 0], [1, -1], [1, 0]] },
  { id: "Cm7", quality: "minor", notes: "C E♭ G B♭", pcs: [0, 3, 7, 10], coords: [[0, 0], [1, -1], [1, 0], [2, -1]] },
  { id: "Cm9", quality: "minor", notes: "C E♭ G B♭ D", pcs: [0, 3, 7, 10, 2], coords: [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0]] },
  { id: "Cdim7", quality: "tension", notes: "C E♭ G♭ A", pcs: [0, 3, 6, 9], coords: [[0, 0], [1, -1], [2, -2], [3, -3]] }
];

export const PROGRESSIONS = [
  { romans: ["I", "IV", "V", "I"], chords: ["C", "F", "G", "C"] },
  { romans: ["I", "vi", "IV", "V", "I"], chords: ["C", "Am", "F", "G", "C"] },
  { romans: ["ii", "V", "I"], chords: ["Dm", "G", "C"] },
  { romans: ["ii7", "V7", "Imaj7"], chords: ["Dm7", "G7", "Cmaj7"] },
  { romans: ["I", "i", "♭VI"], chords: ["C", "Cm", "A♭"] },
  { romans: ["I", "V", "vi", "IV"], chords: ["C", "G", "Am", "F"] }
];

export const PRACTICE = {
  melody: {
    label: "Practice melody · not the concerto theme",
    mode: "classic",
    steps: [
      { midi: 62, name: "D4", beat: 1 }, { midi: 66, name: "F♯4", beat: 1 },
      { midi: 69, name: "A4", beat: 1 }, { midi: 71, name: "B4", beat: 1 },
      { midi: 69, name: "A4", beat: 1 }, { midi: 66, name: "F♯4", beat: 1 },
      { midi: 64, name: "E4", beat: 1 }, { midi: 62, name: "D4", beat: 2 }
    ]
  },
  harmony: {
    label: "Practice progression · C–a–F–G–C",
    mode: "harmonic",
    steps: [
      { name: "C", coords: [[0, 0], [0, 1], [1, 0]] },
      { name: "a", coords: [[0, 0], [0, 1], [-1, 1]] },
      { name: "F", coords: [[-1, 0], [-1, 1], [0, 0]] },
      { name: "G", coords: [[1, 0], [1, 1], [2, 0]] },
      { name: "C", coords: [[0, 0], [0, 1], [1, 0]] }
    ]
  }
};
