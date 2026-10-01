import { describe, expect, it } from 'vitest';
import { staffPosition } from '../model/clef';
import {
  interval,
  keyAlter,
  keyTonic,
  midiOf,
  moveBySemitone,
  nearestPitchForStep,
  parsePitch,
  pitchName,
  spellMidi,
  transpose,
  transposeKey,
} from './pitch';

const p = parsePitch;

describe('pitch', () => {
  it('converts to MIDI', () => {
    expect(midiOf(p('C4'))).toBe(60);
    expect(midiOf(p('A0'))).toBe(21);
    expect(midiOf(p('B#3'))).toBe(60);
    expect(midiOf(p('Cb4'))).toBe(59);
  });

  it('transposes with correct spelling', () => {
    // Concert -> written for a Bb clarinet: up a major second.
    expect(pitchName(transpose(p('Bb4'), interval(1, 2)))).toBe('C5');
    expect(pitchName(transpose(p('F#4'), interval(1, 2)))).toBe('G#4');
    expect(pitchName(transpose(p('C4'), interval(-4, -7)))).toBe('F3');
    expect(pitchName(transpose(p('E4'), interval(2, 3)))).toBe('G4');
  });

  it('handles keys', () => {
    expect(keyAlter(2, 'C')).toBe(1);
    expect(keyAlter(2, 'G')).toBe(0);
    expect(keyAlter(-3, 'A')).toBe(-1);
    expect(keyTonic({ fifths: -3 })).toEqual({ step: 'E', alter: -1 });
    expect(keyTonic({ fifths: 1, mode: 'minor' })).toEqual({ step: 'E', alter: 0 });
    expect(transposeKey({ fifths: 0 }, interval(1, 2))).toEqual({ fifths: 2 });
    expect(transposeKey({ fifths: -5 }, interval(1, 2))).toEqual({ fifths: -3 });
    // Concert B major for a Bb instrument would be C# major (7 sharps) - kept; 8+ is respelled.
    expect(transposeKey({ fifths: 6 }, interval(1, 2))).toEqual({ fifths: -4 });
  });

  it('spells MIDI notes in a key', () => {
    expect(pitchName(spellMidi(66, { fifths: 1 }))).toBe('F#4');
    expect(pitchName(spellMidi(70, { fifths: -1 }))).toBe('Bb4');
    expect(pitchName(spellMidi(61, { fifths: -2 }))).toBe('Db4');
    expect(pitchName(spellMidi(61, { fifths: 0 }))).toBe('C#4');
  });

  it('chooses the nearest octave for letter input', () => {
    expect(pitchName(nearestPitchForStep('C', p('E4'), { fifths: 0 }))).toBe('C4');
    expect(pitchName(nearestPitchForStep('C', p('G4'), { fifths: 0 }))).toBe('C5');
    expect(pitchName(nearestPitchForStep('F', p('E4'), { fifths: 1 }))).toBe('F#4');
  });

  it('moves by semitone', () => {
    expect(pitchName(moveBySemitone(p('E4'), 1, { fifths: 0 }))).toBe('F4');
    expect(pitchName(moveBySemitone(p('F4'), 1, { fifths: 0 }))).toBe('F#4');
    expect(pitchName(moveBySemitone(p('G4'), -1, { fifths: 0 }))).toBe('Gb4');
    expect(pitchName(moveBySemitone(p('G4'), -1, { fifths: 2 }))).toBe('F#4');
  });

  it('places pitches on staff positions', () => {
    expect(staffPosition(p('F5'), 'treble')).toBe(0);
    expect(staffPosition(p('E4'), 'treble')).toBe(8);
    expect(staffPosition(p('C4'), 'treble')).toBe(10);
    expect(staffPosition(p('A3'), 'bass')).toBe(0);
    expect(staffPosition(p('C4'), 'alto')).toBe(4);
    expect(staffPosition(p('C4'), 'tenor')).toBe(2);
    expect(staffPosition(p('E3'), 'treble8vb')).toBe(8);
  });
});
