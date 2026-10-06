const ROOTS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const SHAPES = [
  {suffix: '', tones: [0, 4, 7]},
  {suffix: 'm', tones: [0, 3, 7]},
  {suffix: '7', tones: [0, 4, 7, 10]},
  {suffix: 'maj7', tones: [0, 4, 7, 11]},
  {suffix: 'm7', tones: [0, 3, 7, 10]},
  {suffix: 'dim', tones: [0, 3, 6]},
  {suffix: 'sus4', tones: [0, 5, 7]},
];

export function estimateHarmony(sample) {
  return sample.barEvents.map((bar, index) => {
    const start = bar.quarter;
    const end = index + 1 < sample.barEvents.length ? sample.barEvents[index + 1].quarter : sample.totalQuarters;
    const notes = sample.notes.filter(note => !note.drum && note.quarter < end && note.quarter + note.duration > start);
    const profile = Array(12).fill(0);
    for (const note of notes) {
      const overlap = Math.min(end, note.quarter + note.duration) - Math.max(start, note.quarter);
      const weight = Math.min(2, overlap) * (.6 + note.velocity / 127);
      profile[note.pitch % 12] += weight;
    }
    const total = profile.reduce((a, b) => a + b, 0);
    const distinct = profile.filter(value => value > 0).length;
    if (!total || distinct < 2) return {name: '—', confidence: 'none', notes: notes.length};
    const bass = notes.reduce((lowest, note) => Math.min(lowest, note.pitch), 127) % 12;
    let best = {score: -Infinity, name: '—'};
    for (let root = 0; root < 12; root++) for (const shape of SHAPES) {
      const members = new Set(shape.tones.map(tone => (root + tone) % 12));
      const inside = profile.reduce((sum, weight, pc) => sum + (members.has(pc) ? weight : 0), 0);
      const rootWeight = profile[root];
      const score = inside / total + .12 * rootWeight / total + (bass === root ? .08 : 0)
        - .035 * (shape.tones.length - 3);
      if (score > best.score) best = {score, name: `${ROOTS[root]}${shape.suffix}`};
    }
    return {name: best.name, confidence: distinct < 3 || best.score < .68 ? 'low' : 'estimated', notes: notes.length};
  });
}
