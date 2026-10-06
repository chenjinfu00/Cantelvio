#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_split import build_split  # noqa: E402


class SplitTest(unittest.TestCase):
    def test_smoke_selection_is_disjoint_and_excludes_old_test(self):
        split = build_split(smoke=True)
        train, val = split['scores']['train'], split['scores']['validation']
        self.assertTrue(train and val)
        self.assertFalse({x['composer'] for x in train} & {x['composer'] for x in val})
        self.assertFalse({x['scoreSha256'] for x in train} & {x['scoreSha256'] for x in val})
        self.assertGreaterEqual(split['excluded'].get('possible_old_test_overlap', 0), 1)
        self.assertEqual(split['schema'], 'four-pillar-provisional-score-split-v1')


if __name__ == '__main__':
    unittest.main()
