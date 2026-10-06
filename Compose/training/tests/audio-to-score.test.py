"""audio_to_score: beats -> score time, rhythm grids, parts and hands, keeping notes, spelling, MusicXML."""
import importlib.util
import pathlib
import sys
import unittest
import xml.etree.ElementTree as ET
from unittest import mock
from collections import Counter, defaultdict
from fractions import Fraction as F

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import audio_to_score as a2s  # noqa: E402

ANALYSIS = pathlib.Path(__file__).resolve().parents[1] / 'runs/harmonizer-v2-20261003/weights.pt'
HAS_TORCH = importlib.util.find_spec('torch') is not None          # the harmony check needs it


def note(start, end, pitch, instrument='acoustic_piano', on=None, dur=None, part=0):
    n = a2s.Note(start, end, pitch, instrument)
    n.on = F(on) if on is not None else F(round(start / .5 * 4), 4)
    n.dur = F(dur) if dur is not None else F(1)
    n.part = part
    return n


class BeatTests(unittest.TestCase):
    def test_beat_map_interpolates_and_extrapolates(self):
        m = a2s.BeatMap([1., 1.5, 2.1, 2.6, 3.1])
        self.assertAlmostEqual(float(m.beat(1.5)), 1.)
        self.assertAlmostEqual(float(m.beat(1.8)), 1.5)
        self.assertAlmostEqual(float(m.beat(.5)), -1.)                            # head interval .5 s
        self.assertAlmostEqual(float(m.beat(3.6)), 5.)                            # tail interval .5 s

    def test_slips_of_the_beat_tracker(self):
        beats = [0., .5, 1., 1.5, 2.5, 3., 3.5, 4., 4.2, 4.5, 5., 6.5, 7., 7.5]
        onsets = [2.0, 2.01, 5.5]                     # a note on the missing beat at 2.0, none in the 5.0-6.5 gap...
        fixed = a2s.regularize_beats(beats, onsets).tolist()
        self.assertIn(2.0, fixed)                     # missed beat restored where a note starts
        self.assertNotIn(4.2, fixed)                  # spurious beat dropped
        self.assertIn(5.5, fixed)                     # 5.0 -> 6.5 is three beats and a note starts at 5.5
        quiet = a2s.regularize_beats([0., .5, 1., 1.5, 2., 3., 3.5, 4.], [0., .5, 1.]).tolist()
        self.assertNotIn(2.5, quiet)                  # a fermata (no onsets) keeps its gap

    def test_lag_and_metre(self):
        beats = np.arange(0, 30, .5)
        m = a2s.BeatMap(beats)
        onsets = [b + .03 + .25 * (i % 2) for i, b in enumerate(beats[:-1])]
        self.assertAlmostEqual(a2s.onset_lag(onsets, m), .03, places=2)
        self.assertEqual(a2s.metre(m, beats[1::3]), (3, 1))
        self.assertEqual(a2s.metre(m, []), (4, 0))
        self.assertEqual(a2s.parse_metre('6/8'), (2, True))
        self.assertEqual(a2s.parse_metre('3/4'), (3, False))

    def test_subdivisions_follow_the_onsets(self):
        groups = {0: [0., 1 / 3, 2 / 3], 1: [0., .5], 2: [0., .25, .5, .75], 3: [0.], 4: [0., 1 / 3, 2 / 3]}
        sub = a2s._viterbi_subdivisions(groups, 0, 4, a2s.SIMPLE, lambda k: .6)
        self.assertEqual([sub[k] for k in range(5)], [3, 2, 4, 1, 3])
        self.assertEqual(a2s.snap(2.26, sub), F(9, 4))
        self.assertEqual(a2s.snap(3.98, sub), F(4))                  # just before a beat belongs to it
        self.assertEqual(a2s.snap(4.32, sub), F(13, 3))


