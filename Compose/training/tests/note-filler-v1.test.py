"""note_filler_v1: the tokens of a cleaned score, where an added note goes, the model's shapes and file."""
import importlib.util
import pathlib
import sys
import tempfile
import unittest
from fractions import Fraction as F
from unittest import mock

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import audio_to_score as a2s  # noqa: E402
import note_filler_v1 as nf  # noqa: E402

HAS_TORCH = importlib.util.find_spec('torch') is not None


def part(instrument):
    return a2s.PartInfo(instrument, instrument.title(), '', 0)


def score_of(notes, parts, fifths=0):
    """Two bars of 4/4, two grid points per beat."""
    return a2s.Score('t', 4, False, F(1), F(0), 2, 120., fifths, 'major', parts, notes, {k: 2 for k in range(8)})


def n(on, pitch, part_index, dur=1):
    return a2s.Note(on * .5, (on + dur) * .5, pitch, '', on=F(on), dur=F(dur), part=part_index)


class FrameTests(unittest.TestCase):
    def test_tokens_and_key(self):
        notes = [n(0, 67, 0, 2), n(F(3, 4), 71, 0, F(1, 4)), n(2, 74, 0), n(4, 43, 1, 4)]
        f = nf.frame(notes, score_of(notes, [part('violin'), part('cello')], fifths=1), None)
        # every onset (3/4 too) and every point of the beat's grid, in beats
        self.assertEqual(f['times'], sorted({F(k, 2) for k in range(16)} | {F(3, 4)}))
        self.assertEqual(f['shift'], 5)                                  # G major is read in C major
        self.assertEqual(nf.LOW + f['notePitch'][0], 72)                 # G4 -> C5
        self.assertEqual(f['away'][1][0], f['times'].index(F(1)))        # one beat later
        self.assertEqual(f['beat'][f['times'].index(F(5))], 1)           # beat 2 of bar 2
        tokens, local = nf.features(f, 0, len(f['times']))
        self.assertEqual(tokens.shape, (len(f['times']), nf.TOKEN_FEATURES))
        self.assertEqual(local.shape, (len(f['times']), nf.PITCHES, nf.LOCAL_FEATURES))


class FillerTests(unittest.TestCase):
    def test_where_an_added_note_goes(self):
        flute, piano = n(1, 72, 0), n(1, 48, 1, 2)
        notes = [n(0, 74, 0), flute, piano, n(3, 50, 1)]
        score = score_of(notes, [part('flute'), part('piano')])
        f = nf.frame(notes, score, None)
        prob = np.zeros((len(f['times']), nf.PITCHES), np.float32)
        at = f['times'].index(F(1))
        prob[at, 69 - nf.LOW] = .9            # A4: closest to the flute's C5, but a flute plays one note at a time
        prob[at, 72 - nf.LOW] = .9            # C5 is there already
        prob[f['times'].index(F(3, 2)), 76 - nf.LOW] = .2                # below the threshold
        filler = nf.Filler(None, {'threshold': .5})
        with mock.patch.object(nf, 'predict', return_value=prob):
            added = filler(notes, score, None, lambda q: float(q) * .5)
        self.assertEqual(added['filler'], 1)
        new = notes[-1]
        self.assertEqual((new.on, new.pitch, new.part, new.dur, new.added), (F(1), 69, 1, F(2), 'filler'))
        self.assertAlmostEqual(new.start, .5)


@unittest.skipUnless(HAS_TORCH, 'torch is missing')
class ModelTests(unittest.TestCase):
    def test_shapes_and_file(self):
        import torch
        model = nf.build_model({'d': 32, 'layers': 1, 'heads': 2, 'ff': 64, 'dropout': 0.})
        notes = [n(k, 60 + 2 * k, 0) for k in range(6)]
        f = nf.frame(notes, score_of(notes, [part('piano')]), None)
        tokens, local = nf.features(f, 0, len(f['times']))
        logits = model(torch.from_numpy(tokens)[None], torch.from_numpy(local)[None],
                       torch.zeros(1, len(tokens), dtype=torch.bool))
        self.assertEqual(tuple(logits.shape), (1, len(tokens), nf.PITCHES))
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'weights.pt'
            nf.save(model, path, {'step': 0, 'threshold': .6})
            loaded, info = nf.load(path)
            self.assertEqual(info['threshold'], .6)
            self.assertEqual(nf.load_filler(str(path)).threshold, .6)
            self.assertIsNone(nf.load_filler('none'))
            prob = nf.predict(loaded, f, window=8, hop=4)            # overlapping windows cover every token
            self.assertEqual(prob.shape, (len(f['times']), nf.PITCHES))
            self.assertTrue(((prob > 0) & (prob < 1)).all())


if __name__ == '__main__':
    unittest.main()
