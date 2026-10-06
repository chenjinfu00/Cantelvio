"""Harmonizer v1 (melody -> chords) and the harmonic-analysis model v2 (melody + every note -> chords): melody
grid as in the Lieder joint corpus, inputs and targets under transposition, Viterbi and harmonic-rhythm decoding,
chord changes per bar, the model, save/load, long melodies, and (with trained weights) both models' answers."""
import math
import pathlib
import sys
import tempfile
import unittest
from fractions import Fraction

import numpy as np
import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import harmonizer_v1 as hz  # noqa: E402
from four_pillar_v31_tonal import QUALITY_INDEX  # noqa: E402

F = Fraction
RUN = pathlib.Path(__file__).resolve().parents[1] / 'runs/harmonizer-v1-20261003/weights.pt'
ANALYSIS = pathlib.Path(__file__).resolve().parents[1] / 'runs/harmonizer-v2-20261003/weights.pt'
SMALL = {**hz.CONFIG, 'width': 32, 'heads': 2, 'layers': 1, 'ff': 64, 'steps': 64}
MAJ, MIN = QUALITY_INDEX['maj'], QUALITY_INDEX['min']


class GridTests(unittest.TestCase):
    def test_four_four_bar(self):
        notes = [(0, 1, 60), (1, F(1, 2), 62), (F(3, 2), F(1, 2), 64), (3, 1, 65)]
        g = hz.melody_grid(notes, [(F(4), (4, 4))])
        self.assertEqual(len(g['bar']), 16)
        self.assertEqual(g['pos'].tolist(), list(range(16)))
        self.assertEqual(g['level'].tolist()[:5], [0, 3, 2, 3, 1])
        self.assertEqual(g['meter'].tolist(), [hz.METERS[(4, 4)]] * 16)
        self.assertEqual(g['mel_pitch'].tolist(), [60] * 4 + [62] * 2 + [64] * 2 + [-1] * 4 + [65] * 4)
        self.assertEqual(np.flatnonzero(g['mel_on']).tolist(), [0, 4, 6, 12])

    def test_pickup_ends_at_the_barline(self):
        g = hz.melody_grid([(0, 1, 67), (1, 3, 72)], [(F(1), (3, 4)), (F(3), (3, 4))])
        self.assertEqual(g['pos'].tolist()[:4], [8, 9, 10, 11])         # a one-beat pickup in 3/4
        self.assertEqual(g['level'].tolist()[:4], [1, 3, 2, 3])
        self.assertEqual(g['starts'], [0, 4])
        self.assertEqual(g['bar'].tolist()[3:5], [0, 1])

    def test_key_signatures(self):
        g = hz.melody_grid([(0, 4, 62)], [(F(2), (2, 4), 2), (F(2), (2, 4), -3), (F(2), (2, 4))])
        self.assertEqual(g['keysig'].tolist(), [2] * 8 + [3] * 8 + [hz.UNKNOWN_KEYSIG] * 8)   # D, Eb, unknown
        x = hz.inputs(g, 0, 24, shift=-2)
        self.assertEqual(x['keysig'].tolist(), [0] * 8 + [1] * 8 + [hz.UNKNOWN_KEYSIG] * 8)

    def test_skyline_and_later_onsets(self):
        g = hz.melody_grid([(0, 2, [60, 64, 67]), (1, 1, 62)], [(F(2), (2, 4))])
        self.assertEqual(g['mel_pitch'].tolist(), [67] * 4 + [62] * 4)    # top note; a later onset replaces it
        self.assertEqual(np.flatnonzero(g['mel_on']).tolist(), [0, 4])

    def test_inputs_and_targets_under_transposition(self):
        arrays = {'mel_pitch': np.array([60, 60, -1, 71]), 'mel_on': np.array([1, 0, 0, 1]),
                  'pos': np.array([0, 1, 2, 3]), 'level': np.array([0, 3, 2, 3]), 'meter': np.array([2, 2, 2, -1]),
                  'ch_root': np.array([0, 0, 7, -1]), 'ch_q': np.array([MAJ, MAJ, MAJ, MAJ])}
        x = hz.inputs(arrays, 0, 4, shift=3)
        self.assertEqual(x['pc'].tolist(), [3, 3, hz.REST_PC, 2])
        self.assertEqual(x['octave'].tolist(), [3, 3, hz.REST_OCTAVE, 4])
        self.assertEqual(x['onset'].tolist(), [1, 0, 0, 1])
        self.assertEqual(x['meter'].tolist(), [2, 2, 2, hz.UNKNOWN_METER])
        self.assertEqual(hz.targets(arrays, 0, 4, shift=3).tolist(), [MAJ * 12 + 3, MAJ * 12 + 3, MAJ * 12 + 10, -100])
        self.assertEqual(hz.FAMILY[QUALITY_INDEX['dom7']], hz.FAMILY[MAJ])
        self.assertEqual(hz.FAMILY[QUALITY_INDEX['half']], hz.FAMILY[QUALITY_INDEX['dim']])