class PartTests(unittest.TestCase):
    def test_groups_become_catalog_parts(self):
        notes = ([note(i * .1, i * .1 + .3, 72 + i % 5, 'violin') for i in range(60)]
                 + [note(i * .1, i * .1 + .3, 48 + i % 5, 'cello') for i in range(60)]
                 + [note(1., 1.2, 60, 'organ')]                                       # stray label: merged
                 + [note(i * .2, i * .2 + .1, 36, 'drums') for i in range(10)]
                 + [note(i * .2, i * .2 + .4, 70 + i % 3, 'string_ensemble') for i in range(50)]
                 + [note(i * .2, i * .2 + .4, 50 + i % 3, 'string_ensemble') for i in range(50)])
        parts, stats = a2s.assign_parts(notes)
        self.assertEqual([p.instrument for p in parts], ['violin', 'violin', 'cello', 'cello'])
        self.assertEqual([p.name for p in parts], ['Violin 1', 'Violin 2', 'Violoncello 1', 'Violoncello 2'])
        self.assertEqual(stats['drums'], 10)
        self.assertEqual(stats['mergedGroups'], ['organ'])
        self.assertTrue(all(n.part >= 0 for n in notes if n.instrument != 'drums'))
        voice, _ = a2s.assign_parts([note(i * .3, i * .3 + .3, 45 + i % 4, 'voice') for i in range(50)])
        self.assertEqual((voice[0].instrument, voice[0].clef), ('bass-voice', ('F4',)))

    def test_a_choir_becomes_a_part_per_voice(self):
        # a four-part chorale under MuScriptor's one 'voice' label: a part per line, soprano to bass
        lines = [(72, 74, 76, 74), (64, 65, 67, 65), (57, 59, 60, 59), (48, 50, 52, 43)]
        notes = [note(k * .5, k * .5 + .45, line[k % 4], 'voice', on=k, dur=1) for k in range(24) for line in lines]
        parts, stats = a2s.assign_parts(notes)
        self.assertEqual([p.instrument for p in parts], ['soprano', 'alto', 'tenor', 'bass-voice'])
        self.assertEqual(stats['voiceLines'], 4)
        self.assertTrue(all(n.part == next(i for i, line in enumerate(lines) if n.pitch in line) for n in notes))
        # one singer with a few doubled onsets (transcription errors) stays one line
        solo = [note(k * .5, k * .5 + .45, 70 + k % 3, 'voice', on=k, dur=1) for k in range(40)]
        solo += [note(k * .5, k * .5 + .2, 58, 'voice', on=k, dur=F(1, 2)) for k in range(0, 40, 8)]
        self.assertEqual(a2s.choir_lines(solo), {})

    def test_hands(self):
        chord = [note(0, 1, p, on=0) for p in (43, 50, 55, 67, 72, 76)]
        a2s.split_hands(chord)
        self.assertEqual([n.staff for n in chord], [1, 1, 1, 0, 0, 0])


class KeepTests(unittest.TestCase):
    def test_rules(self):
        stats = Counter()
        bass = note(0., 1., 48, on=0, dur=2)
        ghost = note(.01, .15, 60, on=0, dur=F(1, 4))             # an octave above, short, alone
        line = [note(.7 + .1 * i, .78 + .1 * i, 72 + i, on=F(3, 2) + F(i, 4), dur=F(1, 4)) for i in range(4)]
        doubled = note(.7, .9, 60, on=F(3, 2), dur=F(1, 2))       # octave below a line note: not a ghost (lower)
        blip = note(3., 3.03, 90, on=6, dur=F(1, 4))
        dup = note(.71, .75, 72, on=F(3, 2), dur=F(1, 4))
        notes = [bass, ghost, *line, doubled, blip, dup]
        a2s.clean_rules(notes, stats)
        self.assertEqual(ghost.removed, 'ghost')
        self.assertEqual(blip.removed, 'blip')
        self.assertEqual(dup.removed, 'duplicate')
        self.assertFalse(any(n.removed for n in line + [bass, doubled]))
        self.assertEqual(stats, Counter({'ghost': 1, 'blip': 1, 'duplicate': 1}))

    def test_harmony_check_keeps_lines_and_the_top(self):
        stats = Counter()
        chords = {s: {0, 4, 7} for s in range(32)}                 # C major throughout
        passing = [note(0, .15, 64, on=0, dur=F(1, 4)), note(.15, .3, 65, on=F(1, 4), dur=F(1, 4)),
                   note(.3, .45, 67, on=F(1, 2), dur=F(1, 4))]
        top = note(0, 1, 79, on=0, dur=2)
        stray = note(.6, .7, 61, on=1, dur=F(1, 4))               # C#: off the chord and off any line
        notes = passing + [top, stray]
        a2s.clean_harmony(notes, chords, F(1), .5, stats)
        self.assertEqual(stray.removed, 'off-harmony')
        self.assertFalse(any(n.removed for n in passing + [top]))

    def test_harmony_check_keeps_a_pitch_class_that_comes_back(self):
        stats = Counter()
        chords = {s: {0, 4, 7} for s in range(64)}                 # C major throughout
        melody = note(0, 4, 84, on=0, dur=8, part=1)               # above everything: no figure note is the top
        figure = [note(.5 * k, .5 * k + .1, p, on=k, dur=F(1, 4)) for k, p in ((0, 61), (1, 66), (2, 61))]
        a2s.clean_harmony([melody, *figure], chords, F(1), .5, stats)
        self.assertEqual([n.removed for n in figure], ['', 'off-harmony', ''])    # C# comes back, F# does not

    def test_voices_and_durations(self):
        stats = Counter()
        melody = [note(0, .5, 72, on=0, dur=F(3, 4)), note(.5, 1., 74, on=1, dur=F(1))]
        held = note(0, 1., 60, on=0, dur=2)
        a2s.tidy_durations(melody + [held], stats)
        a2s.assign_voices(melody + [held], stats)
        a2s.legato(melody + [held], stats)
        self.assertEqual([n.voice for n in melody], [0, 0])
        self.assertEqual(held.voice, 1)
        self.assertEqual(melody[0].dur, F(1))                      # reaches the next note of its voice


