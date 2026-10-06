#!/usr/bin/env python3
"""Exact polyphonic score representation without inferred missing labels."""
import gzip
import json
from fractions import Fraction
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from score_events_v2 import ScoreEvents  # noqa: E402


def record():
    return {
        'scoreId': 'example', 'compositionKey': 'work-1', 'scoreSha256': 'hash',
        'parts': [
            {'id': 'V1', 'name': 'Violin', 'group': 'high_strings', 'program': 41},
            {'id': 'VC', 'name': 'Cello', 'group': 'low_strings', 'program': 43},
        ],
        'measures': [
            {'on': '0', 'dur': '4', 'meter': [4, 4], 'irregular': False},
            {'on': '4', 'dur': '3', 'meter': [3, 4], 'irregular': False},
        ],
        'notes': [
            {'part': 'VC', 'staff': '1', 'voice': '1', 'bar': 0, 'on': '0', 'dur': '5',
             'pitch': 48, 'writtenPitch': 48, 'group': 'low_strings', 'role': None,
             'tuplet': None, 'dynamic': None},
            {'part': 'V1', 'staff': '1', 'voice': '1', 'bar': 0, 'on': '0', 'dur': '1/3',
             'pitch': 72, 'writtenPitch': 72, 'group': 'high_strings', 'role': 'mel',
             'tuplet': '3:2', 'dynamic': 'p'},
            {'part': 'V1', 'staff': '1', 'voice': '1', 'bar': 0, 'on': '0', 'dur': '1/3',
             'pitch': 76, 'writtenPitch': 76, 'group': 'high_strings', 'role': 'mel',
             'tuplet': '3:2', 'dynamic': 'p'},
            {'part': 'V1', 'staff': '1', 'voice': '1', 'bar': 0, 'on': '1/3', 'dur': '2/5',
             'pitch': 74, 'writtenPitch': 74, 'group': None, 'role': None,
             'tuplet': '5:4', 'dynamic': None},
        ],
    }


class ScoreEventsTest(unittest.TestCase):
    def test_exact_time_polyphony_unknowns_and_cross_bar_note(self):
        score = ScoreEvents.from_candidate(record())
        self.assertEqual(score.voice_ids(), (('V1', '1', '1'), ('VC', '1', '1')))
        self.assertEqual(len(score.onset_slices()[0]), 3)
        self.assertEqual([note.pitch for note in score.onset_slices()[0]], [72, 76, 48])
        self.assertEqual(score.events[-1].onset, Fraction(1, 3))
        self.assertEqual(score.events[-1].duration, Fraction(2, 5))
        self.assertEqual(score.events[-1].tuplet, '5:4')
        self.assertIsNone(score.events[-1].group)
        self.assertIsNone(score.events[-1].role)
        self.assertIsNone(score.events[-1].dynamic)
        self.assertEqual(score.events[2].end, Fraction(5))  # merged tie crosses barline

    def test_invalid_source_is_not_silently_repaired(self):
        row = record()
        row['notes'][0]['bar'] = 9
        with self.assertRaises(ValueError):
            ScoreEvents.from_candidate(row)
        row = record()
        row['notes'][0]['pitch'] = 128
        with self.assertRaises(ValueError):
            ScoreEvents.from_candidate(row)
        row = record()
        row['notes'][0]['dur'] = '0'
        with self.assertRaises(ValueError):
            ScoreEvents.from_candidate(row)

    def test_prepared_score_smoke(self):
        source = ROOT / 'data/classical-score-v1/scores.jsonl.gz'
        with gzip.open(source, 'rt') as stream:
            for _ in range(3):
                score = ScoreEvents.from_candidate(json.loads(next(stream)))
                self.assertGreater(len(score.parts), 0)
                self.assertGreater(len(score.events), 0)
                self.assertEqual(sum(len(group) for group in score.onset_slices()), len(score.events))


if __name__ == '__main__':
    unittest.main()
