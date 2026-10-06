import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appLayoutSnapshot } from '../public/shared/lattice.js';
import { pitchClass } from '../public/shared/music-data.js';
import { CHORD_SHAPES, HARMONIC_CHORDS, FINAL_CADENCE } from '../public/karaoke/karaoke-data.js';

test('all concrete harmonic keys use the requested register, including G3 B3 D4', async () => {
  const src = await readFile(new URL('../public/karaoke/karaoke.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function harmonicKeysFor'), src.indexOf('function markKeys'));
  const choose = new Function('$$', 'CHORD_SHAPES', 'pitchClass', 'columnStart', `${body}; return harmonicKeysFor;`)(
    (_, nodes) => nodes, CHORD_SHAPES, pitchClass, col => Math.floor((2 * col + 4) / 7));
  const svg = appLayoutSnapshot({ layout: 'harmonic', columns: 9, rows: 6, width: 1160, height: 430 });
  const nodes = [...svg.matchAll(/<g class="snapshot-key[^>]+>/g)].map(([tag]) => ({ dataset: Object.fromEntries([...tag.matchAll(/data-(\w+)="([^"]+)"/g)].map(m => [m[1], m[2]])) }));
  assert.ok(nodes.length > 20);
  for (const name of HARMONIC_CHORDS) {
    assert.deepEqual(choose(nodes, name).map(key => key.midi).sort((a,b) => a-b), CHORD_SHAPES[name].midis, name);
  }
});

test('the authentic cadence resolves the soprano and chordal seventh in their own voices', () => {
  const [iv, dominant, tonic] = FINAL_CADENCE.midis;
  assert.deepEqual([iv.at(-1), dominant.at(-1), tonic.at(-1)], [69, 71, 72]);
  assert.deepEqual([dominant[0] % 12, tonic[0] % 12], [7, 0]);
  assert.equal(dominant[2] - tonic[2], 1);
  assert.equal(tonic.at(-1) % 12, 0);
  for (const notes of FINAL_CADENCE.midis) assert.ok(notes.every((note, i) => i === 0 || note > notes[i-1]));
  for (let c = 1; c < FINAL_CADENCE.midis.length; c++) {
    const before = FINAL_CADENCE.midis[c-1], after = FINAL_CADENCE.midis[c];
    for (let a=0; a<4; a++) for(let b=a+1;b<4;b++) {
      const oldInterval=(before[b]-before[a])%12, newInterval=(after[b]-after[a])%12;
      const sameDirection=Math.sign(after[a]-before[a]) === Math.sign(after[b]-before[b]) && after[a] !== before[a];
      assert.ok(!(sameDirection && oldInterval === newInterval && [0,7].includes(oldInterval)), `parallel perfect interval: voices ${a},${b}`);
    }
  }
});
