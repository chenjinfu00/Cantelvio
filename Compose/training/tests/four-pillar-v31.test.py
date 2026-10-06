"""Four-pillar v3.1: time rules, key-relative pitch, keys/chords, causal windows, cache and train/generate parity,
fused kernel, sampler contracts."""
import pathlib
import random
import sys
import unittest
from collections import Counter
from fractions import Fraction

import numpy as np
import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from score_events_v2 import ScoreEvents
from four_pillar_codec import GROUPS
from four_pillar_v31_time import TimeVocabulary, cluster_onsets, snap, snap_duration
from four_pillar_v31_tonal import (QUALITY_INDEX, REL_PITCHES, absolute_pitch, apply_key_change, key_change_class,
                                   relative_index, tonic_ref, track_chords, track_keys, transpose_analysis,
                                   valid_relative_range)
from four_pillar_v31_model import (CONFIG, KIND_CHORD, KIND_END, KIND_NOTE, PITCH_UNPITCHED, FourPillarV31,
                                   apply_rope, rope_tables)
from four_pillar_v31_data import (bar_notes, build_example, choose_references, collate, density_bucket,
                                  key_summary)
from four_pillar_v31_tonal import NoteTable
from four_pillar_v31_sample import Composer, Kernel, bar_summary, gumbel_choice

SMALL = {**CONFIG, 'width': 48, 'heads': 4, 'layers': 2, 'planner_layers': 1, 'history_bars': 16, 'attr_hidden': 64}
MAJ, MIN, DOM7 = QUALITY_INDEX['maj'], QUALITY_INDEX['min'], QUALITY_INDEX['dom7']


def randomized(config=SMALL, seed=0):
    """A model whose zero-initialized parts (residual outputs, LayerNorm affines, pitch priors) are nonzero,
    so equivalence tests exercise every parameter."""
    torch.manual_seed(seed)
    model = FourPillarV31(config).eval()
    with torch.no_grad():
        for parameter in model.parameters():
            parameter.add_(torch.randn_like(parameter) * .05)
    return model


def synthetic_score(bars=6, melody_shift=0, transpose=0, regroup_bar=None):
    """I-IV-V-I style material in C major with a tuplet bass line, percussion and an unknown-group voice
    (regroup_bar: the cello part is labelled high strings from that bar on)."""
    notes = []
    harmony = [(48, 52, 55), (53, 57, 60), (55, 59, 62), (48, 52, 55), (53, 57, 60), (55, 59, 62)]
    for bar in range(bars):
        on = bar * 4
        for k, p in enumerate([72, 74, 76, 77]):
            notes.append({'on': str(on + k), 'dur': '1', 'bar': bar,
                          'pitch': p + transpose + (melody_shift if bar == bars - 1 and k == 3 else 0),
                          'part': 'fl', 'staff': '1', 'voice': '1', 'group': 'woodwinds', 'dynamic': 'mf'})
        for p in harmony[bar % len(harmony)]:
            notes.append({'on': str(on), 'dur': '2', 'bar': bar, 'pitch': p + transpose, 'part': 'pf', 'staff': '2',
                          'voice': '1', 'group': 'keys', 'dynamic': 'p', 'wedge': 'crescendo' if bar == 2 else None})
            notes.append({'on': str(on + 2), 'dur': '2', 'bar': bar, 'pitch': p + transpose, 'part': 'pf',
                          'staff': '2', 'voice': '1', 'group': 'keys', 'dynamic': 'p'})
        for k in range(3):
            notes.append({'on': str(on + Fraction(k, 3)), 'dur': '1/3', 'bar': bar, 'pitch': 36 + transpose + 4 * k,
                          'part': 'vc', 'staff': '1', 'voice': '1', 'tuplet': '3:2', 'accent': 1,
                          'group': 'high_strings' if regroup_bar is not None and bar >= regroup_bar else 'low_strings'})
        notes.append({'on': str(on + 1), 'dur': '1/2', 'bar': bar, 'pitch': None, 'unpitched': True, 'part': 'dr',
                      'staff': '1', 'voice': '1', 'group': 'percussion'})
        notes.append({'on': str(on + 3), 'dur': '1', 'bar': bar, 'pitch': 67 + transpose, 'part': 'sop', 'staff': '1',
                      'voice': '1', 'group': None})
    return ScoreEvents.from_candidate({
        'scoreId': 'synthetic', 'parts': [{'id': 'fl', 'group': 'woodwinds'}, {'id': 'pf', 'group': 'keys'},
                                          {'id': 'vc', 'group': 'low_strings'}, {'id': 'dr', 'group': 'percussion'},
                                          {'id': 'sop', 'group': None}],
        'measures': [{'on': str(b * 4), 'dur': '4', 'meter': [4, 4]} for b in range(bars)], 'notes': notes})


# Keys: C major, then G major from bar 4; chords at beats 1 and 3 (absolute roots).
ANALYSIS = {'keys': [0, 0, 0, 0, 7, 7],
            'chords': {b: [(Fraction(0), (0, 5, 7, 0, 5, 7)[b], MAJ), (Fraction(2), 7, DOM7)] for b in range(6)}}


