import { SAMPLES, buildPlayback } from '@ailegro-score/core';
import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { scoreToMidi } from './midi';

describe('MIDI export', () => {
  for (const sample of SAMPLES) {
    it(`round-trips sounding pitches, programs and performance timing: ${sample.id}`, () => {
      const doc = sample.build('zh');
      const playback = buildPlayback(doc);
      const parsed = new Midi(scoreToMidi(doc));
      expect(parsed.header.tempos.length).toBe(playback.tempo.length);
      parsed.header.tempos.forEach((t, i) => expect(t.bpm).toBeCloseTo(playback.tempo[i]!.qpm, 3));
      expect(parsed.tracks.reduce((n, t) => n + t.notes.length, 0)).toBe(playback.notes.length);
      let trackIndex = 0;
      for (const part of doc.parts) {
        const wanted = playback.notes.filter((n) => n.partId === part.id);
        if (!wanted.length) continue;
        const track = parsed.tracks[trackIndex++]!;
        expect(track.instrument.number).toBe(wanted[0]!.program);
        expect(track.channel === 9).toBe(wanted[0]!.drum);
        const expected = [...wanted].sort((a, b) => a.start - b.start || a.midi - b.midi);
        const actual = [...track.notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
        expect(actual.length).toBe(expected.length);
        actual.forEach((n, i) => {
          expect(n.midi).toBe(expected[i]!.midi);
          expect(Math.abs(n.time - expected[i]!.start)).toBeLessThan(0.008);
          expect(Math.abs(n.duration - expected[i]!.duration)).toBeLessThan(0.008);
          expect(n.velocity).toBeCloseTo(expected[i]!.velocity / 127, 4);
        });
      }
    });
  }
});
