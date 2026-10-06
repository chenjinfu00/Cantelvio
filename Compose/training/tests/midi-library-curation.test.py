#!/usr/bin/env python3
"""Check that the reviewed browsing/training selection remains internally consistent."""

import json
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from curate_midi_library import digest, review_policy, selected_hash  # noqa: E402


class MidiLibraryCurationTest(unittest.TestCase):
    def test_reviewed_selection(self):
        data = ROOT / 'data'
        active_dir = data / 'MIDI-Library'
        excluded_dir = data / 'MIDI-Library-Excluded-20260929'
        active = json.loads((active_dir / 'manifest.json').read_text())
        excluded = json.loads((excluded_dir / 'manifest.json').read_text())
        original = json.loads((excluded_dir / 'manifest-before-review.json').read_text())
        policy = json.loads((data / 'midi-library-curation.json').read_text())

        self.assertEqual(original['count'], 145)
        self.assertEqual(active['count'], len(active['files']))
        self.assertEqual(excluded['count'], len(excluded['files']))
        self.assertEqual(active['count'] + excluded['count'], original['count'])
        self.assertEqual(active['selectionSha256'], selected_hash(active['files']))
        self.assertEqual(policy['sourceSelectionSha256'], original['selectionSha256'])
        reasons = review_policy(original, policy)
        expected = {policy.get('renames', {}).get(row['file'], row['file']): row['sha256']
                    for row in original['files'] if row['file'] not in reasons}
        self.assertEqual(expected, {row['file']: row['sha256'] for row in active['files']})
        self.assertEqual(set(reasons), {row['file'] for row in excluded['files']})
        self.assertEqual({p.name for p in active_dir.glob('*.mid')},
                         {row['file'] for row in active['files']})
        self.assertEqual({p.name for p in excluded_dir.glob('*.mid')},
                         {row['file'] for row in excluded['files']
                          if row['disposition'] == 'moved-to-quarantine'})
        self.assertEqual({row['sourceRelativePath'] for row in active['files']} |
                         {row['sourceRelativePath'] for row in excluded['files']},
                         {row['sourceRelativePath'] for row in original['files']})
        for row in active['files']:
            self.assertEqual(digest(active_dir / row['file']), row['sha256'])
        for row in excluded['files']:
            if row['disposition'] == 'moved-to-quarantine':
                self.assertEqual(digest(excluded_dir / row['file']), row['sha256'])
            else:
                source = excluded_dir / row['recoverableUpstream']
                self.assertEqual(digest(source), row['sha256'])


if __name__ == '__main__':
    unittest.main()
