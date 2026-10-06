#!/usr/bin/env python3
"""Verify a paired Lieder score and old four-track window without training."""
import sys
import tarfile
import unittest
import xml.etree.ElementTree as ET
from dataclasses import replace
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_v1_alignment import past_window_before_bar, verified_bar_steps  # noqa: E402
from joint_data import load_corpus  # noqa: E402
from prepare_classical_scores import score_events, xml_from_mxl  # noqa: E402
from score_events_v2 import ScoreEvents  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'data/sources/OpenScore-Lieder-38c5db5.tar.gz'
MEMBER = ('OpenScore-Lieder/scores/Beach,_Amy/3_Browning_Songs,_Op.44/'
          '1_The_Year’s_at_the_Spring/lc6212179.mxl')


class ExactOldPriorAlignmentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.piece = next(piece for piece in load_corpus(ROOT / 'data/joint/lieder-joint.npz')
                         if piece['meta']['scoreId'] == 'lc6212179')
        with tarfile.open(ARCHIVE, 'r:gz') as tar:
            data = tar.extractfile(MEMBER).read()
        parts, measures, notes, _ = score_events(ET.fromstring(xml_from_mxl(data)))
        cls.score = ScoreEvents.from_candidate({
            'scoreId': 'lc6212179',
            'parts': [dict(id=identity, **info) for identity, info in parts],
            'measures': measures, 'notes': notes})

    def test_exact_barline_and_past_only_window(self):
        starts = verified_bar_steps(self.score, self.piece)
        self.assertEqual(starts[:4], (0, 12, 24, 36))
        result = past_window_before_bar(self.score, self.piece, 10)
        self.assertEqual(result['legacy_visible_steps'].item(), 124)
        self.assertEqual(result['legacy_end_qn'], (self.score.measures[10].onset,))
        self.assertEqual(result['target_start_qn'], result['legacy_end_qn'])
        self.assertEqual(result['source']['pastEndStep'], starts[10])

    def test_mismatch_is_rejected_not_rounded(self):
        wrong = replace(self.score, score_id='other-score')
        with self.assertRaisesRegex(ValueError, 'score ID'):
            verified_bar_steps(wrong, self.piece)
        measures = list(self.score.measures)
        measures[1] = replace(measures[1], onset=measures[1].onset + Fraction(1, 7))
        wrong = replace(self.score, measures=tuple(measures))
        with self.assertRaisesRegex(ValueError, 'timeline differs'):
            verified_bar_steps(wrong, self.piece)


if __name__ == '__main__':
    unittest.main()
