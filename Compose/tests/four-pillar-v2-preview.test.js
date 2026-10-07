import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {previewPrompts, normalizeFourPillarOptions} from '../backend/four-pillar/v2-api.mjs';

test('trained v2 exposes only validation prompts without pilot prior availability', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ailegro-v2-prompts-'));
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
    id: index, scoreId: entry.scoreId, work: `Composer Name/Work Title ${index + 1}`, oldPrior: false,
  })));
});

test('v2 retains its audition normalization defaults', () => {
  assert.deepEqual(normalizeFourPillarOptions({}), {
    prompt: 2, seed: 41977, temperature: 0.95, tempo: 96, useLegacy: true,
    groups: ['woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings'],
  });
});

test('v2 audition validates instrument masks and numeric controls', () => {
  assert.deepEqual(normalizeFourPillarOptions({groups: ['keys'], useLegacy: false}).groups, ['keys']);
  for (const value of [{prompt: -1}, {seed: NaN}, {groups: []}, {groups: ['keys','keys']}, {tempo: 0}, {temperature: Infinity}]) {
    assert.throws(() => normalizeFourPillarOptions(value));
  }
});