class DecodeTests(unittest.TestCase):
    def test_viterbi_follows_clear_evidence_and_prefers_strong_beats(self):
        k = hz.N_CLASSES
        level = np.array([0, 3, 2, 3, 1, 3, 2, 3])
        change = np.log([.8, .3, .05, .001])
        logp = np.full((8, k), math.log(1e-6))
        logp[:4, 0], logp[4:, 0] = math.log(.95), math.log(.01)
        logp[:4, 1], logp[4:, 1] = math.log(.01), math.log(.95)
        self.assertEqual(hz.viterbi(logp, level, change).tolist(), [0, 0, 0, 0, 1, 1, 1, 1])
        logp[4, 0] = logp[4, 1] = math.log(.5)          # ambiguous on the beat: change there, not after it
        self.assertEqual(hz.viterbi(logp, level, change).tolist(), [0, 0, 0, 0, 1, 1, 1, 1])
        weak = np.full((8, k), math.log(1e-6))
        weak[:, 0] = math.log(.5)
        weak[4:, 1] = math.log(.9)
        self.assertEqual(hz.viterbi(weak, level, change, penalty=1.).tolist(), [0] * 8)   # not worth a change
        self.assertEqual(hz.viterbi(weak, level, change, penalty=0.).tolist(), [0] * 4 + [1] * 4)

    def test_harmonic_rhythm_masks(self):
        g = hz.melody_grid([], [(F(4), (4, 4))] * 2 + [(F(3), (3, 4))] * 2)
        steps = lambda rhythm: np.flatnonzero(hz.change_mask(g, rhythm)).tolist()    # noqa: E731
        self.assertIsNone(hz.change_mask(g, 'auto'))
        self.assertEqual(steps('beat'), [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52])
        self.assertEqual(steps('half-bar'), [0, 8, 16, 24, 32, 44])      # 3/4 has no beat in the middle
        self.assertEqual(steps('bar'), [0, 16, 32, 44])
        self.assertEqual(steps('two-bars'), [0, 32])
        with self.assertRaises(ValueError):
            hz.change_mask(g, 'often')

    def test_segment_decoding_keeps_one_chord_per_segment(self):
        k = hz.N_CLASSES
        logp = np.full((8, k), math.log(1e-6))
        logp[:3, 0], logp[3:, 1] = math.log(.9), math.log(.9)        # the evidence changes off the grid
        allowed = np.array([True, False, False, False, True, False, False, False])
        path = hz.segment_viterbi(logp, allowed, .6)
        self.assertEqual(path.tolist(), [0] * 4 + [1] * 4)

    def test_chord_changes_per_bar(self):
        g = hz.melody_grid([], [(F(1), (4, 4)), (F(4), (4, 4))])
        path = np.array([MAJ * 12] * 4 + [MAJ * 12] * 8 + [MIN * 12 + 9] * 8)
        self.assertEqual(hz.chord_changes(path, g), {0: [(F(0), 0, MAJ)], 1: [(F(2), 9, MIN)]})


class ModelTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(0)
        self.model = hz.Harmonizer(SMALL).eval()

    def test_shapes_padding_and_save_load(self):
        notes = [(i, 1, 60 + (i * 5) % 12) for i in range(8)]
        g = hz.melody_grid(notes, [(F(4), (4, 4))] * 2)
        x = {k: torch.as_tensor(v)[None] for k, v in hz.inputs(g, 0, 32).items()}
        with torch.no_grad():
            logits = self.model(x)
            self.assertEqual(tuple(logits.shape), (1, 32, hz.N_CLASSES))
            padded = {k: torch.cat([v, torch.zeros((1, 8, *v.shape[2:]), dtype=v.dtype)], 1) for k, v in x.items()}
            mask = torch.zeros(1, 40, dtype=torch.bool)
            mask[0, 32:] = True
            self.assertTrue(torch.allclose(self.model(padded, mask)[0, :32], logits[0], atol=1e-5))
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'weights.pt'
            hz.save(self.model, path, {'changeLogp': [-.3, -1.4, -3.3, -6.5], 'step': 1})
            again, info = hz.load(path)
            with torch.no_grad():
                self.assertTrue(torch.equal(again(x), logits))
            self.assertEqual(info['step'], 1)

    def test_long_melodies_are_read_in_windows(self):
        notes = [(i, 1, 60 + (i * 7) % 12) for i in range(80)]           # 20 bars = 320 steps > 64
        g = hz.melody_grid(notes, [(F(4), (4, 4))] * 20)
        logp = hz.posteriors(self.model, g)
        self.assertEqual(logp.shape, (320, hz.N_CLASSES))
        self.assertTrue(np.isfinite(logp).all())
        self.assertTrue(np.allclose(np.exp(logp).sum(-1), 1, atol=1e-6))
        changes, path = hz.harmonize(self.model, {'changeLogp': [-.3, -1.4, -3.3, -6.5]}, notes,
                                     [(F(4), (4, 4))] * 20)
        self.assertEqual(len(path), 320)
        self.assertIn(0, changes)


@unittest.skipUnless(RUN.exists(), 'trained harmonizer weights not present')
class TrainedTests(unittest.TestCase):
    def test_twinkle_starts_on_the_tonic(self):
        model, info = hz.load(RUN)
        melody = [(0, 72), (1, 72), (2, 79), (3, 79), (4, 81), (5, 81), (6, 79), (6, 79),
                  (8, 77), (9, 77), (10, 76), (11, 76), (12, 74), (13, 74), (14, 72)]
        notes = [(o, 1 if i < len(melody) - 1 else 2, p) for i, (o, p) in enumerate(melody)]
        changes, path = hz.harmonize(model, info, notes, [(F(4), (4, 4))] * 4)
        self.assertEqual(changes[0][0][:2], (F(0), 0))                     # C ...
        self.assertEqual(hz.FAMILY[changes[0][0][2]], hz.FAMILY[MAJ])      # ... major
        self.assertEqual(int(path[-1]) % 12, 0)                            # ends on C
        sparse, _ = hz.harmonize(model, info, notes, [(F(4), (4, 4))] * 4, rhythm='bar')
        self.assertTrue(all(len(v) <= 1 and v[0][0] == 0 for v in sparse.values()))


@unittest.skipUnless(ANALYSIS.exists(), 'trained analysis weights not present')
class TrainedAnalysisTests(unittest.TestCase):
    def test_a_cadence_is_read_from_every_note(self):
        model, info = hz.load(ANALYSIS)
        voicings = [[48, 55, 64, 72], [41, 60, 65, 69], [43, 59, 65, 74], [48, 55, 64, 72]]     # C F G7 C
        texture = [(4 * b, 4, p) for b, chord in enumerate(voicings) for p in chord]
        melody = [(4 * b, 4, chord[-1]) for b, chord in enumerate(voicings)]
        expected = [[(F(0), 0, 'maj')], [(F(0), 5, 'maj')], [(F(0), 7, 'dom7')], [(F(0), 0, 'maj')]]
        for rhythm in ('auto', 'bar'):
            changes, _ = hz.harmonize(model, info, melody, [(F(4), (4, 4), 0)] * 4, texture=texture, rhythm=rhythm)
            self.assertEqual([[(o, r, hz.QUALITIES[q]['id']) for o, r, q in changes[b]] for b in range(4)],
                             expected, rhythm)


if __name__ == '__main__':
    unittest.main()
