#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from four_pillar_codec import END_BAR, END_ONSET, encode_score  # noqa: E402
from four_pillar_trial_data import TrialScore, collate, make_example, summarize_bars  # noqa: E402
from score_events_v2 import ScoreEvents  # noqa: E402


class TrialDataTest(unittest.TestCase):
    def test_condition_contains_only_selected_voice(self):
        row = {
            'scoreId': 'demo', 'parts': [{'id': 'v', 'group': 'high_strings'},
                                         {'id': 'c', 'group': 'low_strings'}],
            'measures': [{'on': '0', 'dur': '4', 'meter': [4, 4]},
                         {'on': '4', 'dur': '3', 'meter': [3, 4]}],
            'notes': [],
        }
        for bar, on, pitch, part, group in ((0, '0', 72, 'v', 'high_strings'),
                                             (1, '4', 74, 'v', 'high_strings'),
                                             (1, '4', 48, 'c', 'low_strings')):
            row['notes'].append({'bar': bar, 'on': on, 'dur': '1/3', 'pitch': pitch,
                                 'writtenPitch': pitch, 'part': part, 'staff': '1',
                                 'voice': '1', 'group': group, 'role': None,
                                 'dynamic': None, 'tuplet': '3:2'})
        score = ScoreEvents.from_candidate(row)
        item = TrialScore(score, encode_score(score), summarize_bars(score),
                          {n.source_index: n for n in score.events})
        example = make_example(item, 1, history_bars=4, context=128,
                               task='given_high_voice')
        self.assertTrue(example['material'])
        low_span = next((a, b) for i, (a, b) in enumerate(item.encoded.note_spans)
                        if item.notes_by_index[item.encoded.source_indices[i]].pitch == 48)
        self.assertNotIn(item.encoded.tokens[low_span[0]:low_span[1]],
                         [tuple(example['material'][i:i + low_span[1] - low_span[0]])
                          for i in range(len(example['material']))])
        batch = collate([example], context=128, device=torch.device('cpu'))
        self.assertEqual(batch['target'].shape, batch['decoder_input'].shape)
        self.assertFalse(batch['history_known'][0, 1:].any())
        self.assertTrue(batch['future_known'][0, 0])

        # A short context may stop early, but must never split a note or
        # simultaneous-onset slice. The first complete slice is ~50 tokens.
        short = make_example(item, 1, history_bars=4, context=80, task='free')
        self.assertIn(short['target'][-1], (END_ONSET, END_BAR))
        with self.assertRaisesRegex(ValueError, 'complete onset slice'):
            make_example(item, 1, history_bars=4, context=8, task='free')


if __name__ == '__main__':
    unittest.main()