class SpellingTests(unittest.TestCase):
    def test_keys_and_spelling(self):
        self.assertEqual(a2s.spell(66, 2, 'major'), ('F', 1, 4))
        self.assertEqual(a2s.spell(70, -1, 'major'), ('B', -1, 4))
        self.assertEqual(a2s.spell(68, 0, 'minor'), ('G', 1, 4))   # raised seventh of A minor
        self.assertEqual(a2s.spell(61, -1, 'minor'), ('C', 1, 4))  # raised seventh of D minor
        self.assertEqual(a2s.spell(63, -3, 'major'), ('E', -1, 4))
        self.assertEqual(a2s.spell(60, 7, 'major'), ('B', 1, 3))   # C# major: B# is C
        self.assertEqual(a2s.written('C', 0, 4, (-1, -2)), ('D', 0, 4))      # clarinet in B-flat
        self.assertEqual(a2s.written('B', -1, 3, (-1, -2)), ('C', 0, 4))
        self.assertEqual(a2s.written('C', 0, 3, (-7, -12)), ('C', 0, 4))     # double bass
        notes = [note(i, i + .9, p) for i, p in enumerate([62, 66, 69, 62, 64, 66, 67, 69, 71, 73, 74, 69])]
        self.assertEqual(a2s.estimate_key(notes), (2, 'major'))

    def test_pieces(self):
        self.assertEqual([(d, t, dots) for _, d, t, dots, _ in a2s.pieces(0, 96, 24, set())], [(96, 'whole', 0)])
        self.assertEqual([(p, d) for p, d, *_ in a2s.pieces(6, 30, 24, set())], [(6, 18), (24, 12)])
        whole_beat = a2s.pieces(24, 32, 24, {1, 2})                 # a whole triplet beat is a plain quarter
        self.assertEqual([(d, t, x) for _, d, t, _, x in whole_beat], [(24, 'quarter', False), (8, 'eighth', True)])
        inside = a2s.pieces(32, 16, 24, {1})                         # from the second triplet eighth to the beat
        self.assertEqual([(d, t, x) for _, d, t, _, x in inside], [(16, 'quarter', True)])


