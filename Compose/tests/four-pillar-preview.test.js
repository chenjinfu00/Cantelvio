import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {normalizeFourPillarOptions, previewPrompts} from '../backend/four-pillar/api.mjs';

test('four-pillar pilot exposes only held-out validation prompts', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ailegro-pilot-prompts-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const manifestPath = path.join(directory, 'manifest.json');
  const validation = Array.from({length: 5}, (_, index) => ({
    scoreId: `validation-${index + 1}`, workId: `Composer_Name/Work_Title_${index + 1}`, oldPrior: index < 2,
  }));
  await writeFile(manifestPath, JSON.stringify({selection: {
    train: [{scoreId: 'training-only', workId: 'Training_Work', oldPrior: true}],
    validation,
    test: [{scoreId: 'test-only', workId: 'Test_Work', oldPrior: true}],
  }}));
  const prompts = await previewPrompts(manifestPath);
  assert.deepEqual(prompts, validation.map((entry, index) => ({
    id: index, scoreId: entry.scoreId, work: `Composer Name/Work Title ${index + 1}`, oldPrior: entry.oldPrior,
  })));
});

test('four-pillar pilot retains its audition defaults', () => {
  assert.deepEqual(normalizeFourPillarOptions({}), {
    prompt: 2, seed: 41977, temperature: 0.95, tempo: 96, useLegacy: true,
    groups: ['woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings'],
  });
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
