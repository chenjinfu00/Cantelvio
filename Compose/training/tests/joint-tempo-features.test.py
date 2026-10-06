#!/usr/bin/env python3
import sys
from pathlib import Path
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from build_joint_tempo_features import align_piece


class JointTempoFeaturesTest(unittest.TestCase):
    def test_missing_stays_missing_and_change_carries_forward(self):
        piece = {'arrays': {'bar': np.array([0] * 8 + [1] * 8)}}
        events = [{'bar': 0, 'offsetQuarter': '1/3', 'value': 90.0},
                  {'bar': 1, 'offsetQuarter': '0', 'value': 105.0}]
        qpm, known, change, skipped = align_piece(piece, events)
        self.assertFalse(known[1])
        self.assertTrue(np.isnan(qpm[1]))
        self.assertEqual(qpm[2], 90)
        self.assertEqual(qpm[8], 105)
        self.assertEqual(np.flatnonzero(change).tolist(), [2, 8])
        self.assertEqual(skipped, {})

    def test_conflicting_mark_not_supervised(self):
        piece = {'arrays': {'bar': np.array([0] * 8)}}
        events = [{'bar': 0, 'offsetQuarter': '0', 'value': 90.0},
                  {'bar': 0, 'offsetQuarter': '0', 'value': 100.0}]
        _, known, change, skipped = align_piece(piece, events)
        self.assertFalse(known.any())
        self.assertFalse(change.any())
        self.assertEqual(skipped['conflicting position'], 2)


if __name__ == '__main__':
    unittest.main()
