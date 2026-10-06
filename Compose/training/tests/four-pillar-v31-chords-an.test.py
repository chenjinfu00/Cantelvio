#!/usr/bin/env python3
"""Tests for four_pillar_v31_chords_an (AugmentedNet chord sidecar for v3.1 training)."""
import gzip
import json
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import four_pillar_v31_chords_an as C  # noqa: E402


def fake_score(bars=4, length=4, score_id='s1'):
    measures = [SimpleNamespace(onset=Fraction(i * length), duration=Fraction(length)) for i in range(bars)]
    return SimpleNamespace(score_id=score_id, measures=measures)


class ChordsForBars(unittest.TestCase):
    def test_changes_only_and_first_bar_holds_chord(self):
        score = fake_score()
        spans = [(0.0, 0, 0), (2.0, 0, 0), (4.0, 7, 10), (6.0, 7, 10), (9.0, 5, 0)]
        out = C.chords_for_bars(score, spans, 0, 3)
        self.assertEqual(out, {0: [(Fraction(0), 0, 0)], 1: [(Fraction(0), 7, 10)], 2: [(Fraction(1), 5, 0)]})

    def test_window_starting_mid_score_gets_the_chord_in_effect(self):
        score = fake_score()
        spans = [(0.0, 0, 0), (4.0, 7, 10), (9.0, 5, 0)]
        out = C.chords_for_bars(score, spans, 2, 3)
        self.assertEqual(out[2][0], (Fraction(0), 7, 10))      # chord sounding since bar 1
        self.assertEqual(out[2][1], (Fraction(1), 5, 0))

    def test_offsets_snap_to_eighths_and_stay_inside_the_bar(self):
        score = fake_score(bars=2)
        out = C.chords_for_bars(score, [(0.0, 0, 0), (3.99999, 7, 0)], 0, 1)
        offsets = [o for spans in out.values() for o, *_ in spans]
        self.assertTrue(all(0 <= o < 4 for o in offsets))

    def test_no_spans_before_first_uses_first_span(self):
        score = fake_score()
        out = C.chords_for_bars(score, [(5.0, 2, 1)], 0, 3)
        self.assertEqual(out[0][0], (Fraction(0), 2, 1))


class Sidecar(unittest.TestCase):
    def test_build_and_install_replace_only_listed_scores(self):
        import four_pillar_v31_data as D
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / 'an').mkdir()
            (tmp / 'an' / 'abc.json').write_text(json.dumps({'file': 'abc.mxl', 'chords': [[0.0, 7, 0, 1.0, 7, 0, 'I'],
                                                                                            [4.0, 2, 10, 1.0, 7, 0, 'V7']]}))
            (tmp / 'an' / 'bad.json').write_text(json.dumps({'file': 'bad.mxl', 'error': 'x', 'chords': []}))
            (tmp / 'map.json').write_text(json.dumps({'abc': 'score-A', 'bad': 'score-B'}))
            side = tmp / 'side.json.gz'
            C.build([(tmp / 'an', tmp / 'map.json')], side)
            self.assertEqual(json.loads(gzip.open(side, 'rt').read()), {'score-A': [[0.0, 7, 0], [4.0, 2, 10]]})
            original = D.analyze

            def fake_base(score, source, labels=None, first=0, last=None):
                return {'keys': [0] * len(score.measures), 'chords': {0: [(Fraction(0), 1, 1)]}, 'chordSource': 'tracker'}
            try:
                D.analyze = fake_base
                C.install(side)
                again = D.analyze
                C.install(side)
                self.assertIs(D.analyze, again)                      # idempotent
                a = D.analyze(fake_score(score_id='score-A'), 'classical-scores', None, 0, 3)
                self.assertEqual(a['chordSource'], 'augmentednet-v1')
                self.assertEqual(a['chords'][1], [(Fraction(0), 2, 10)])
                self.assertEqual(a['keys'], [0] * 4)                 # keys stay with KeyTracker
                b = D.analyze(fake_score(score_id='other'), 'classical-scores', None, 0, 3)
                self.assertEqual(b['chordSource'], 'tracker')
                lieder = D.analyze(fake_score(score_id='score-A'), 'Lieder', None, 0, 3)
                self.assertEqual(lieder['chordSource'], 'augmentednet-v1')   # sidecar wins for listed ids
            finally:
                D.analyze = original
                C._CACHE.clear()


if __name__ == '__main__':
    unittest.main()
