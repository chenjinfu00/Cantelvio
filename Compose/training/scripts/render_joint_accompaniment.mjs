// Render accompaniment (chord texture + bass) for synthetic joint-model phrases
// with AIlegro's own rule planner (src/planner.js → frozen v91 buildBarEvents).
// Since 2026-09-27 that planner is archived with the pre-joint runtime; the import
// points there so the synthetic corpus can be rebuilt exactly as before.
// Input: JSON array of phrase specs. Output: the same specs with `events`.
// Usage: node training/scripts/render_joint_accompaniment.mjs specs.json out.json
import { readFileSync, writeFileSync } from 'node:fs';
import { planHarmonyTimeline } from '../../archive/pre-joint-runtime-20260927/src/planner.js';
import { CHORD_VOCAB } from '../../archive/pre-joint-runtime-20260927/vendor/lib/chord-vocabulary.js';

const [input, output] = process.argv.slice(2);
const specs = JSON.parse(readFileSync(input, 'utf8'));
const BPM = 120, SPB = 60 / BPM;
const idFor = (root, q, inv) => {
  const c = CHORD_VOCAB.find(x => x.baseIndex === q * 12 + root && x.inversion === inv)
    || CHORD_VOCAB.find(x => x.baseIndex === q * 12 + root && x.inversion === 0);
  return c.id;
};

for (const spec of specs) {
  const beatsPerBar = spec.meter / 4;
  const state = {
    bpm: BPM, rhythm: spec.rhythm, accompanimentStyle: spec.accStyle, texture: spec.texture,
    chordInstrument: 'piano', bassOn: true, bassInstrument: spec.bassInstrument, bassPattern: spec.bassPattern, feel: 0.65,
  };
  const key = { tonic: spec.tonic, mode: spec.mode ? 'minor' : 'major' };
  // Chord segments in beats; split at barlines like the app's per-bar planning.
  const chords = spec.chords.map((c, i) => ({ ...c, id: idFor(c.root, c.q, c.inv), uid: i + 1 }));
  const events = [];
  let previous = [];
  for (let bar = 0; bar < spec.bars; bar++) {
    const b0 = bar * beatsPerBar, b1 = b0 + beatsPerBar, segments = [];
    chords.forEach((c, i) => {
      const s = c.startStep / 4, e = (c.startStep + c.lengthSteps) / 4;
      const start = Math.max(s, b0), end = Math.min(e, b1);
      if (end > start) {
        const next = chords[i + 1] ?? c;
        segments.push({ slot: { id: c.id, uid: c.uid, key }, nextSlot: { id: next.id, uid: next.uid, key }, startBeat: start - b0, lengthBeats: end - start });
      }
    });
    if (!segments.length) continue;
    const plan = planHarmonyTimeline(segments, state, bar, previous);
    previous = plan.chord;
    for (const ev of plan.events) {
      let beat = ev.beat;
      const frac = beat - Math.floor(beat);
      if (Math.abs(frac - 2 / 3) < 0.05) beat = Math.floor(beat) + 0.5;  // notate swing as straight eighths
      events.push({ beat: b0 + beat, beats: Math.max(0.25, ev.duration / SPB), midi: ev.midi, role: ev.role === 'bass' ? 'bass' : 'harmony' });
    }
  }
  spec.events = events;
}
writeFileSync(output, JSON.stringify(specs));
console.log(JSON.stringify({ phrases: specs.length, events: specs.reduce((n, s) => n + s.events.length, 0) }));
