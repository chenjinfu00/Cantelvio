#!/usr/bin/env python3
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from audit_midi_performance import tempo_events


def midi(track):
    return b'MThd' + (6).to_bytes(4, 'big') + bytes([0, 0, 0, 1, 1, 0]) + \
        b'MTrk' + len(track).to_bytes(4, 'big') + track


class MidiTempoTest(unittest.TestCase):
    def test_explicit_tempo_and_running_status(self):
        track = bytes([0, 0x90, 60, 90, 0x81, 0, 64, 80,
                       0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20,
                       0, 0xff, 0x2f, 0])
        self.assertEqual(tempo_events(midi(track)), (256, [(128, 120.0)]))

    def test_no_tempo_does_not_become_120(self):
        track = bytes([0, 0xff, 0x2f, 0])
        self.assertEqual(tempo_events(midi(track)), (256, []))

    def test_invalid_header(self):
        with self.assertRaises(ValueError):
            tempo_events(b'broken')


if __name__ == '__main__':
    unittest.main()