class RunTests(unittest.TestCase):
    """Fast melodic lines are quantized as lines: in order, evenly spaced, with their own grid per stretch."""

    def test_a_fast_scale_keeps_every_note_in_order(self):
        # 32nds at 120 bpm (62.5 ms apart) with +-12 ms of timing error, over a bass
        beat, step = .5, .0625
        pitches = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84, 86]
        notes = [a2s.Note(1 + i * step + (.012 if i % 4 == 1 else -.012 if i % 4 == 2 else 0), 1 + i * step + .06, p,
                          'acoustic_piano') for i, p in enumerate(pitches)]
        notes += [a2s.Note(1 + k * beat, 1 + k * beat + .45, 48, 'acoustic_piano') for k in range(2)]
        runs = a2s.find_runs(notes)
        self.assertEqual([[notes[i].pitch for i in r] for r in runs], [pitches])
        beats = [2 + (n.start - 1) / beat for n in notes[:16]]
        placed = a2s.run_positions(beats, beat, a2s.SIMPLE)
        self.assertEqual([x for x, _ in placed], [8] * 16)
        self.assertEqual([p for _, p in placed], [2 + F(k, 8) for k in range(16)])

    def test_a_run_cut_by_a_missing_note_is_joined(self):
        # eighths at 150 bpm (0.2 s apart) without their sixth note: the 0.4 s gap is longer than RUN_MAX_IOI
        pitches = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79]
        notes = [a2s.Note(1 + .2 * i, 1 + .2 * i + .15, p, 'flutes') for i, p in enumerate(pitches) if i != 5]
        runs = a2s.find_runs(notes)
        self.assertEqual([[notes[i].pitch for i in r] for r in runs], [[p for p in pitches if p != 69]])
        with mock.patch.object(a2s, 'RUN_BRIDGE', False):
            self.assertEqual(len(a2s.find_runs(notes)), 2)

    def test_a_run_note_does_not_last_over_a_missing_one(self):
        # the same eighths in a score (the gap left alone): the note before the gap is an eighth, not a quarter
        pitches = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79]
        beats = [round(.4 * i, 3) for i in range(16)]
        doc = {'schema': a2s.SCHEMA, 'audio': 'run.wav', 'beats': beats, 'downbeats': beats[::4],
               'notes': [[1.2 + .2 * i, 1.37 + .2 * i, p, 'flutes'] for i, p in enumerate(pitches) if i != 5]}
        for across, dur in ((False, F(1, 2)), (True, F(1))):
            with mock.patch.multiple(a2s, RUN_REPAIR=False, RUN_LEGATO_ACROSS_GAPS=across):
                score = a2s.transcription_to_score(doc, chords_model=None)
            self.assertEqual({n.pitch: n.dur for n in score.notes}[67], dur)

    def test_the_grid_may_change_inside_a_run(self):
        # a sextuplet upbeat figure, then sixteenths (1 s beats; at fast tempi one grid per run is preferred)
        beats = [.5, 2 / 3, 5 / 6] + [1 + k / 4 for k in range(8)]
        placed = a2s.run_positions(beats, 1., a2s.SIMPLE)
        self.assertEqual([x for x, _ in placed], [6, 6, 6] + [4] * 8)
        self.assertEqual([p for _, p in placed], [F(1, 2), F(2, 3), F(5, 6)] + [1 + F(k, 4) for k in range(8)])

    def test_a_crowded_spot_does_not_push_the_rest_along(self):
        self.assertEqual(a2s._increasing_slots(np.array([1.79, 2.63, 3.4, 4.06, 5.11, 6.09, 6.98])),
                         [1, 2, 3, 4, 5, 6, 7])
        self.assertEqual(a2s._increasing_slots(np.array([0., .4, .45, 3.])), [-1, 0, 1, 3])

    def test_a_single_line_ends_a_note_instead_of_dropping_the_next(self):
        # legato singing: each release overlaps the next note
        notes = [note(i * .2, i * .2 + .35, 72 + i % 3, 'voice', on=F(i, 2), dur=F(3, 4)) for i in range(48)]
        parts, _ = a2s.assign_parts(notes)
        stats = Counter()
        a2s.fit_instruments(notes, parts, stats)
        self.assertFalse(any(n.removed for n in notes))
        self.assertEqual({n.dur for n in notes[:-1]}, {F(1, 2)})
        self.assertEqual(stats['shortened'], 47)

    def test_repair_fills_a_dropped_scale_note_and_a_semitone_slip(self):
        score = type('S', (), {'fifths': 0, 'mode': 'major', 'beat_quarters': F(1)})()

        def run_note(on, pitch):
            n = note(0, .1, pitch, on=on, dur=F(1, 4))
            n.run, n.grid, n.start = 0, 4, float(on) * .5
            return n
        # C D E F G A B C (sixteenths) with A missing and D slipped to D sharp
        notes = [run_note(F(k, 4), p) for k, p in enumerate([60, 63, 64, 65, 67])] + \
                [run_note(F(6, 4), 71), run_note(F(7, 4), 72), run_note(F(8, 4), 74)]
        stats = Counter()
        a2s.repair_runs(notes, score, None, stats)
        self.assertEqual(stats['run pitch'], 1)
        self.assertEqual(notes[1].pitch, 62)
        added = [n for n in notes if n.added]
        self.assertEqual([(n.on, n.pitch, n.dur) for n in added], [(F(5, 4), 69, F(1, 4))])
        self.assertEqual(notes[4].dur, F(1, 4))
        # a turn (up, then down) leaves the gap alone: the missing note is not clear
        turn = [run_note(F(k, 4), p) for k, p in ((0, 60), (1, 62), (2, 64), (4, 64), (5, 62), (6, 60))]
        stats = Counter()
        a2s.repair_runs(turn, score, None, stats)
        self.assertFalse(stats)
        # so does a note held through the gap (a longer note, nothing missing)
        held = [run_note(F(k, 4), p) for k, p in ((0, 60), (1, 62), (2, 64), (3, 65), (4, 67), (6, 71), (7, 72))]
        held[4].end = held[4].start + .3
        stats = Counter()
        a2s.repair_runs(held, score, None, stats)
        self.assertFalse(stats)

    def test_each_voice_writes_its_own_tuplets(self):
        triplets = [(F(k, 3), F(k + 1, 3), [], False, False) for k in range(3)]
        sixteenths = [(F(k, 4), F(k + 1, 4), [], False, False) for k in range(4)]
        self.assertEqual(a2s._triplet_beats(triplets, F(0), 24), {0})
        self.assertEqual(a2s._triplet_beats(sixteenths, F(0), 24), set())
        self.assertEqual(a2s._triplet_beats([(F(1), F(5, 3), [], False, False)], F(0), 24), {1})


