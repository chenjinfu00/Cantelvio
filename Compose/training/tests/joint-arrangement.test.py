#!/usr/bin/env python3
"""Small no-network checks for the MIDI-only arrangement adapter."""
import sys
from pathlib import Path
import json
import tempfile
import unittest

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from train_joint_arrangement import (ArrangementAdapter, MAX_NOTES, batch, choose_local_versions,
                                     encode_bar, evaluate, exclusion_reason, fingerprint,
                                     initialize_pitch_from_joint, version_family, version_number)


class ArrangementTest(unittest.TestCase):
    def test_old_joint_pitch_initialization(self):
        model = ArrangementAdapter(d=32)
        bass = torch.arange(52 * 32, dtype=torch.float32).reshape(52, 32)
        melody = bass + 10
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / 'old.pt'
            torch.save({'config': {'kind': 'structured'},
                        'state_dict': {'tok.2.weight': bass, 'tok.3.weight': melody}}, checkpoint)
            digest = initialize_pitch_from_joint(model, checkpoint)
        self.assertEqual(len(digest), 64)
        self.assertTrue(torch.equal(model.pitch.weight[60], bass[4] + 5))
        self.assertTrue(torch.equal(model.pitch.weight[61], bass[5] + 5))

    def test_user_exclusion_and_newer_version_wins(self):
        self.assertEqual(exclusion_reason('曲谱&编曲/我的编曲&打谱/博士二阶段/piece_v9.mid'),
                         'user-excluded doctoral phase')
        self.assertEqual(exclusion_reason('songs/work/02_model/raw_muscriptor_large.mid'),
                         'unmodified transcription output')
        self.assertIsNone(exclusion_reason('songs/output/piece_refined_v3.mid'))
        self.assertGreater(version_number('songs/work/10_editable_edition/piece.mid'),
                           version_number('songs/output/piece_v9.mid'))
        names = ['a/b/c/d/symphony_score_v2.mid', 'a/b/c/d/symphony_score_v3.mid',
                 'a/b/c/d/another.mid']
        candidates = [{'name': name, 'family': version_family(name),
                       'version': version_number(name), 'mtime': 100 - i,
                       'noteCount': 100, 'barCount': 8, 'fingerprint': str(i),
                       'absolute': {i}, 'relative': {i}} for i, name in enumerate(names)]
        selected, dropped, clusters = choose_local_versions(candidates)
        self.assertEqual({p['name'] for p in selected}, {names[1], names[2]})
        self.assertEqual(dropped, [names[0]])
        self.assertEqual(len(clusters), 1)

    def test_bar_encoding_preserves_only_observed_groups(self):
        raw = {'bar': np.zeros(3, np.int32), 'pos': np.array([0, 3, 6], np.uint8),
               'group': np.array([0, 4, 2], np.uint8),
               'pitch': np.array([72, 60, 4], np.uint8),
               'drum': np.array([0, 0, 1], np.uint8),
               'dur': np.array([4, 6, 2], np.uint8),
               'vel': np.array([4, 4, 4], np.uint8)}
        row = encode_bar(raw, 0, 48)
        self.assertEqual(int(row['valid'].sum()), 4)
        self.assertEqual(row['pitch'][1:4].tolist(), [72, 60, 132])
        self.assertEqual(row['group_mask'].tolist(), [1, 0, 1, 0, 1, 0])
        self.assertEqual(len(row['pitch']), MAX_NOTES + 1)
        self.assertEqual(fingerprint(raw), fingerprint(raw))
        model = ArrangementAdapter(d=32)
        loss, metrics = model.losses(batch([row, row], 'cpu'))
        self.assertTrue(torch.isfinite(loss))
        self.assertTrue(0 <= metrics['noteAccuracy'] <= 1)
        loss.backward()
        self.assertTrue(any(p.grad is not None for p in model.parameters()))
        checked = evaluate(model, [row, row], 'cpu', 2)
        json.dumps(checked)
        self.assertEqual(checked['groupSupport']['woodwinds'], 2)
        self.assertEqual(checked['groupSupport']['high_strings'], 2)

    def test_short_and_invalid_bars_are_skipped(self):
        raw = {'group': np.array([0], np.uint8)}
        self.assertIsNone(encode_bar(raw, 0, 48))
        raw['group'] = np.array([0, 1], np.uint8)
        self.assertIsNone(encode_bar(raw, 0, 0))


if __name__ == '__main__':
    unittest.main()
