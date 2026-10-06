#!/usr/bin/env python3
import sys
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from prepare_performance_labels import scan_score


class PerformanceLabelsTest(unittest.TestCase):
    def test_explicit_dotted_metronome_and_sound_dynamics(self):
        xml = '''<score-partwise><part id="P1"><measure>
          <attributes><divisions>8</divisions></attributes>
          <direction><direction-type><metronome><beat-unit>eighth</beat-unit>
            <beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type>
          </direction>
          <note><duration>8</duration></note>
          <direction><sound dynamics="75.5" tempo="92"/></direction>
        </measure></part></score-partwise>'''
        events, issues = scan_score(ET.fromstring(xml))
        self.assertEqual([(e['kind'], e['offsetQuarter'], e['value']) for e in events],
                         [('tempo-qpm', '0', 45.0), ('sound-dynamics', '1', 75.5),
                          ('tempo-qpm', '1', 92.0)])
        self.assertEqual(issues['conflictingTempoPositions'], 0)

    def test_missing_tempo_stays_missing(self):
        xml = '''<score-partwise><part id="P1"><measure>
          <direction><direction-type><words>Allegro</words></direction-type></direction>
          <note><duration>1</duration></note>
        </measure></part></score-partwise>'''
        events, issues = scan_score(ET.fromstring(xml))
        self.assertEqual(events, [])
        self.assertEqual(issues['wordDirections'], 1)

    def test_duplicate_parts_and_conflict_are_visible(self):
        xml = '''<score-partwise>
          <part id="P1"><measure><sound tempo="100"/></measure></part>
          <part id="P2"><measure><sound tempo="100"/></measure></part>
          <part id="P3"><measure><sound tempo="120"/></measure></part>
        </score-partwise>'''
        events, issues = scan_score(ET.fromstring(xml))
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]['parts'], ['P1', 'P2'])
        self.assertEqual(issues['conflictingTempoPositions'], 1)


if __name__ == '__main__':
    unittest.main()
