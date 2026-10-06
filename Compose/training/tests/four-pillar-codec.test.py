#!/usr/bin/env python3
"""Exact-time score wire format must not silently quantize or drop notes."""
import gzip
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from score_events_v2 import ScoreEvents  # noqa: E402
from four_pillar_codec import (BOS, END_SCORE, EncodedScore, decode_score,
                               encode_score)  # noqa: E402


class CodecTest(unittest.TestCase):
    def test_exact_polyphony_tuplets_crossbar_missing_labels(self):
        record = {
            'scoreId': 'fixture', 'compositionKey': 'fixture',
            'parts': [{'id': 'V1', 'group': 'high_strings'},
                      {'id': 'V2', 'group': 'high_strings'}],
            'measures': [{'on': '0', 'dur': '4', 'meter': [4, 4]},
                         {'on': '4', 'dur': '3', 'meter': [3, 4]}],
            'notes': [],
        }
        for i, (on, dur, ratio) in enumerate((('0', '5', None), ('1/3', '1/3', '3:2'),
                                              ('2/5', '1/5', '5:4'), ('3/7', '1/7', '7:4'),
                                              ('1/6', '1/6', '6:4'), ('4', '1/11', '11:8'))):
            record['notes'].append({
                'bar': 0 if i < 5 else 1, 'part': 'V1' if i % 2 else 'V2',
                'staff': '1', 'voice': '1', 'on': on, 'dur': dur,
                'pitch': 60 + i, 'writtenPitch': 60 + i,
                'group': None if i == 2 else 'high_strings',
                'role': None if i == 2 else 'mel', 'dynamic': None if i == 2 else 'mf',
                'tuplet': ratio, 'wedge': None, 'accent': i % 3,
                'grace': False, 'unpitched': False,
            })
        record['notes'].append({
            'bar': 1, 'part': 'V1', 'staff': '1', 'voice': '1', 'on': '4', 'dur': '0',
            'pitch': None, 'writtenPitch': None, 'group': None, 'role': None,
            'dynamic': None, 'tuplet': None, 'wedge': None, 'accent': 0,
            'grace': True, 'unpitched': True,
        })
        score = ScoreEvents.from_candidate(record)
        encoded = encode_score(score)
        self.assertEqual(decode_score(encoded, score).events, score.events)
        self.assertEqual(encoded.tokens[0], BOS)
        self.assertEqual(encoded.tokens[-1], END_SCORE)
        self.assertEqual(len(encoded.note_spans), len(score.events))

        bad = EncodedScore(encoded.tokens[:-1], encoded.voice_ids,
                           encoded.source_indices, encoded.note_spans, encoded.bar_spans)
        with self.assertRaises(ValueError):
            decode_score(bad, score)

    def test_prepared_scores(self):
        with gzip.open(ROOT / 'data/classical-score-v1/scores.jsonl.gz', 'rt') as stream:
            for _ in range(3):
                score = ScoreEvents.from_candidate(json.loads(next(stream)))
                wire = encode_score(score)
                self.assertEqual(decode_score(wire, score).events, score.events)


if __name__ == '__main__':
    unittest.main()
