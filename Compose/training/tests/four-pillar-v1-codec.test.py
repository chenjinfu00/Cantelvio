#!/usr/bin/env python3
"""Dynamic voice IDs, exact tuplets and long registries round-trip without a cap."""
import sys
import unittest
import gzip
import json
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_v1_codec import (VOICE_CHOICE, causal_teacher_forcing_inputs,
                                   decode_dynamic_score, encode_dynamic_score)  # noqa: E402
from score_events_v2 import ScoreEvents  # noqa: E402


class DynamicCodecTest(unittest.TestCase):
    def score(self, voices=3):
        parts = [{'id': f'p{i}', 'group': 'high_strings'} for i in range(voices)]
        notes = [{'bar': 0, 'on': '0', 'dur': '1/7', 'pitch': 60 + i % 24,
                  'writtenPitch': 60 + i % 24, 'part': f'p{i}', 'staff': '1',
                  'voice': '1', 'group': 'high_strings', 'role': 'mel',
                  'tuplet': '7:4'} for i in range(voices)]
        notes.append({'bar': 1, 'on': '3', 'dur': '1/3', 'pitch': 66,
                      'writtenPitch': 66, 'part': 'p0', 'staff': '1',
                      'voice': '1', 'group': 'high_strings', 'role': 'mel',
                      'tuplet': '3:2'})
        return ScoreEvents.from_candidate({
            'scoreId': 'dynamic', 'parts': parts,
            'measures': [{'on': '0', 'dur': '3', 'meter': [3, 4]},
                         {'on': '3', 'dur': '2', 'meter': [6, 8], 'irregular': True}],
            'notes': notes,
        })

    def test_new_and_existing_voices_are_dynamic(self):
        score = self.score()
        encoded = encode_dynamic_score(score)
        positions = [i for i, token in enumerate(encoded.tokens) if token == VOICE_CHOICE]
        self.assertEqual([encoded.voice_pointer_targets[i] for i in positions],
                         [0, 1, 2, 0])
        self.assertEqual(len(encoded.voice_definitions), 3)
        self.assertEqual(decode_dynamic_score(encoded, score).events, score.events)
        self.assertEqual(len(encoded.bar_spans), 2)
        bad = list(encoded.voice_pointer_targets)
        bad[positions[1]] = 9
        with self.assertRaisesRegex(ValueError, 'future voice'):
            decode_dynamic_score(replace(encoded, voice_pointer_targets=tuple(bad)), score)

    def test_seventy_voices_without_fixed_softmax_capacity(self):
        score = self.score(70)
        encoded = encode_dynamic_score(score)
        self.assertEqual(len(encoded.voice_definitions), 70)
        self.assertEqual(decode_dynamic_score(encoded, score).events, score.events)

    def test_teacher_forcing_registry_uses_only_emitted_metadata(self):
        encoded = encode_dynamic_score(self.score())
        batch = causal_teacher_forcing_inputs(encoded)
        first_note = encoded.note_spans[0][0]
        choice = first_note + 1
        group = choice + 1
        role = group + 1
        pitch = role + 1
        self.assertEqual(batch['voice_known'][0, choice].sum().item(), 0)
        self.assertEqual(batch['voice_pointer_input'][0, choice].item(), 0)
        self.assertEqual(batch['voice_known'][0, group].sum().item(), 1)
        self.assertEqual(batch['voice_features'][0, group, 0, :14].sum().item(), 0)
        self.assertEqual(batch['voice_features'][0, role, 0, 4].item(), 1)
        self.assertEqual(batch['voice_features'][0, role, 0, 7].item(), 0)
        self.assertEqual(batch['voice_features'][0, pitch, 0, 7].item(), 1)
        self.assertTrue(batch['voice_pointer_target_known'][0, first_note].item())
        self.assertEqual(batch['voice_pointer_target'][0, first_note].item(), 0)
        poisoned = replace(encoded, voice_definitions=(('future', '7', '8'),))
        again = causal_teacher_forcing_inputs(poisoned)
        self.assertTrue(batch['voice_features'].equal(again['voice_features']))
        self.assertTrue(batch['voice_known'].equal(again['voice_known']))

    def test_windowed_teacher_forcing_matches_full_causal_view(self):
        encoded = encode_dynamic_score(self.score())
        complete = causal_teacher_forcing_inputs(encoded)
        start, end = encoded.bar_spans[1]
        window = causal_teacher_forcing_inputs(encoded, start=start - 1, stop=end - 1)
        for name in ('decoder_input', 'event_target', 'event_known',
                     'voice_pointer_input', 'voice_pointer_target',
                     'voice_pointer_target_known'):
            self.assertTrue(window[name].equal(complete[name][:, start - 1:end - 1]))
        width = window['voice_features'].shape[2]
        self.assertTrue(window['voice_features'].equal(
            complete['voice_features'][:, start - 1:end - 1, :width]))
        self.assertTrue(window['voice_known'].equal(
            complete['voice_known'][:, start - 1:end - 1, :width]))

    def test_first_three_real_candidate_scores_round_trip(self):
        corpus = Path(__file__).resolve().parents[1] / 'data/classical-score-v1/scores.jsonl.gz'
        with gzip.open(corpus, 'rt') as stream:
            for _, line in zip(range(3), stream):
                score = ScoreEvents.from_candidate(json.loads(line))
                encoded = encode_dynamic_score(score)
                self.assertEqual(decode_dynamic_score(encoded, score).events, score.events)


if __name__ == '__main__':
    unittest.main()
