#!/usr/bin/env python3
import sys
import unittest
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_v1_state import (ChordEvent, CompositionState, InstrumentControl,
                                  TempoControl, resolve_group_activity, resolve_tempo)  # noqa: E402
from score_events_v2 import ScoreEvents  # noqa: E402


def score_fixture():
    return ScoreEvents.from_candidate({
        'scoreId': 'v1-state',
        'parts': [{'id': 'v', 'group': 'high_strings'}],
        'measures': [{'on': '0', 'dur': '3', 'meter': [3, 4]},
                     {'on': '3', 'dur': '3', 'meter': [3, 4]}],
        'notes': [{'bar': 0, 'on': '2', 'dur': '7/3', 'pitch': 72,
                   'writtenPitch': 72, 'part': 'v', 'staff': '1', 'voice': '1',
                   'group': 'high_strings', 'role': 'mel', 'tuplet': '3:2'}],
    })


class StateTest(unittest.TestCase):
    def setUp(self):
        self.score = score_fixture()
        self.controls = tuple(InstrumentControl('fixed', role='mel', low=60, high=84)
                              if i == 4 else InstrumentControl('off') for i in range(6))

    def test_exact_cross_bar_duration_locks_and_registry(self):
        state = CompositionState()
        note = self.score.events[0]
        locked_chord = ChordEvent(Fraction(0), 0, 0, hard_locked=True)
        first = state.commit_bar(self.score.measures[0], proposed_notes=(),
                                 locked_notes=(note,), locked_chords=(locked_chord,),
                                 group_controls=self.controls,
                                 proposed_group_active=(False,) * 6,
                                 tempo=TempoControl('fixed', 96),
                                 proposed_tempo_delta=5.0)
        self.assertEqual(first.notes, (note,))
        self.assertEqual(first.chords, (locked_chord,))
        self.assertEqual(first.qpm, 96)
        self.assertEqual(state.active_notes[0].end, Fraction(13, 3))
        features, identities = state.voice_features()
        self.assertEqual(features.shape, (1, 16))
        self.assertEqual(identities[0], note.voice_id)
        self.assertEqual(features[0, 4], 1)
        state.commit_bar(self.score.measures[1], proposed_notes=(),
                         locked_voice_ids=(note.voice_id,),
                         group_controls=self.controls,
                         proposed_group_active=(False,) * 6,
                         tempo=TempoControl('walk', 96),
                         proposed_tempo_delta=0.05)
        self.assertFalse(state.active_notes)

    def test_constraints_fail_before_state_mutates(self):
        state = CompositionState()
        note = self.score.events[0]
        with self.assertRaisesRegex(ValueError, 'hard-locked voice'):
            state.commit_bar(self.score.measures[0], proposed_notes=(note,),
                             locked_notes=(note,), group_controls=self.controls,
                             proposed_group_active=(False,) * 6,
                             tempo=TempoControl('fixed', 96))
        self.assertEqual(state.next_bar, 0)
        with self.assertRaisesRegex(ValueError, 'inactive'):
            state.commit_bar(self.score.measures[0], proposed_notes=(note,),
                             group_controls=tuple(InstrumentControl('off') for _ in range(6)),
                             proposed_group_active=(True,) * 6,
                             tempo=TempoControl('fixed', 96))
        self.assertEqual(state.next_bar, 0)

    def test_fixed_walk_and_tempo_bounds(self):
        controls = (InstrumentControl('off'), InstrumentControl('fixed'),
                    InstrumentControl('walk'), InstrumentControl('walk'),
                    InstrumentControl('off'), InstrumentControl('fixed'))
        self.assertEqual(resolve_group_activity(controls, (True, False, True, False, True, False)),
                         (False, True, True, False, False, True))
        self.assertEqual(resolve_tempo(TempoControl('fixed', 100), 4.0), 100)
        walk = TempoControl('walk', 100, low=80, high=110, max_log_step=0.15)
        self.assertEqual(resolve_tempo(walk, 4.0), 110)


if __name__ == '__main__':
    unittest.main()