class PipelineTests(unittest.TestCase):
    def doc(self):
        rng = np.random.default_rng(0)
        beat, notes = .6, []
        for i, p in enumerate([72, 74, 76, 77, 79, 77, 76, 74]):
            t = i * beat + rng.normal(0, .01)
            notes.append([t, t + .55, p, 'acoustic_piano'])
        t0 = 8 * beat
        for j in range(6):
            t = t0 + j * beat / 3 + rng.normal(0, .008)
            notes.append([t, t + .18, 72 + 2 * (j % 3), 'acoustic_piano'])
        notes.append([t0 + 2 * beat, t0 + 4 * beat, 84, 'acoustic_piano'])
        for b in range(4):
            notes.append([b * 4 * beat + .005, b * 4 * beat + 4 * beat - .1, [48, 43, 45, 48][b], 'acoustic_piano'])
        notes.append([1.0, 1.03, 90, 'acoustic_piano'])
        beats = [round(i * beat, 3) for i in range(18)]
        return {'schema': a2s.SCHEMA, 'audio': 'test.wav', 'notes': sorted(notes), 'beats': beats,
                'downbeats': beats[::4]}

    def test_score_and_musicxml(self):
        score = a2s.transcription_to_score(self.doc())
        self.assertEqual((score.time_signature, score.pickup, score.bars), ((4, 4), F(0), 4))
        self.assertEqual(score.report['removed'], {'blip': 1})
        kept = sorted((n.on, n.pitch) for n in score.notes if not n.removed and n.staff == 0)
        self.assertEqual(kept[:3], [(F(0), 72), (F(1), 74), (F(2), 76)])
        self.assertIn((F(25, 3), 74), kept)                           # triplets in bar 3
        root = ET.fromstring(a2s.musicxml(score).split('\n', 2)[2])
        part = root.find('part')
        self.assertEqual(part.find('measure/attributes/time/beats').text, '4')
        for measure in part.findall('measure'):
            per_voice = defaultdict(int)
            for n in measure.findall('note'):
                if n.find('chord') is None:
                    per_voice[n.findtext('voice')] += int(n.findtext('duration'))
            self.assertTrue(all(v == 96 for v in per_voice.values()), (measure.get('number'), dict(per_voice)))
        self.assertEqual(len(part.findall('.//time-modification')), 6)
        self.assertEqual(len(part.findall(".//tuplet[@type='start']")), 2)
        forced = a2s.transcription_to_score(self.doc(), metre_override='2/4')
        self.assertEqual((forced.time_signature, forced.bars), ((2, 4), 8))

    def test_the_filler_hook(self):
        seen = {}

        def filler(notes, score, chords, seconds):
            seen['seconds'] = float(seconds(F(4)))                  # score quarters -> seconds of the recording
            notes.append(a2s.Note(2.4, 3., 60, 'acoustic_piano', on=F(4), dur=F(1), part=0, added='filler'))
            return Counter({'filler': 1})
        score = a2s.transcription_to_score(self.doc(), filler=filler)
        self.assertAlmostEqual(seen['seconds'], 2.4, places=2)
        self.assertEqual(score.report['added'], {'run gap': 0, 'filler': 1})
        self.assertTrue(score.report['noteFiller'])
        self.assertIn((F(4), 60), {(n.on, n.pitch) for n in score.notes if not n.removed})
        self.assertIn('<step>C</step><octave>4</octave>', a2s.musicxml(score).replace('\n', '').replace(' ', ''))
        raw = a2s.transcription_to_score(self.doc(), filler=filler, keep_all=True)      # no cleanup, no filling
        self.assertEqual((raw.report['added']['filler'], raw.report['noteFiller']), (0, False))

    @unittest.skipUnless(ANALYSIS.exists() and HAS_TORCH, 'torch or the trained analysis weights are missing')
    def test_harmony_model(self):
        model = a2s.load_chords_model(None)
        score = a2s.transcription_to_score(self.doc(), chords_model=model)
        self.assertTrue(score.report['harmonyCheck'])
        chords = a2s.analysed_chords(score, model, score.notes)
        self.assertIn(0, chords[0])                                   # C is a chord tone at the start


if __name__ == '__main__':
    unittest.main()
