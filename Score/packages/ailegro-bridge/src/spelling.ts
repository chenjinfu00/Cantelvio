/**
 * Pitch spelling for music that arrives as MIDI numbers (AIlegro output): key-aware, and
 * chord-aware when a chord is known (so C-E-G# in an augmented chord is not spelled C-E-Ab).
 */
import {
  type KeySignature,
  type Pitch,
  type Step,
  STEPS,
  keyTonicPitchClass,
  spellMidi,
  stepSemitone,
} from '@ailegro-score/core';
import { chordToneSteps, qualityOf } from './qualities';

/** Key signature for a tonic pitch class and mode (0 major, 1 minor), fewest accidentals. */
export function keyFromTonic(tonic: number, mode: number, prefer?: KeySignature): KeySignature {
  const m: 'major' | 'minor' = mode === 1 ? 'minor' : 'major';
  if (
    prefer &&
    keyTonicPitchClass({ fifths: prefer.fifths, mode: m }) === ((tonic % 12) + 12) % 12
  ) {
    return { fifths: prefer.fifths, mode: m };
  }
  let best: KeySignature | null = null;
  for (let fifths = -7; fifths <= 7; fifths++) {
    if (keyTonicPitchClass({ fifths, mode: m }) !== ((tonic % 12) + 12) % 12) continue;
    if (
      !best ||
      Math.abs(fifths) < Math.abs(best.fifths) ||
      (Math.abs(fifths) === Math.abs(best.fifths) && fifths < 0)
    ) {
      best = { fifths, mode: m };
    }
  }
  return best ?? { fifths: 0, mode: m };
}

function pitchClassOf(step: Step, alter: number): number {
  return (((stepSemitone(step) + alter) % 12) + 12) % 12;
}

/** Spell a pitch class root in a key (e.g. root 10 in F major -> Bb). */
export function spellRoot(pc: number, key: KeySignature): { step: Step; alter: number } {
  const p = spellMidi(60 + (((pc % 12) + 12) % 12), key);
  return { step: p.step, alter: p.alter };
}

/**
 * Spell `midi`. If a chord (root pc + quality) is sounding and the note is one of its tones, the
 * note is spelled as that chord degree above the spelled root; otherwise by the key.
 */
export function spellNote(
  midi: number,
  key: KeySignature,
  chord?: { root: number; quality: string | number },
): Pitch {
  if (chord) {
    const quality = qualityOf(chord.quality);
    const rel = (((midi - chord.root) % 12) + 12) % 12;
    if (quality.intervals.includes(rel)) {
      const root = spellRoot(chord.root, key);
      const steps = chordToneSteps(rel, quality);
      const step = STEPS[(STEPS.indexOf(root.step) + steps) % 7]!;
      // alteration that makes the step sound at the right pitch class
      let alter = ((((midi % 12) - stepSemitone(step)) % 12) + 12) % 12;
      if (alter > 6) alter -= 12;
      if (Math.abs(alter) <= 2 && pitchClassOf(step, alter) === ((midi % 12) + 12) % 12) {
        const octave = Math.floor((midi - stepSemitone(step) - alter) / 12) - 1;
        return { step, alter, octave };
      }
    }
  }
  return spellMidi(midi, key);
}
