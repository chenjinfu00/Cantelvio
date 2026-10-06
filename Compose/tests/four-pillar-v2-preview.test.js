import test from 'node:test';
import assert from 'node:assert/strict';
import {previewPrompts, normalizeFourPillarOptions} from '../backend/four-pillar/v2-api.mjs';

test('trained v2 prompts do not claim pilot prior availability', async () => {
  const prompts = await previewPrompts();
  assert.equal(prompts.length, 5);
  assert.ok(prompts.every(prompt => prompt.oldPrior === false && prompt.scoreId));
});

test('v2 audition validates instrument masks and numeric controls', () => {
  assert.deepEqual(normalizeFourPillarOptions({groups: ['keys'], useLegacy: false}).groups, ['keys']);
  for (const value of [{prompt: -1}, {seed: NaN}, {groups: []}, {groups: ['keys','keys']}, {tempo: 0}, {temperature: Infinity}]) {
    assert.throws(() => normalizeFourPillarOptions(value));
  }
});
