#!/usr/bin/env python3
"""No-weight-update tests for future cross-key and expressive training data."""
from __future__ import annotations

import random
import sys
import unittest
from dataclasses import replace
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

from four_pillar_midi_data import MidiItem  # noqa: E402
from four_pillar_trial_data import summarize_bars  # noqa: E402
from four_pillar_v1_codec import encode_dynamic_score  # noqa: E402
from four_pillar_v1_pilot_data import PairedScore  # noqa: E402
from four_pillar_v2_data import (add_expression_targets, add_key_direction_targets,
                                 add_motif_targets, augment_item, canonicalize_item,
                                 canonicalize_pitch_class_item,
                                 transpose_item, transpose_score, valid_shifts)  # noqa: E402
from score_events_v2 import Measure, NoteEvent, Part, ScoreEvents  # noqa: E402


def fixture():
    part = Part('P1', 0, 'Violin', '', 'high_strings', 40, 'name')
    measures = tuple(Measure(i, Fraction(i * 4), Fraction(4), (4, 4), False,
                             {'fifths': 0 if i < 4 else 2, 'mode': 'major'})
                     for i in range(5))
    events = []
    for bar in range(5):
        for position, pitch in enumerate((60, 62, 64, 65)):
            source = bar * 4 + position
            events.append(NoteEvent(source, Fraction(bar * 4 + position), Fraction(1),
                                    bar, 'P1', '1', '1', pitch + (2 if bar == 4 else 0),
                                    pitch + (2 if bar == 4 else 0), 'high_strings',
                                    None, None, 'mf', None, 0, False, False))
    return ScoreEvents('fixture', 'test', None, None, None, None, None,
                       (part,), measures, tuple(events))


class CrossKeyPhraseDataTest(unittest.TestCase):
    def test_whole_excerpt_transposition_preserves_structure_and_keys(self):
        original = fixture()
        shifted = transpose_score(original, 2)
        self.assertEqual(shifted.measures[0].key['fifths'], 2)
        self.assertEqual(shifted.measures[4].key['fifths'], 4)
        original_key, shifted_key = {}, {}
        add_key_direction_targets(original, original_key, 4)
        add_key_direction_targets(shifted, shifted_key, 4)
        self.assertEqual(int(original_key['key_direction'][0, 0]),
                         int(shifted_key['key_direction'][0, 0]))
        self.assertEqual([n.pitch for n in shifted.events],
                         [n.pitch + 2 for n in original.events])
        self.assertEqual([n.onset for n in shifted.events],
                         [n.onset for n in original.events])
        self.assertEqual(shifted.events[0].dynamic, original.events[0].dynamic)
        self.assertEqual(transpose_score(shifted, -2).events, original.events)
        self.assertEqual(augment_item(PairedScore(original, None,
                         encode_dynamic_score(original), summarize_bars(original), ()),
                         random.Random(1)).score.events[0].duration, Fraction(1))

    def test_out_of_range_shift_is_rejected_not_clipped(self):
        original = fixture()
        self.assertNotIn(-6, valid_shifts(original))  # violin G3 floor is conservative
        self.assertRaises(ValueError, transpose_score, original, -6)
        self.assertEqual(original.events[0].pitch, 60)

    def test_past_canonicalizer_maps_safe_transpositions_to_identical_tokens(self):
        original = fixture()
        item = PairedScore(original, None, encode_dynamic_score(original),
                           summarize_bars(original), ())
        other = transpose_item(item, 2)
        normalized_a, shift_a = canonicalize_item(item, 4)
        normalized_b, shift_b = canonicalize_item(other, 4)
        self.assertEqual((shift_a, shift_b), (0, -2))
        self.assertEqual(normalized_a.encoded.tokens, normalized_b.encoded.tokens)
        self.assertTrue((normalized_a.summaries == normalized_b.summaries).all())

    def test_pitch_class_fallback_keeps_orchestral_register_safe(self):
        original = fixture()
        bass = Part('P2', 1, 'Cello', '', 'low_strings', 42, 'name')
        high = [replace(note, pitch=note.pitch + 16,
                        written_pitch=note.written_pitch + 16)
                for note in original.events]
        low = [NoteEvent(100 + bar, Fraction(bar * 4), Fraction(1), bar,
                         'P2', '1', '1', 30, 30, 'low_strings', None,
                         None, None, None, 0, False, False)
               for bar in range(5)]
        notes = tuple(sorted(high + low, key=lambda n: (n.onset, n.part)))
        score = replace(original, parts=(original.parts[0], bass),
                        measures=tuple(replace(bar, key=None) for bar in original.measures),
                        events=notes)
        item = PairedScore(score, None, encode_dynamic_score(score),
                           summarize_bars(score), ())
        self.assertIsNone(canonicalize_item(item, 4))  # would push cello below range
        normalized, shift = canonicalize_pitch_class_item(item, 4)
        self.assertEqual(shift, -4)
        self.assertEqual(min(n.pitch for n in normalized.score.events), 26)

    def test_motif_memory_is_past_only_and_transposition_label_is_source_derived(self):
        score = fixture()
        item = PairedScore(score, None, encode_dynamic_score(score), summarize_bars(score), ())
        inputs, targets = {}, {}
        add_motif_targets(item, inputs, targets, 4)
        self.assertEqual(int(targets['motif_recall'][0, 0]), 4)
        self.assertTrue(bool(targets['motif_recall_known'][0, 0]))
        self.assertEqual(float(targets['motif_pitch_shift'][0, 0]), 2.0)
        self.assertEqual(float(targets['motif_log_duration'][0, 0]), 0.0)
        transposed = transpose_item(item, 2)
        transposed_inputs, transposed_targets = {}, {}
        add_motif_targets(transposed, transposed_inputs, transposed_targets, 4)
        self.assertEqual(int(transposed_targets['motif_recall'][0, 0]), 4)
        self.assertEqual(float(transposed_targets['motif_pitch_shift'][0, 0]), 2.0)
        changed = replace(score, events=score.events[:-4] + tuple(
            replace(note, pitch=note.pitch + 5) for note in score.events[-4:]))
        other = PairedScore(changed, None, encode_dynamic_score(changed),
                            summarize_bars(changed), ())
        other_inputs, other_targets = {}, {}
        add_motif_targets(other, other_inputs, other_targets, 4)
        self.assertTrue((inputs['motif_tokens'] == other_inputs['motif_tokens']).all())
        self.assertNotEqual(float(targets['motif_pitch_shift'][0, 0]),
                            float(other_targets['motif_pitch_shift'][0, 0]))

    def test_key_walk_and_midi_strength_tempo_are_masked_by_source(self):
        score = fixture()
        targets = {}
        add_key_direction_targets(score, targets, 4)
        self.assertEqual(int(targets['key_direction'][0, 0]), 2)
        item = MidiItem(score, None, encode_dynamic_score(score), summarize_bars(score), (),
                        {n.source_index: 64 + n.bar * 4 for n in score.events},
                        (True,) * 5, (90.0, 90.0, 90.0, 90.0, 108.0), 0, 4)
        add_expression_targets(item, targets, 4)
        self.assertTrue(bool(targets['phrase_strength_known'][0, 0].all()))
        self.assertTrue(bool(targets['tempo_level_known'][0, 0]))
        self.assertAlmostEqual(float(targets['tempo_level'][0, 0]),
                               __import__('math').log(108.0), places=5)
        self.assertFalse(bool(targets['tempo_level_known'][0, 1]))


if __name__ == '__main__':
    unittest.main()
