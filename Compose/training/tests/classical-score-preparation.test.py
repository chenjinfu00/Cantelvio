import sys
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from prepare_classical_scores import identity, part_group, score_events, SOURCE_NAMES
from audit_classical_overlap import audit, signature


XML = '''<score-partwise>
<part-list>
  <score-part id="V"><part-name>Violin 1</part-name><midi-instrument><midi-program>41</midi-program></midi-instrument></score-part>
  <score-part id="C"><part-name>Bb Clarinet</part-name><midi-instrument><midi-program>72</midi-program></midi-instrument></score-part>
</part-list>
<part id="V">
  <measure number="1"><attributes><divisions>12</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
    <direction><direction-type><dynamics><mf/></dynamics></direction-type></direction>
    <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration>
      <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
    <note><pitch><step>E</step><octave>4</octave></pitch><duration>20</duration></note>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>12</duration><tie type="start"/></note>
  </measure>
  <measure number="2"><attributes><time><beats>6</beats><beat-type>8</beat-type></time></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>12</duration><tie type="stop"/></note>
    <note><pitch><step>G</step><octave>4</octave></pitch><duration>24</duration></note>
  </measure>
</part>
<part id="C">
  <measure number="1"><attributes><divisions>12</divisions><transpose><chromatic>-2</chromatic></transpose></attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>36</duration></note>
  </measure>
  <measure number="2"><note><pitch><step>D</step><octave>5</octave></pitch><duration>36</duration></note></measure>
</part>
</score-partwise>'''


class ClassicalScoreTest(unittest.TestCase):
    def test_exact_meter_tuplet_tie_dynamic_and_transposition(self):
        roles = {'violin1': [(0, 3, 'mel')]}
        parts, measures, notes, issues = score_events(ET.fromstring(XML), roles)
        self.assertEqual([m['meter'] for m in measures], [[3, 4], [6, 8]])
        self.assertEqual([m['on'] for m in measures], ['0', '3'])
        self.assertEqual(len(notes), 6)
        d = next(n for n in notes if n['part'] == 'V' and n['pitch'] == 62)
        self.assertEqual((d['on'], d['dur'], d['tuplet']), ('0', '1/3', '3:2'))
        self.assertEqual((d['dynamic'], d['role'], d['group']), ('mf', 'mel', 'high_strings'))
        tied = next(n for n in notes if n['part'] == 'V' and n['pitch'] == 60)
        self.assertEqual((tied['on'], tied['dur']), ('2', '2'))
        clarinet = next(n for n in notes if n['part'] == 'C')
        self.assertEqual((clarinet['writtenPitch'], clarinet['pitch'], clarinet['group']),
                         (72, 70, 'woodwinds'))
        self.assertEqual(issues['merged ties'], 1)

    def test_vocals_are_not_disguised_as_strings(self):
        group, reason = part_group('Soprano', 'voice.soprano', 53)
        self.assertIsNone(group)
        self.assertEqual(reason, 'vocal')

    def test_long_measure_preserves_following_onsets(self):
        xml = XML.replace('<beats>3</beats><beat-type>4</beat-type>',
                          '<beats>2</beats><beat-type>4</beat-type>', 1)
        _, measures, notes, _ = score_events(ET.fromstring(xml))
        self.assertTrue(measures[0]['irregular'])
        self.assertEqual((measures[0]['dur'], measures[1]['on']), ('3', '3'))
        self.assertEqual(next(n for n in notes if n['part'] == 'V' and n['pitch'] == 67)['on'], '4')

    def test_beethoven_ninth_duplicate_identity(self):
        member = 'root/data/Beethoven,_Ludwig_van/Symphony_No.9,_Op.125/4/Beethoven_Op.125_4.mxl'
        self.assertEqual(identity(SOURCE_NAMES[0], member)[2:], ('4', True))
        self.assertEqual(identity(SOURCE_NAMES[2], 'root/symbolic_symphony_set/be4/sheet.xml')[2:],
                         ('4', False))

    def test_existing_work_overlap_is_only_a_warning(self):
        row = {'status': 'candidate', 'composer': 'Beethoven,_Ludwig_van',
               'work': 'Symphony_No.9,_Op.125',
               'compositionKey': 'Beethoven,_Ludwig_van/Symphony_No.9,_Op.125'}
        old = [{'name': 'classical/beethoven_symphony_9_1_example.mid', 'split': 'validation'}]
        report = audit([row], old)
        self.assertEqual(report['possibleHeldoutOverlapCompositions'], 1)
        self.assertEqual(signature('Symphony_No.9,_Op.125')['number'], '9')


if __name__ == '__main__':
    unittest.main()
