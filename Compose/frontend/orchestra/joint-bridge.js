/** A reversible listening prototype: joint R/H/B/M notes, routed to six groups.
 * This is deterministic orchestration, NOT a trained orchestration model. */
import {Composer, mod12} from '../src/composer.js';
import {renderBar} from '../src/render.js';
import {ORCHESTRA_GROUP_IDS, routeJointBar} from '../src/orchestration.js';
import {styleOf} from '../src/instruments.js';
import {chordEntry, chordLabel} from '../src/voicing.js';
import {QUALITIES} from '../vendor/lib/chord-vocabulary.js';

export const JOINT_GROUPS = ORCHESTRA_GROUP_IDS;
export {routeJointBar};

function rng(seed) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function nearestChordMelody(chord) {
  const tones = QUALITIES[chord.q].intervals.map(n => mod12(chord.root + n));
  return Array.from({length: 17}, (_, i) => 60 + i)
    .filter(n => tones.includes(mod12(n)))
    .sort((a, b) => Math.abs(a - 67) - Math.abs(b - 67))[0];
}

export class JointOrchestraBridge {
  constructor({seed = 41977, style = 'lieder', key = 0, mode = 'major',
    harmonyT = .8, melodyT = .8, density = .5, changeMode = 'free'} = {}) {
    this.seed = seed;
    this.fixed = {style, key, mode, harmonyT, melodyT, density, changeMode};
    this.random = rng(seed);
    this.composer = new Composer({random: this.random, planBar: (index, previous) => {
      const s = styleOf(this.fixed.style);
      return {cond: {scene: 'joint-orchestra', style: s.id, domain: s.domain, styleId: s.styleId,
        harmonyT: this.fixed.harmonyT, melodyT: this.fixed.melodyT, density: this.fixed.density,
        beats: 4, mode: 'auto', changeMode: this.fixed.changeMode},
      key: previous?.key ?? {tonic: this.fixed.key, mode: this.fixed.mode}, keyAge: 0};
    }});
    const chord = {root: key, q: mode === 'minor' ? 1 : 0};
    this.composer.reset({key: {tonic: key, mode}, chord, melody: nearestChordMelody(chord)});
    this.nextBar = 0;
    this.voicing = [];
  }

  async next(bars, {tempo = 96, groups = {}} = {}) {
    if (!Number.isInteger(bars) || bars < 1 || bars > 16) throw new RangeError('bars must be 1–16');
    if (!Number.isFinite(tempo) || tempo < 40 || tempo > 200) throw new RangeError('tempo must be 40–200 BPM');
    const c = this.composer, firstBar = this.nextBar;
    // One lookahead bar gives bass/melody releases at the segment boundary.
    if (!await c.prefetch(firstBar + bars + 1)) throw new Error('Joint timeline was replaced');
    const notes = [], harmony = [], barEvents = [];
    for (let local = 0; local < bars; local++) {
      const index = firstBar + local;
      const plan = renderBar({composer: c, index, state: {bpm: tempo, groove: 'straight', feel: .4,
        chordInstrument: 'piano', bassInstrument: 'piano', melodyInstrument: 'piano', bassOn: true, melodyOn: true},
      bpm: tempo, voicing: this.voicing});
      plan.bpm = tempo;
      this.voicing = plan.voicing;
      const offset = local * 4;
      for (const note of routeJointBar(plan, groups, this.seed, index)) notes.push({...note, quarter: note.quarter + offset});
      harmony.push(c.chordSpans(index).map(span => {
        const entry = chordEntry(span.chord.root, span.chord.q, span.onsetBass);
        return {name: chordLabel(span.chord.root, span.chord.q, entry.inversion ? span.onsetBass : null, span.key),
          startBeat: (span.step - c.bars[index].start) / 4, lengthBeats: span.length / 4};
      }));
      barEvents.push({quarter: offset, bpm: tempo});
      c.lock(index);
    }
    this.nextBar += bars;
    notes.sort((a, b) => a.quarter - b.quarter || a.pitch - b.pitch);
    return {seed: this.seed, firstBar, bars, totalQuarters: bars * 4, barEvents, notes, harmony,
      provenance: 'joint-v1 R/H/B/M + deterministic six-group orchestration (untrained)'};
  }
}
