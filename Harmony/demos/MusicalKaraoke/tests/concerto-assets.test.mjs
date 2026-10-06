import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const base = new URL('../public/media/concertos/', import.meta.url);
const read = (id) => JSON.parse(readFileSync(new URL(`${id}.json`, base), 'utf8'));

test('concerto guides fit their bundled minute-long stems without invalid cues', () => {
  for (const id of ['melody', 'harmony']) {
    const score = read(id);
    assert.equal(score.id, id);
    assert.ok(score.duration >= 50 && score.duration <= 65);
    let previous = -1;
    for (const cue of score.guide) {
      assert.ok(cue.time >= previous && cue.time >= 0);
      assert.ok(cue.duration > 0 && cue.time + cue.duration <= score.duration + .01);
      assert.ok(cue.midis.length > 0 && cue.midis.every(n => Number.isInteger(n) && n >= 0 && n <= 127));
      previous = cue.time;
      if (cue.coords) {
        const pcs = values => [...new Set(values.map(n => (n % 12 + 12) % 12))].sort((a,b) => a-b);
        assert.deepEqual(pcs(cue.coords.map(([i,j]) => 7*i+4*j)), pcs(cue.midis));
      }
    }
    for (const type of ['backing', 'reference']) {
      const file = score.files[type];
      assert.ok(file.duration >= score.duration && file.duration < score.duration + 2);
      const audio = readFileSync(new URL(file.file, base));
      assert.equal(audio.subarray(0,4).toString(), 'OggS');
      assert.ok(audio.length > 10000);
      const midi = readFileSync(new URL(file.file.replace('.ogg', '.mid'), base));
      assert.equal(midi.subarray(0,4).toString(), 'MThd');
    }
    assert.notEqual(score.files.backing.file, score.files.reference.file);
  }
});

test('excerpts resolve at the chosen cadence and include the score accidentals', () => {
  const melody = read('melody');
  assert.deepEqual(melody.guide.at(-1).midis, [62,69,78]);
  const harmony = read('harmony');
  assert.equal(harmony.guide.length, 25);
  assert.equal(harmony.guide.at(-1).name, 'Em');
  for (const bar of [15,19]) {
    assert.equal(harmony.guide[bar-1].name, 'E7');
    assert.ok(harmony.guide[bar-1].midis.includes(68));
  }
});
