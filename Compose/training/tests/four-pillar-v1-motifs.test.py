#!/usr/bin/env python3
"""Motif memory only sees committed bars and keeps complete onset groups."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_v1_codec import encode_dynamic_score  # noqa: E402
from four_pillar_v1_motifs import PastMotifBank  # noqa: E402
from score_events_v2 import ScoreEvents  # noqa: E402


class MotifBankTest(unittest.TestCase):
    def test_recurrence_uses_past_only(self):
        score = ScoreEvents.from_candidate({
            'scoreId': 'motif', 'parts': [{'id': 'p', 'group': 'keys'}],
            'measures': [{'on': '0', 'dur': '3', 'meter': [3, 4]},
                         {'on': '3', 'dur': '3', 'meter': [3, 4]}],
            'notes': [{'bar': i, 'on': str(i * 3), 'dur': '1/5',
                       'pitch': 60 + 2 * i, 'writtenPitch': 60 + 2 * i,
                       'part': 'p', 'staff': '1', 'voice': '1',
                       'group': 'keys', 'role': 'mel', 'tuplet': '5:4'}
                      for i in range(2)],
        })
        encoded = encode_dynamic_score(score)
        bank = PastMotifBank(max_tokens=192)
        empty, known = bank.tensors()
        self.assertEqual(empty.shape[1], 0)
        first = encoded.tokens[slice(*encoded.bar_spans[0])]
        second = encoded.tokens[slice(*encoded.bar_spans[1])]
        bank.add_committed_bar(0, first)
        self.assertEqual(bank.next_bar, 1)
        with self.assertRaisesRegex(ValueError, 'next completed'):
            bank.add_committed_bar(0, first)
        bank.add_committed_bar(1, second)
        self.assertEqual(len(bank.entries), 1)
        self.assertEqual(bank.entries[0].repeats, 2)
        tokens, mask = bank.tensors()
        self.assertEqual(tokens.shape, mask.shape)
        self.assertTrue(mask.any())


if __name__ == '__main__':
    unittest.main()
