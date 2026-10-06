import test from 'node:test';
import assert from 'node:assert/strict';
import {models, normalizePreviewOptions, PreviewInputError} from '../backend/orchestra/api.mjs';
import {quarterToSeconds} from '../frontend/orchestra/audio.js';
import {estimateHarmony} from '../frontend/orchestra/harmony.js';

test('five distinct orchestral checkpoints are offered', () => {
  assert.equal(models.length, 5);
  assert.equal(new Set(models.map(model => model.id)).size, 5);
  for (const model of models) assert.match(model.id, /^abl-/);
});

test('preview options are normalized and model/group choices are constrained', () => {
  const defaults = normalizePreviewOptions({});
  assert.equal(defaults.model, 'abl-rotary-aug');
  assert.equal(defaults.bars, 8);
  assert.equal(defaults.groups.high_strings, 'on');
  assert.equal(defaults.groups.brass, 'auto');
  assert.throws(() => normalizePreviewOptions({model: '../../other'}), PreviewInputError);
  assert.throws(() => normalizePreviewOptions({bars: 32}), PreviewInputError);
  assert.throws(() => normalizePreviewOptions({seed: 1.2}), PreviewInputError);
  assert.throws(() => normalizePreviewOptions({temperature: 2}), PreviewInputError);
  assert.throws(() => normalizePreviewOptions({topP: 0.2}), PreviewInputError);
  assert.throws(() => normalizePreviewOptions({groups: {bass: 'on'}}), PreviewInputError);
  assert.throws(() => normalizePreviewOptions({groups: Object.fromEntries(Object.keys(defaults.groups).map(group => [group, 'off']))}), PreviewInputError);
});

test('score events convert to playback time across tempo changes', () => {
  const sample = {totalQuarters: 8, barEvents: [{quarter: 0, bpm: 120}, {quarter: 4, bpm: 60}]};
  assert.equal(quarterToSeconds(2, sample), 1);
  assert.equal(quarterToSeconds(4, sample), 2);
  assert.equal(quarterToSeconds(6, sample), 4);
  assert.equal(quarterToSeconds(8, sample), 6);
  assert.equal(quarterToSeconds(9, sample), 7);
});

test('estimated harmony is derived from pitched notes, with sparse bars marked uncertain', () => {
  const sample = {totalQuarters: 8, barEvents: [{quarter: 0}, {quarter: 4}], notes: [
    {quarter: 0, duration: 3, group: 'low_strings', pitch: 48, velocity: 96, drum: false},
    {quarter: 0, duration: 3, group: 'high_strings', pitch: 64, velocity: 96, drum: false},
    {quarter: 0, duration: 3, group: 'high_strings', pitch: 67, velocity: 96, drum: false},
    {quarter: 4, duration: 1, group: 'percussion', pitch: 36, velocity: 100, drum: true},
  ]};
  const [first, second] = estimateHarmony(sample);
  assert.equal(first.name, 'C');
  assert.equal(first.confidence, 'estimated');
  assert.equal(second.name, '—');
  assert.equal(second.confidence, 'none');
});