class TimeTests(unittest.TestCase):
    def test_snapping_rules(self):
        self.assertEqual(snap(Fraction(239, 480)), Fraction(1, 2))
        self.assertEqual(snap(Fraction(1, 5)), Fraction(1, 5))          # exact tuplets stay
        self.assertEqual(snap(Fraction(1, 120)), 0)
        self.assertEqual(snap_duration(Fraction(127, 32), performance=True), 4)
        self.assertEqual(snap_duration(Fraction(127, 32)), Fraction(127, 32))   # notated values stay
        self.assertEqual(snap_duration(Fraction(1, 120), performance=True), Fraction(1, 48))
        mapping = cluster_onsets([Fraction(0), Fraction(1, 120), Fraction(1, 40), Fraction(1, 2)])
        self.assertEqual(sorted(set(mapping.values())), [0, Fraction(1, 2)])

    def test_frozen_vocabulary(self):
        vocab = TimeVocabulary.load()
        self.assertEqual(len(vocab), CONFIG['time_classes'])
        for value in ('1/4', '1/3', '1/5', '1/6', '3/8', '1', '4'):
            index, remapped = vocab.lookup(Fraction(value), positive=True)
            self.assertFalse(remapped)
            self.assertEqual(vocab.value(index), Fraction(value))
        self.assertEqual(vocab.lookup(Fraction(0))[0], 0)


class TonalTests(unittest.TestCase):
    def test_relative_pitch_is_exact_and_covers_midi(self):
        for tonic in range(12):
            self.assertTrue(54 <= tonic_ref(tonic) <= 65 and tonic_ref(tonic) % 12 == tonic)
            valid = valid_relative_range(tonic)
            self.assertEqual(len(valid), 128)
            self.assertTrue(0 <= valid.start and valid.stop <= REL_PITCHES)
            for pitch in range(128):
                index = relative_index(pitch, tonic)
                self.assertIn(index, valid)
                self.assertEqual(absolute_pitch(index, tonic), pitch)
        # The same melody in C and in D has the same codes.
        self.assertEqual([relative_index(p, 0) for p in (60, 64, 67)], [relative_index(p, 2) for p in (62, 66, 69)])

    def test_key_change_classes(self):
        for previous in range(24):
            for key in range(24):
                self.assertEqual(apply_key_change(previous, key_change_class(previous, key)), key)

    def test_key_tracker_finds_and_transposes_keys(self):
        keys = track_keys(synthetic_score())
        self.assertTrue(all(k == 0 for k in keys), keys)                      # C major
        moved = track_keys(synthetic_score(transpose=3))
        self.assertTrue(all(k == 3 for k in moved), moved)                    # Eb major
        self.assertEqual(transpose_analysis({'keys': keys, 'chords': {}}, 3)['keys'], moved)

    def test_chord_tracker(self):
        score = synthetic_score()
        chords = track_chords(score, track_keys(score), 0, 5)
        self.assertEqual(chords[0][0][1:], (0, MAJ))                          # C major triad on beat 1
        self.assertEqual(chords[1][0][1:], (5, MAJ))                          # F major
        self.assertEqual(chords[2][0][1:], (7, MAJ))                          # G major
        moved = track_chords(synthetic_score(transpose=2), track_keys(synthetic_score(transpose=2)), 0, 5)
        self.assertEqual([(o, (r + 2) % 12, q) for o, r, q in chords[1]], moved[1])


