#!/usr/bin/env python3
"""Membership, masking and lazy-adapter checks; no optimizer updates."""
from __future__ import annotations

import json
import copy
import random
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from four_pillar_midi_data import load_midi_item, make_midi_example, verify_manifest  # noqa: E402
from four_pillar_score_index import get_score, index_rows, open_index  # noqa: E402
from train_four_pillar_v1_all_data import SourceCycler  # noqa: E402

MIDI = ROOT / 'data/four-pillar-midi-all-train-v1.json'
SCORES = ROOT / 'data/four-pillar-score-all-train-v1.sqlite'


class FullRealCorpusTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.membership = json.loads(MIDI.read_text())

    def test_every_prepared_midi_and_curated_midi_is_train_only(self):
        manifest = self.membership
        self.assertEqual(manifest['schema'], 'four-pillar-midi-all-train-v1')
        verify_manifest(manifest)
        self.assertEqual(manifest['counts']['SymphonyNet'], {'train': 45240})
        self.assertEqual(manifest['counts']['MIDI-Library'], {'train': 117})
        self.assertEqual(len(manifest['rows']), 45357)
        self.assertEqual(manifest['recoveredFromOldGridRejects'],
                         {'not on grid': 1947, 'unusable meter': 251, 'too short': 6})
        self.assertEqual(manifest['stillRejected']['duplicate'], 1118)
        self.assertTrue(all(row['split'] == 'train' for row in manifest['rows']))
        self.assertFalse(any('local-midi-curated-v1' in row['name'] or
                             'MIDI-Library-Excluded' in row['name'] or
                             'synthetic' in row['name'] for row in manifest['rows']))

    def test_original_midi_is_adapted_with_unknown_notation_masked(self):
        row = next(row for row in self.membership['rows']
                   if row['source'] == 'SymphonyNet' and 500 < row['notes'] < 1800)
        item = load_midi_item(row, target_bar=8)
        self.assertEqual(item.target_relative_bar, 8)
        self.assertEqual(item.piece, None)
        self.assertTrue(item.score.events)
        self.assertTrue(item.encoded.note_spans)
        for start, end in item.encoded.note_spans[:10]:
            self.assertFalse(any(item.encoded.loss_mask[end - 5:end]))
        inputs, targets = make_midi_example(item, context=256)
        self.assertGreater(int(targets['event_known'].sum()), 0)
        self.assertGreater(int(targets['midi_velocity_known'].sum()), 0)
        self.assertNotIn('harmony_root', targets)
        self.assertEqual(inputs['decoder_input'].shape, targets['event'].shape)

    def test_recovered_off_grid_and_meter_midi_reach_training_targets(self):
        for reason in ('not on grid', 'unusable meter'):
            row = next(row for row in self.membership['rows']
                       if row.get('legacySkip') == reason and row['bars'] > 12)
            item = load_midi_item(row, target_bar=8)
            inputs, targets = make_midi_example(item, context=256)
            self.assertGreater(int(targets['event_known'].sum()), 0)
            self.assertEqual(inputs['decoder_input'].shape, targets['event'].shape)

    def test_all_real_score_candidates_indexed_without_validation(self):
        if not SCORES.exists():
            self.skipTest('score index preparation has not completed yet')
        db = open_index(SCORES)
        try:
            meta = json.loads(db.execute("SELECT value FROM metadata WHERE key='manifest'").fetchone()[0])
            self.assertEqual(meta['counts']['Lieder'], {'train': 1131})
            self.assertEqual(meta['counts']['classical-scores'], {'train': 303})
            self.assertFalse(meta['liederFailures'])
            self.assertEqual({row['scoreId'] for row in meta['liederRepairs']},
                             {'lc6598318', 'lc5026266'})
            self.assertEqual(sum(len(row['corrections']) for row in meta['liederRepairs']), 2)
            for source in ('Lieder', 'classical-scores'):
                score_id, bars = index_rows(db, source=source, split='train')[0]
                score = get_score(db, score_id)
                self.assertEqual(len(score.measures), bars)
                self.assertTrue(score.events)
            self.assertEqual(db.execute("SELECT count(*) FROM scores WHERE split != 'train'").fetchone()[0], 0)
        finally:
            db.close()

    def test_source_cycler_uses_all_members_before_repeating_and_resumes(self):
        pool = {'a': [1, 2, 3], 'b': [4, 5]}
        rng = random.Random(42)
        cycler = SourceCycler(pool, rng)
        first = [cycler.next_index('a') for _ in range(3)]
        self.assertEqual(set(first), {0, 1, 2})
        saved, rng_state = copy.deepcopy(cycler.state_dict()), rng.getstate()
        expected = [cycler.next_index('a') for _ in range(3)]
        other_rng = random.Random(7)
        restored = SourceCycler(pool, other_rng)
        other_rng.setstate(rng_state)
        restored.load_state_dict(saved)
        self.assertEqual([restored.next_index('a') for _ in range(3)], expected)


if __name__ == '__main__':
    unittest.main()
