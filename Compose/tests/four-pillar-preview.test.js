import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFourPillarOptions, previewPrompts} from '../backend/four-pillar/api.mjs';

test('four-pillar pilot exposes only held-out validation prompts', async () => {
  const prompts = await previewPrompts();
  assert.equal(prompts.length, 5);
  assert.equal(prompts.filter(prompt => prompt.oldPrior).length, 2);
  assert.equal(new Set(prompts.map(prompt => prompt.scoreId)).size, prompts.length);
});

test('four-pillar audition controls reject invalid prompt and group selection', () => {
  const options = normalizeFourPillarOptions({prompt: 0, groups: ['keys'], useLegacy: false});
  assert.deepEqual(options.groups, ['keys']);
  assert.equal(options.useLegacy, false);
  for (const value of [{prompt: 5}, {seed: -1}, {groups: []}, {groups: ['keys', 'keys']},
    {groups: ['not-a-group']}, {temperature: 0.1}, {tempo: 300}, {useLegacy: 'false'}]) {
    assert.throws(() => normalizeFourPillarOptions(value));
  }
});
