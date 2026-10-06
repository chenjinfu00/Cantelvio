import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VOICE_PARTS, KARAOKE_PROGRESSIONS, CHORD_SHAPES } from '../public/karaoke/karaoke-data.js';

const root = new URL('../public/media/karaoke/', import.meta.url);
function pcmWav(data) {
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.toString('ascii', 8, 12), 'WAVE');
  let fmt, pcm;
  for (let offset = 12; offset + 8 <= data.length;) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const chunk = data.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') fmt = chunk;
    if (id === 'data') pcm = chunk;
    offset += 8 + size + size % 2;
  }
  assert.ok(fmt && pcm);
  assert.equal(fmt.readUInt16LE(0), 1);
  assert.equal(fmt.readUInt16LE(2), 1);
  assert.equal(fmt.readUInt16LE(14), 16);
  return { pcm, rate: fmt.readUInt32LE(4), duration: pcm.length / 2 / fmt.readUInt32LE(4) };
}

test('karaoke vocal cues match real PCM audio duration and safe peak range', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root)));
  assert.ok(manifest.clips['parts-together']);
  for (const [name, clip] of Object.entries(manifest.clips)) {
    const audio = pcmWav(await readFile(new URL(clip.src, root)));
    assert.equal(audio.rate, 44100);
    assert.ok(Math.abs(audio.duration - clip.duration) < .0001, name);
    let peak = 0;
    for (let i = 0; i < audio.pcm.length; i += 2) peak = Math.max(peak, Math.abs(audio.pcm.readInt16LE(i)) / 32768);
    if (name === 'parts-together') assert.equal(peak, 0, 'collective singing must contain no played answer');
    else assert.ok(peak > .1 && peak <= .71, `${name} peak=${peak}`);
    let end = 0;
    for (const cue of clip.cues) {
      assert.ok(cue.time >= end - .0001, name);
      assert.ok(cue.duration > 0 && cue.time + cue.duration <= clip.duration + .0001, name);
      end = cue.time + cue.duration;
      if (cue.kind === 'response') {
        assert.deepEqual(cue.midis, []);
        for (let i = Math.ceil(cue.time * audio.rate) * 2; i < Math.floor(end * audio.rate) * 2; i += 2) {
          assert.equal(audio.pcm.readInt16LE(i), 0, `${name} response must be silent`);
        }
      }
    }
  }
});

test('each singer rehearses exactly twice, with reusable sung notes and no solo check', async () => {
  const { clips } = JSON.parse(await readFile(new URL('manifest.json', root)));
  for (const part of VOICE_PARTS) {
    const practice = clips[`part-${part.id}-practice`].cues.filter(cue => cue.kind === 'practice');
    assert.equal(practice.length, 8);
    for (let round = 1; round <= 2; round++) {
      assert.deepEqual(practice.filter(cue => cue.round === round).flatMap(cue => cue.midis), part.midis);
    }
    assert.equal(clips[`part-${part.id}-check`], undefined);
    for (const midi of part.midis) assert.deepEqual(clips[`voice-note-${midi}`].cues[0].midis, [midi]);
  }
});

test('collective singing starts immediately after one count-in, without a played answer', async () => {
  const { clips } = JSON.parse(await readFile(new URL('manifest.json', root)));
  const together = clips['parts-together'];
  assert.equal(together.duration, 8.8);
  assert.deepEqual(together.cues.map(cue => cue.kind), ['count', 'count', 'count', 'response', 'response', 'response', 'response']);
  assert.deepEqual(together.cues.filter(cue => cue.kind === 'response').map(cue => cue.time), [2.4, 4, 5.6, 7.2]);
  assert.ok(together.cues.every(cue => cue.midis.length === 0));
  assert.deepEqual(KARAOKE_PROGRESSIONS[0].chords, ['C', 'G', 'Am', 'F']);
  const pitchSet = notes => [...new Set(notes.map(n => n % 12))].sort((a, b) => a - b);
  KARAOKE_PROGRESSIONS[0].chords.forEach((name, i) => {
    assert.deepEqual(pitchSet(VOICE_PARTS.map(part => part.midis[i])), pitchSet(CHORD_SHAPES[name].midis));
  });
});

test('choir leaves a full four seconds for unaccompanied audience response', async () => {
  const { clips } = JSON.parse(await readFile(new URL('manifest.json', root)));
  assert.equal(clips.choir.duration, 24);
  assert.deepEqual(clips.choir.cues.at(-1), {time:20,duration:4,label:'Your turn',midis:[],vowel:null,kind:'response'});
  const together = clips.choir.cues.find(x => x.label === 'Together');
  assert.deepEqual(together.midis, [48, 52, 55]);
  assert.deepEqual(together.vowels, ['ah', 'oo', 'mm']);
});


test('the revealed answer plays all three practiced voices through C G Am F', async () => {
  const { clips } = JSON.parse(await readFile(new URL('manifest.json', root)));
  const answer = clips['parts-answer'];
  assert.equal(answer.duration, 6.4);
  assert.deepEqual(answer.cues.map(cue => cue.kind), ['answer', 'answer', 'answer', 'answer']);
  assert.deepEqual(answer.cues.map(cue => cue.time), [0, 1.6, 3.2, 4.8]);
  answer.cues.forEach((cue, step) => {
    assert.equal(cue.step, step);
    assert.deepEqual(cue.midis, VOICE_PARTS.map(part => part.midis[step]));
    assert.equal(cue.vowel, 'ah');
  });
  const audio = pcmWav(await readFile(new URL(answer.src, root)));
  for (const cue of answer.cues) {
    let power = 0, count = 0;
    for (let frame = Math.ceil((cue.time + .2) * audio.rate); frame < Math.floor((cue.time + 1.1) * audio.rate); frame++) {
      power += (audio.pcm.readInt16LE(frame * 2) / 32768) ** 2;
      count++;
    }
    assert.ok(Math.sqrt(power / count) > .02, `answer chord ${cue.step} must sound`);
  }
});