class DataTests(unittest.TestCase):
    def setUp(self):
        self.vocab = TimeVocabulary.load()

    def example(self, score=None, **kw):
        options = dict(source='Lieder', rng=random.Random(3), analysis=ANALYSIS, context=512, drop_controls=False)
        options.update(kw)
        return build_example(score or synthetic_score(), 5, self.vocab, **options)

    def test_inputs_are_the_previous_events(self):
        e = self.example()
        notes = [i for i in range(len(e['tg_kind']) - 1) if e['tg_kind'][i] == KIND_NOTE]
        self.assertGreater(len(notes), 50)
        for i in notes:
            self.assertEqual(e['in_pitch'][i + 1], e['tg_pitch'][i])
            self.assertEqual(e['in_voice'][i + 1], e['tg_voice'][i])
            self.assertEqual(e['in_position'][i + 1], e['tg_onset'][i])
            self.assertEqual(e['in_duration'][i + 1], e['tg_duration'][i])
        chords = [i for i in range(len(e['tg_kind']) - 1) if e['tg_kind'][i] == KIND_CHORD]
        self.assertGreater(len(chords), 6)
        for i in chords:
            self.assertEqual(e['in_kind'][i + 1], KIND_CHORD)
            self.assertEqual(e['in_chord_root'][i + 1], e['tg_chord_root'][i])
            self.assertEqual(e['in_chord_quality'][i + 1], e['tg_chord_quality'][i])
        ends = [i for i in range(len(e['tg_kind']) - 1) if e['tg_kind'][i] == KIND_END]
        self.assertTrue(all(e['in_kind'][i + 1] == KIND_END for i in ends))
        self.assertEqual(e['in_kind'][0], 3)   # START at the beginning of the stream

    def test_pitch_targets_decode_to_the_sounding_pitch(self):
        score = synthetic_score()
        for shift in (0, 2, -5):
            e = self.example(shift=shift)
            pitched = (e['tg_kind'] == KIND_NOTE) & (e['tg_pitch'] < PITCH_UNPITCHED)
            sounding = e['tg_pitch'][pitched] - 65 + e['tonic_ref'][pitched]
            source = sorted(n.pitch + shift for n in score.events if n.pitch is not None)
            self.assertEqual(sorted(sounding.tolist()), source)

    def test_key_relative_codes_are_transposition_invariant(self):
        a, b = self.example(), self.example(shift=2)
        for name in ('tg_pitch', 'in_pitch', 'in_degree', 'tg_chord_root', 'harm_pcs', 'bass_rel', 'chord_tones',
                     'vs_last_rel', 'bt_bar_pcs', 'ctrl_modulation', 'bt_bar_key'):
            self.assertTrue((a[name] == b[name]).all(), name)
        self.assertTrue((b['ctrl_key'] == (a['ctrl_key'] % 12 + 2) % 12 + a['ctrl_key'] // 12 * 12).all())
        self.assertTrue(np.abs(a['history'][:, :19] - b['history'][:, :19]).max() < 1e-6)
        self.assertTrue((b['in_register'] != a['in_register']).any())          # absolute register still known

    def test_onset_ranges_and_voice_inputs(self):
        e = self.example()
        rows = e['kn_onset']
        self.assertTrue(((e['tg_onset'][rows] >= e['at_onset_lo'][rows]) & (e['tg_onset'][rows] < e['at_onset_hi'][rows])).all())
        notes = np.flatnonzero(e['tg_kind'] == KIND_NOTE)
        # each note's 'previous interval' is the interval its voice used last time
        last = {}
        for i in notes:
            voice = e['tg_voice'][i]
            self.assertEqual(e['vs_prev_interval'][i], last.get(voice, 49))
            last[voice] = e['tg_interval'][i]
        pitched = notes[e['tg_pitch'][notes] < PITCH_UNPITCHED]
        follow = pitched[pitched + 1 < len(e['in_kind'])]
        self.assertTrue((e['in_chord_degree'][follow + 1] < 12).all())             # notes carry their chord degree

    def test_chords_precede_notes_and_follow_the_bar_key(self):
        e = self.example()
        bars = e['bar_of_event']
        values = self.vocab.values
        for i in range(1, len(e['tg_kind'])):
            if e['tg_kind'][i] == KIND_CHORD and e['in_kind'][i] not in (KIND_END, 3):
                self.assertGreater(values[e['tg_onset'][i]], values[e['in_position'][i]])   # strictly after
            if e['kn_onset'][i] and e['in_kind'][i] not in (KIND_END, 3):
                self.assertGreaterEqual(values[e['tg_onset'][i]], values[e['in_position'][i]])  # never backwards
        # Bar 4 is in G major: its first chord (F major) is the flat seventh degree, 10 semitones above G.
        first_g = next(i for i in range(len(bars)) if e['tg_kind'][i] == KIND_CHORD and e['ctrl_key'][bars[i]] == 7)
        self.assertEqual(e['tg_chord_root'][first_g], 10)
        self.assertTrue((e['bt_bar_key'][e['kn_bar_key']] >= 0).all())

    def test_future_notes_never_change_earlier_conditions(self):
        a, b = self.example(synthetic_score()), self.example(synthetic_score(melody_shift=-3))
        changed = next(i for i in range(len(a['tg_pitch'])) if a['tg_pitch'][i] != b['tg_pitch'][i])
        for name in ('in_pitch', 'in_voice', 'in_position', 'slot_feat', 'harm_feat', 'vs_last_rel', 'chord_root',
                     'at_beat', 'rope_time'):
            self.assertTrue((a[name][:changed + 1] == b[name][:changed + 1]).all(), name)
        self.assertNotEqual(a['in_pitch'][changed + 1], b['in_pitch'][changed + 1])
        self.assertTrue((a['history'] == b['history']).all())   # the last bar is not in its own history

    def test_reference_bars(self):
        score = synthetic_score()
        refs = choose_references(NoteTable(score), ANALYSIS['keys'], 0, range(6))
        # bar 3 restates bar 0; bar 2 shares 11 of 15 items with bar 0 (Jaccard 11/19); bars 1, 4, 5: 9/21 at most
        self.assertEqual(refs, {0: None, 1: None, 2: 0, 3: 0, 4: None, 5: None})
        moved = synthetic_score(transpose=2)                                               # key-relative choice
        self.assertEqual(choose_references(NoteTable(moved), [k + 2 for k in ANALYSIS['keys']], 0, range(6)), refs)
        self.assertIsNone(choose_references(NoteTable(score), [0, 0, 0, 7, 7, 7], 0, range(6))[3])
        e = self.example()
        self.assertEqual(e['reference_targets'], refs)
        self.assertEqual(e['references'], refs)                                           # no dropout here
        self.assertEqual(e['bt_bar_ref'].tolist(), [0, 0, 1, 1, 0, 0])
        self.assertEqual(e['kn_bar_ref'].tolist(), [False, True, True, True, True, True])
        in_bar3 = e['bar_of_event'] == 3
        notes = np.flatnonzero(in_bar3 & (e['tg_kind'] == KIND_NOTE))
        self.assertGreater(len(notes), 10)
        # an exact restatement: each note's aligned reference note is the note itself ...
        self.assertTrue((e['rf_pitch'][notes] == e['tg_pitch'][notes]).all())
        self.assertTrue((e['rf_duration'][notes] == e['tg_duration'][notes]).all())
        self.assertTrue((e['rf_group'][notes] == e['tg_group_in'][notes]).all())
        # ... and the reference's next onset (or staying, while it has notes left here) is the actual onset
        expected = np.where(e['rf_remain'][notes] > 0, e['rf_here'][notes], e['rf_next'][notes])
        self.assertTrue((expected == e['tg_onset'][notes]).all())
        free = np.isin(e['bar_of_event'], [0, 1, 4, 5])
        self.assertTrue((e['rf_remain'][free] == 5).all() and (e['rf_pitch'][free] == 140).all())
        end = np.flatnonzero(in_bar3 & (e['tg_kind'] == KIND_END))[0]
        self.assertEqual((e['rf_next'][end], e['rf_remain'][end]), (len(self.vocab), 0))   # nothing left: end
        dropped = build_example(score, 5, self.vocab, source='Lieder', rng=random.Random(0), analysis=ANALYSIS,
                                context=512, drop_controls=True)
        self.assertEqual(dropped['reference_targets'], refs)                     # the pointer target is kept

    def test_a_part_changing_group_becomes_a_new_voice(self):
        e = self.example(synthetic_score(regroup_bar=3))
        notes = np.flatnonzero(e['tg_kind'] == KIND_NOTE)
        features = e['slot_feat'][notes, e['tg_voice'][notes]]
        allowed = ((features[:, 0] > .5) & (features[:, 2] > .5)) | (features[:, 1] > .5)
        self.assertTrue(allowed.all())                                           # every target voice is allowed
        self.assertEqual(e['stats'].get('voice-regrouped'), 1)
        self.assertEqual(len({v for v in e['tg_voice'][notes]}), 5 + 1)        # the cello part opened a new voice

    def test_real_analysis_and_masks(self):
        e = build_example(synthetic_score(), 5, self.vocab, source='classical-scores', rng=random.Random(1),
                          context=512, drop_controls=False)
        self.assertTrue((e['ctrl_key'] == 0).all())
        self.assertGreater(int(e['kn_chord_root'].sum()), 4)
        unknown = [i for i in range(len(e['tg_kind'])) if e['tg_kind'][i] == KIND_NOTE and not e['kn_group'][i]]
        self.assertTrue(unknown and all(e['tg_group_in'][i] == 6 for i in unknown))   # vocal line: group unknown
        self.assertTrue(e['kn_wedge'][e['tg_kind'] == KIND_NOTE].all())                  # absence is meaningful in scores
        midi = build_example(synthetic_score(), 5, self.vocab, source='curated-midi', rng=random.Random(1),
                             velocities={i: 70 for i in range(500)}, drums={i: 42 for i in range(500)})
        self.assertFalse(midi['kn_wedge'].any())
        self.assertTrue(midi['kn_drum'].sum() >= 6)

    def test_collate_and_loss(self):
        model = FourPillarV31(SMALL)
        examples = [self.example(), self.example(source='curated-midi', context=40)]
        batch = collate(examples, len(self.vocab))
        loss, report = model.loss(batch)
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertTrue(all(torch.isfinite(p.grad).all() for p in model.parameters() if p.grad is not None))
        self.assertEqual(report['kind']['known'], sum(len(e['tg_kind']) for e in examples))
        self.assertGreater(report['chord_root']['known'], 0)


class MidiLoaderTests(unittest.TestCase):
    def test_single_parse_loader_equals_the_v2_loader(self):
        import json
        from four_pillar_midi_data import ROOT, _load_midi_score, source_path
        from train_four_pillar_v31 import load_midi
        membership = ROOT / 'data/four-pillar-midi-all-train-v1.json'
        if not membership.exists():
            self.skipTest('MIDI membership not present')
        rows = [r for r in json.loads(membership.read_text())['rows'] if source_path(r).exists()][:6]
        if not rows:
            self.skipTest('no approved MIDI files present')
        for row in rows:
            score, velocities, drums, tempos, meter_known = load_midi(row)
            self.assertEqual((score, velocities, meter_known, tempos), _load_midi_score(row))
            by_source = {event.source_index: event for event in score.events}
            self.assertTrue(all(by_source[i].pitch is None for i in drums))     # drum keys belong to unpitched notes


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.model = randomized(seed=7)

    def coordinates(self, n, offset=0):
        time = torch.cumsum(torch.rand(n, dtype=torch.float64), 0) + offset
        return torch.arange(n) + offset, time, torch.rand(n, dtype=torch.float64), torch.rand(n, dtype=torch.float64)

    def test_streaming_backbone_matches_full_pass(self):
        x = torch.randn(1, 30, SMALL['width'])
        index, time, beat, bar = self.coordinates(30)
        dim = SMALL['width'] // SMALL['heads']
        with torch.no_grad():
            full = self.model.backbone(x, rope_tables(dim, index[None], time[None], beat[None], bar[None], 'cpu', x.dtype))
            cache = self.model.new_cache()
            rows = [self.model.backbone_step(x[:, i:i + 1], self.model.event_rope(int(index[i]), float(time[i]),
                                             float(beat[i]), float(bar[i])), cache) for i in range(30)]
        torch.testing.assert_close(torch.cat(rows, 1), full, atol=3e-5, rtol=3e-5)

    def test_ring_buffer_eviction_matches_sliding_window(self):
        model = randomized({**SMALL, 'window': 8}, seed=2)
        x = torch.randn(1, 20, SMALL['width'])
        index, time, beat, bar = self.coordinates(20, offset=1000)
        dim = SMALL['width'] // SMALL['heads']
        with torch.no_grad():
            cache = model.new_cache()
            rows = torch.cat([model.backbone_step(x[:, i:i + 1], model.event_rope(int(index[i]), float(time[i]),
                                                  float(beat[i]), float(bar[i])), cache) for i in range(20)], 1)
            rope = rope_tables(dim, index, time, beat, bar, 'cpu', x.dtype)
            h = x
            for block in model.blocks:
                a = block.attention
                y = block.norm(h)
                q, k, v = a.qkv(y).reshape(1, 20, 3, a.heads, a.dim).permute(2, 0, 3, 1, 4).unbind(0)
                q, k = apply_rope(q, rope), apply_rope(k, rope)
                distance = index[:, None] - index[None, :]
                mask = (distance >= 0) & (distance < 8)
                out = torch.nn.functional.scaled_dot_product_attention(q, k, v, attn_mask=mask)
                h = h + a.out(out.transpose(1, 2).reshape(1, 20, -1))
                h = h + block.ff(block.ffnorm(h))
            reference = model.norm(h)
        torch.testing.assert_close(rows, reference, atol=3e-5, rtol=3e-5)

    def test_attention_depends_on_time_differences_only(self):
        x = torch.randn(1, 12, SMALL['width'])
        index, time, beat, bar = self.coordinates(12)
        dim = SMALL['width'] // SMALL['heads']
        with torch.no_grad():
            a = self.model.backbone(x, rope_tables(dim, index[None], time[None], beat[None], bar[None], 'cpu', x.dtype))
            b = self.model.backbone(x, rope_tables(dim, index[None] + 77, time[None] + 1234.5, beat[None], bar[None],
                                                   'cpu', x.dtype))
        torch.testing.assert_close(a, b, atol=3e-5, rtol=3e-5)

    def test_plans_and_controls_never_touch_the_cache(self):
        cache = self.model.new_cache()
        with torch.no_grad():
            hidden = self.model.backbone_step(torch.randn(1, 1, SMALL['width']), self.model.event_rope(0, 0., 0., 0.),
                                              cache)
            before = [layer['k'].clone() for layer in cache]
            plan = self.model.plan_bars(torch.rand(1, 5, SMALL['summary_dim']))[:, -1:]  # 78 = 34 + 40 profile + 4 phrase phases
            controls = {'ctrl_meter_num': torch.tensor([[4]]), 'ctrl_meter_den': torch.tensor([[3]]),
                        'ctrl_groups': torch.ones(1, 1, 7), 'ctrl_density': torch.tensor([[3]]),
                        'ctrl_cont': torch.zeros(1, 1, 4), 'ctrl_key': torch.tensor([[9]]),
                        'ctrl_modulation': torch.tensor([[5]]), 'ctrl_source': torch.tensor([[3]])}
            self.model.kind_logits(hidden + self.model.bar_condition(plan, controls))
        self.assertTrue(all(torch.equal(b, layer['k']) for b, layer in zip(before, cache)))

    def test_planner_is_causal(self):
        history = torch.rand(1, 6, SMALL['summary_dim'])
        with torch.no_grad():
            a = self.model.plan_bars(history)
            history[0, 4:] = torch.rand(2, SMALL['summary_dim'])
            b = self.model.plan_bars(history)
        torch.testing.assert_close(a[:, :4], b[:, :4])

    def test_streaming_planner_matches_full_pass_and_slides(self):
        history = torch.rand(1, 40, SMALL['summary_dim'])
        window = SMALL['history_bars'] - 1
        with torch.no_grad():
            cache = self.model.new_planner_cache()
            rows = torch.cat([self.model.planner_step(history[:, j:j + 1], 500 + j, cache) for j in range(40)], 1)
            full = self.model.plan_bars(history[:, :window])
            # One planner layer: after eviction each plan equals a fresh pass over the last `window` bars.
            sliding = torch.cat([self.model.plan_bars(history[:, j - window + 1:j + 1])[:, -1:]
                                 for j in range(window, 40)], 1)
        torch.testing.assert_close(rows[:, :window], full, atol=3e-5, rtol=3e-5)
        torch.testing.assert_close(rows[:, window:], sliding, atol=3e-5, rtol=3e-5)

    def test_composer_plan_is_the_planner_over_its_bars(self):
        composer = Composer(self.model, TimeVocabulary.load(), seed=4)
        for _ in range(3):
            composer.next_bar(groups=('keys', 'woodwinds'), max_notes=12)
        with torch.no_grad():
            reference = self.model.plan_bars(torch.tensor([composer.summaries], dtype=torch.float32))[:, -1:]
        torch.testing.assert_close(composer.plan, reference, atol=3e-5, rtol=3e-5)


class ParityTests(unittest.TestCase):
    """The training forward and the generation path give the same logits on the same events."""

    def test_training_and_generation_agree(self):
        model = randomized(seed=11)
        vocab = TimeVocabulary.load()
        score = synthetic_score()
        e = build_example(score, 5, vocab, source='Lieder', rng=random.Random(0), analysis=ANALYSIS, context=512,
                          drop_controls=False, lead_bars=99, lead_events=10 ** 6)
        with torch.no_grad():
            out = model(collate([e], len(vocab)))
        composer = Composer(model, vocab)
        record = []
        for b in range(6):
            stats = Counter()
            notes = bar_notes(score, b, [n for n in score.events if n.bar == b], vocab, 0, False, {}, {}, stats)
            merged = sorted([(o, 0, i, ('chord', r, q)) for i, (o, r, q) in enumerate(ANALYSIS['chords'][b])]
                            + [(n.position, 1, i, ('note', n)) for i, n in enumerate(notes)], key=lambda x: x[:3])
            events, current = [], composer.state.chord
            for position, _, _, item in merged:
                onset = vocab.lookup(position)[0]
                if item[0] == 'chord':
                    if current == (item[1], item[2]):
                        continue
                    current = (item[1], item[2])
                    events.append({'kind': 'chord', 'onset': onset, 'root': item[1], 'quality': item[2]})
                else:
                    n = item[1]
                    events.append({'kind': 'note', 'onset': onset, 'group': n.group, 'identity': n.identity,
                                   'pitch': n.pitch, 'duration': n.duration_index, 'velocity': n.velocity,
                                   'dynamic': n.dynamic, 'accent': n.accent, 'wedge': n.wedge, 'drum': n.drum})
            groups = sorted({n.group for n in notes})
            allowed = [GROUPS[g] for g in range(6)] if 6 in groups else [GROUPS[g] for g in groups]
            tonic = ANALYSIS['keys'][b]
            composer.feed_bar(events, groups=allowed, request_groups=6 not in groups, density=density_bucket(len(notes)),
                              key=(tonic % 12, tonic // 12), tempo=None, style='Lieder', record=record,
                              reference=e['references'][b])
        self.assertEqual(e['references'][3], 0)
        steps, event, pointers = {}, -1, []
        for index, name, logits in record:
            if name == 'bar_ref':
                pointers.append(logits)      # logged once per bar before its first event
                continue
            if name == 'kind':
                event += 1
            steps.setdefault(event, {})[name] = logits
        self.assertEqual(len(steps), len(e['tg_kind']))
        checked = 0
        for i, step in steps.items():
            for name, logits in step.items():
                expected = out[name][0, i].float()
                finite = expected > -1e30
                if name in ('voice', 'pitch'):
                    self.assertTrue(torch.equal(torch.isfinite(logits), finite), name)
                torch.testing.assert_close(logits[finite], expected[finite], atol=2e-4, rtol=2e-4)
                checked += 1
        self.assertGreater(checked, 500)
        self.assertGreater(sum('chord_root' in s for s in steps.values()), 6)
        self.assertEqual(len(pointers), 5)                    # bars 1..5 have earlier bars to point at
        for bar, logits in zip(range(1, 6), pointers):
            expected = out['bar_ref'][0, bar]
            finite = expected > -1e30
            self.assertEqual(int(finite.sum()), bar + 1)      # none + every earlier bar
            torch.testing.assert_close(logits, expected[finite], atol=2e-4, rtol=2e-4)


class KernelTests(unittest.TestCase):
    """The fused generation kernel computes the same values as the training modules."""

    def setUp(self):
        self.model = randomized(seed=3)
        self.kernel = Kernel(self.model)

    def close(self, a, b):
        torch.testing.assert_close(torch.as_tensor(a).reshape(-1).float(), torch.as_tensor(b).reshape(-1).float(),
                                   atol=2e-5, rtol=2e-5)

    def test_backbone_and_inputs(self):
        m, k = self.model, self.kernel
        encoded = {'in_kind': 0, 'in_group': 2, 'in_pitch': 61, 'in_degree': 15, 'in_register': 5, 'in_drum': 128,
                   'in_voice': 3, 'in_interval': 26, 'in_delta': 17, 'in_position': 23, 'in_duration': 40,
                   'in_velocity': 9,
                   'in_dynamic': 4, 'in_accent': 1, 'in_wedge': 2, 'in_beat': 3, 'in_level': 2, 'in_key': 19,
                   'in_chord_root': 7, 'in_chord_quality': 10, 'in_chord_degree': 4,
                   'in_cont': [float(i) / 16 for i in range(16)],
                   'rope_time': 12.5, 'rope_beat': .25, 'rope_bar': .625}
        with torch.no_grad():
            reference = m.embed_events({key: torch.tensor([[value]]) for key, value in encoded.items()})
            self.close(k.embed(encoded), reference)
            ca, cb = m.new_cache(), m.new_cache()
            for position in range(12):
                x = torch.randn(SMALL['width'])
                coords = dict(encoded, rope_time=1000. + position * .75, rope_beat=(position % 4) / 4.)
                rope = m.event_rope(position + 700, coords['rope_time'], coords['rope_beat'], coords['rope_bar'])
                self.close(k.backbone_step(x, k.rope(position + 700, coords), ca), m.backbone_step(x.view(1, 1, -1), rope, cb))
            self.assertTrue(all(torch.allclose(a['k'], b['k'], atol=2e-5) for a, b in zip(ca, cb)))

    def test_attribute_decoder(self):
        m, k = self.model, self.kernel
        w = SMALL['width']
        z = torch.randn(w)
        z3 = z.view(1, 1, w)
        onset = {'beat': 2, 'level': 1, 'cont': [.1 * i for i in range(8)], 'harm': [float(i % 3 == 0) for i in range(25)],
                 'chord_root': 7, 'chord_quality': 3, 'pcs': [float(i in (0, 4, 7)) for i in range(12)], 'bass': 4,
                 'chord_tones': [float(i in (7, 11, 2)) for i in range(12)], 'mode': 1}
        t = lambda v, dtype=torch.long: torch.tensor([[v]], dtype=dtype)  # noqa: E731
        with torch.no_grad():
            for name in ('kind', 'chord_root', 'chord_quality'):
                self.close(getattr(k, name)(z), getattr(m, name + '_logits')(z3))
            for ref in (2, 5, 6, 7):                                   # copy bias only toward the six groups
                self.close(k.group(z, ref), m.group_logits(z3, t(ref)))
            for ref in (17, 383, 384):
                self.close(k.duration(z, ref), m.duration_logits(z3, t(ref)))
            for look in ((30, 12, 2), (384, 384, 5), (40, 384, 0)):
                self.close(k.onset_position(z, look), m.onset_logits(z3, None, None, t(look[0]), t(look[1])))
                self.close(k.lookahead(look), m.lookahead(t(look[0]), t(look[2])))
            self.close(k.after_kind(z, 1), m.after_kind(z3, t(1)))
            for aligned in ((3, 70, 21, [float(i in (0, 4)) for i in range(12)]), (7, 140, 384, [0.] * 12)):
                self.close(k.after_onset(z, 11, onset, aligned),
                           m.after_onset(z3, t(11), t(2), t(1), t(onset['cont'], torch.float32), t(aligned[0]),
                                         t(aligned[1]), t(aligned[2]), t(aligned[3], torch.float32)))
            self.close(k.after_chord_root(z, 9), m.after_chord_root(z3, t(9)))
            self.close(k.after_group(z, 4), m.after_group(z3, t(4)))
            slots = np.zeros((SMALL['voices'], 6), dtype=np.float32)
            slots[:5, 0], slots[5, 1], slots[[0, 2, 3], 2] = 1, 1, 1
            slots[:5, 3:] = np.random.default_rng(0).random((5, 3))
            mine, reference = k.voice(z, slots), m.voice_logits(z3, torch.from_numpy(slots)[None, None]).reshape(-1)
            allowed = np.isfinite(mine)
            self.assertEqual(allowed.tolist(), (reference > -1e30).tolist())
            self.close(mine[allowed], reference[torch.from_numpy(allowed)])
            vf = [0., 1., .3, .2]
            self.close(k.after_voice(z, 2, 64, 27, vf, onset),
                       m.after_voice(z3, t(2), t(64), t(27), t(vf, torch.float32), t(onset['harm'], torch.float32), t(7),
                                     t(3)))
            for tonic, group in ((0, 0), (5, 3), (6, 6), (11, 5)):
                for last in (60, 128, 129, 5, 120):
                    for root, ref in ((7, 66), (12, 140), (7, 139)):
                        o = dict(onset, chord_root=root)
                        mine = k.pitch(z, group, tonic, last, o, ref)
                        reference = m.pitch_logits(z3, t(tonic_ref(tonic)), t(last), t(o['pcs'], torch.float32), t(4),
                                                   t(o['chord_tones'], torch.float32), t(root), t(1),
                                                   t(group), t(ref)).reshape(-1)
                        finite = reference > -1e30
                        self.assertTrue(torch.equal(torch.isfinite(mine), finite))
                        self.close(mine[finite], reference[finite])
            self.close(k.after_pitch(z, 66, 30), m.after_pitch(z3, t(66), t(30)))
            self.close(k.after_duration(z, 21), m.after_duration(z3, t(21)))
            fused, reference = k.expression_logits(z), m.expression_logits(z3)
            for name, value in reference.items():
                self.close(fused[name], value)

    def test_gumbel_choice_samples_the_softmax(self):
        rng = np.random.default_rng(1)
        logits = np.array([0., 1., 2., -1.])
        counts = np.bincount([gumbel_choice(logits, rng) for _ in range(40000)], minlength=4) / 40000
        expected = np.exp(logits) / np.exp(logits).sum()
        self.assertLess(np.abs(counts - expected).max(), .01)
        self.assertTrue(all(1 <= gumbel_choice(logits, rng, range(1, 3)) <= 2 for _ in range(200)))
        self.assertTrue(all(gumbel_choice(logits, rng, [0, 3]) in (0, 3) for _ in range(200)))
        with self.assertRaises(ValueError):
            gumbel_choice(np.array([-np.inf, -np.inf]), rng)
        nucleus = [gumbel_choice(np.array([3., 2., 0., -5.]), rng, top_p=.9) for _ in range(500)]
        self.assertEqual(set(nucleus), {0, 1})                                # the tail is never drawn


class SamplerTests(unittest.TestCase):
    def setUp(self):
        self.model = randomized(seed=5)
        self.vocab = TimeVocabulary.load()

    def test_bars_respect_groups_time_voices_and_sounding_range(self):
        composer = Composer(self.model, self.vocab, seed=3, key=(9, 1))
        groups = ['keys', 'woodwinds']
        voice_group = {}
        keys = []
        for meter, length, key in (((4, 4), 4, 'keep'), ((3, 4), 3, (2, 0)), ((6, 8), 3, None)):
            bar = composer.next_bar(length=length, meter=meter, groups=groups, request_groups=True, density=3,
                                    max_notes=24, key=key)
            keys.append((bar['key']['tonic'], bar['key']['mode']))
            self.assertLessEqual(len(bar['notes']), 24)
            for n in bar['notes']:
                self.assertIn(n['group'], groups)
                self.assertTrue(0 <= Fraction(n['onset']) < length)
                self.assertIn(Fraction(n['duration']), self.vocab.index)
                self.assertTrue(n['pitch'] is not None and 0 <= n['pitch'] <= 127)
                self.assertEqual(voice_group.setdefault(n['voice'], n['group']), n['group'])
            onsets = [Fraction(n['onset']) for n in bar['notes']]
            self.assertEqual(onsets, sorted(onsets))
        self.assertEqual(keys[:2], [(9, 1), (2, 0)])                           # first key, then a given key
        self.assertEqual(len(composer.summaries), 3)
        self.assertEqual(len(composer.summaries[0]), SMALL['summary_dim'])
        self.assertEqual(Composer(self.model, self.vocab, seed=3).next_bar(groups=groups, max_notes=24)['notes'],
                         Composer(self.model, self.vocab, seed=3).next_bar(groups=groups, max_notes=24)['notes'])

    def test_keys_and_pitch_decoding(self):
        composer = Composer(self.model, self.vocab, seed=8, key=(0, 0))
        first = composer.next_bar(max_notes=40)
        self.assertEqual(first['key']['tonic'], 0)
        second = composer.next_bar(max_notes=40, key=(6, 1))
        self.assertEqual((second['key']['tonic'], second['key']['mode']), (6, 1))
        self.assertEqual(composer.next_bar(max_notes=8)['key']['tonic'], 6)        # 'keep'
        chosen = composer.next_bar(max_notes=8, key=None)['key']
        self.assertTrue(0 <= chosen['tonic'] < 12 and chosen['mode'] in (0, 1))

    def test_chord_modes(self):
        hold = Composer(self.model, self.vocab, seed=1).next_bar(chord_mode='hold', max_notes=16)
        self.assertEqual(hold['chords'], [])
        composer = Composer(self.model, self.vocab, seed=2)
        for _ in range(3):
            bar = composer.next_bar(chord_mode='bar', max_notes=16)
            self.assertEqual([Fraction(c['onset']) for c in bar['chords']], [0])
        locked = [(0, 0, MAJ), (2, 7, DOM7), (Fraction(7, 2), 9, MIN)]
        bar = Composer(self.model, self.vocab, seed=4).next_bar(chords=locked, max_notes=20, style='symphony-classical')
        self.assertEqual([(Fraction(c['onset']), c['root'], c['quality']) for c in bar['chords']],
                         [(Fraction(o), r, q) for o, r, q in locked])

    def test_reference_modes(self):
        composer = Composer(self.model, self.vocab, seed=6)
        first = composer.next_bar(max_notes=12, groups=('keys',))
        self.assertIsNone(first['reference'])                                  # nothing to point at yet
        named = composer.next_bar(max_notes=12, groups=('keys',), reference=0)
        self.assertEqual(named['reference'], 0)
        self.assertIsNone(composer.next_bar(max_notes=12, groups=('keys',), reference=None)['reference'])
        auto = [composer.next_bar(max_notes=8, groups=('keys',))['reference'] for _ in range(6)]
        self.assertTrue(all(r is None or 0 <= r < 3 + i for i, r in enumerate(auto)))
        self.assertEqual([entry[0] for entry in composer.bank], list(range(9)))
        with self.assertRaises(ValueError):
            composer.next_bar(reference=99)
        with self.assertRaises(ValueError):
            composer.next_bar(reference='bar 1')

    def test_bar_summary_matches_training_summary(self):
        from four_pillar_trial_data import summarize_bars
        from four_pillar_v31_tonal import NoteTable
        score = synthetic_score()
        expected = summarize_bars(score)[1]
        self.assertTrue(np.abs(NoteTable(score).summaries(0, 6) - summarize_bars(score)).max() < 1e-6)
        notes = [{'pitch': n.pitch, 'group': n.group} for n in score.events if n.bar == 1]
        self.assertTrue(all(abs(a - b) < 1e-6 for a, b in zip(bar_summary(notes), expected)))
        from four_pillar_v31_data import bar_profile
        table = NoteTable(score)
        keys = [0, 0, 0, 0, 7, 7]
        for b in range(6):
            events = [(n.onset - score.measures[b].onset, n.pitch) for n in score.events if n.bar == b and not n.grace]
            twin = bar_profile(events, score.measures[b].duration, keys[b] % 12)
            self.assertTrue(np.abs(np.asarray(twin) - table.profiles(b, b + 1, keys)[0]).max() < 1e-12)
        self.assertAlmostEqual(sum(twin[:16]), 1.)
        rotated = key_summary(expected, 7 + 12, 0)
        self.assertAlmostEqual(rotated[0], float(expected[7]))                # degree 0 = G
        self.assertEqual(rotated[20:22], [0., 1.])                           # minor
        self.assertEqual(rotated[22 + 7], 1.)                                # tonic step +7 from C



class ToolTests(unittest.TestCase):
    def test_device_batches_have_no_float64(self):
        from train_four_pillar_v31 import to_device
        batch = {'rope_time': torch.zeros(3, dtype=torch.float64), 'in_kind': torch.ones(3, dtype=torch.long),
                 'history': torch.zeros(2, 4)}
        self.assertIs(to_device(batch, torch.device('cpu')), batch)            # CPU batches stay exact
        moved = to_device(batch, torch.device('meta'))                         # stands in for MPS (no float64)
        self.assertEqual({k: v.dtype for k, v in moved.items()},
                         {'rope_time': torch.float32, 'in_kind': torch.long, 'history': torch.float32})
        self.assertTrue(all(v.device.type == 'meta' for v in moved.values()))

    def test_midi_export_keeps_the_sounding_notes(self):
        from symusic import Score
        from four_pillar_v31_midi import to_midi
        note = lambda onset, duration, group, voice, pitch, velocity, drum=None: {  # noqa: E731
            'onset': onset, 'duration': duration, 'group': group, 'voice': voice, 'pitch': pitch, 'drum': drum,
            'velocity': velocity}
        bars = [{'length': '3', 'meter': [3, 4], 'key': {'name': 'A minor'}, 'chords': [{'onset': '0', 'name': 'Am'}],
                 'notes': [note('0', '1', 'keys', 0, 45, 70), note('0', '3', 'keys', 1, 72, 80),
                           note('1/3', '1/3', 'high_strings', 2, 76, 60),
                           note('1/2', '2', 'keys', 0, 72, 90),               # repeats the held C of voice 1
                           note('1', '1/2', 'percussion', 3, None, 100, drum=38),
                           note('2', '1', 'low_strings', 4, 36, 64)]},
                {'length': '3', 'meter': [6, 8], 'key': {'name': 'D major'}, 'chords': [],
                 'notes': [note('0', '3/2', 'brass', 5, 60, 75)]}]
        data, summary = to_midi({'bars': bars}, 120.)
        score = Score.from_midi(data)
        self.assertEqual(score.ticks_per_quarter, 960)
        tracks = {t.name: (t.program, t.is_drum, sorted(n.pitch for n in t.notes)) for t in score.tracks}
        self.assertEqual(tracks['Piano'], (0, False, [45, 72, 72]))
        self.assertEqual(tracks['Violin'], (40, False, [76]))
        self.assertEqual(tracks['Double bass'], (43, False, [36]))
        self.assertEqual(tracks['French horn'], (60, False, [60]))
        self.assertEqual(tracks['Percussion'][1:], (True, [38]))
        piano = sorted((n.time, n.duration, n.pitch) for t in score.tracks if t.name == 'Piano' for n in t.notes)
        self.assertEqual(piano, [(0, 480, 72), (0, 960, 45), (480, 1920, 72)])   # the held C ends at the repeat
        self.assertEqual([(n.time, n.duration) for t in score.tracks if t.name == 'Violin' for n in t.notes],
                         [(320, 320)])                                            # triplet eighth, exact
        self.assertEqual([(x.time, x.numerator, x.denominator) for x in score.time_signatures],
                         [(0, 3, 4), (2880, 6, 8)])
        self.assertEqual([x.text for x in score.markers], ['A minor', 'Am', 'D major'])
        self.assertAlmostEqual(score.tempos[0].qpm, 120., places=3)
        self.assertEqual(summary['notes'], 7)


if __name__ == '__main__':
    unittest.main()
