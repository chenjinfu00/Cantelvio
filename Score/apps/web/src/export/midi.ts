/** MIDI export follows the same concert-pitch performance timeline as playback. */
import { buildPlayback, measureInfos, toNumber, type ScoreDoc } from '@cantelvio-score/core';
import { Midi } from '@tonejs/midi';

const utf8Text = (text: string) => String.fromCharCode(...new TextEncoder().encode(text));

export function scoreToMidi(doc: ScoreDoc): Uint8Array {
  const playback = buildPlayback(doc);
  const midi = new Midi();
  midi.name = utf8Text(doc.meta.title);
  const ticks = (whole: number) => Math.round(whole * 4 * midi.header.ppq);
  midi.header.tempos = playback.tempo.map((p) => ({ ticks: ticks(toNumber(p.at)), bpm: p.qpm }));
  midi.header.timeSignatures = measureInfos(doc)
    .filter((m) => m.index === 0 || m.timeSigChange)
    .map((m) => ({
      ticks: ticks(toNumber(m.start)),
      timeSignature: [m.timeSig.beats, m.timeSig.beatType],
    }));
  midi.header.update();
  let channel = 0;
  for (const part of doc.parts) {
    const notes = playback.notes.filter((n) => n.partId === part.id);
    if (!notes.length) continue;
    const drum = notes[0]!.drum;
    if (channel === 9) channel++;
    if (!drum && channel > 15)
      throw new Error('MIDI export supports up to 15 pitched parts per file.');
    const track = midi.addTrack();
    track.name = utf8Text(part.name);
    track.channel = drum ? 9 : channel++;
    track.instrument.number = notes[0]!.program;
    for (const n of notes) {
      track.addNote({
        midi: n.midi,
        time: n.start,
        duration: n.duration,
        velocity: n.velocity / 127,
      });
    }
    track.endOfTrackTicks = midi.header.secondsToTicks(
      Math.max(playback.totalSeconds, track.duration),
    );
  }
  return midi.toArray();
}
