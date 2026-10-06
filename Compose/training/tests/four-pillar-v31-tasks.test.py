"""Four-pillar v3.1 split into planner and composer parts, and the composition tasks on top of them
(locks inside generated bars, orchestration, best-of-K candidates, synthetic references, motif transformations)."""
import pathlib
import sys
import tempfile
import unittest
from collections import Counter
from fractions import Fraction

import numpy as np
import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_codec import GROUPS
from four_pillar_v31_model import CONFIG, FourPillarV31
from four_pillar_v31_sample import Composer
from four_pillar_v31_time import TimeVocabulary
from four_pillar_v31_tonal import QUALITY_INDEX
from four_pillar_v31_parts import (PlannerPart, assemble, load_parts, planner_free, planner_frozen, save_parts, split,
                                   summary_of_bar)
from four_pillar_v31_tasks import (Lock, TaskComposer, development_plan, reference_from_notes, stream_key,
                                   transform_motif)

SMALL = {**CONFIG, 'width': 48, 'heads': 4, 'layers': 2, 'planner_layers': 1, 'history_bars': 16, 'attr_hidden': 64}
MAJ, DOM7 = QUALITY_INDEX['maj'], QUALITY_INDEX['dom7']
WEIGHTS = pathlib.Path(__file__).resolve().parents[1] / 'runs/four-pillar-v31-ready-20261001/weights.pt'
F = Fraction


def randomized(config=SMALL, seed=0):
    """A model whose zero-initialized parts are nonzero, so equivalence tests exercise every parameter."""
    torch.manual_seed(seed)
    model = FourPillarV31(config).eval()
    with torch.no_grad():
        for parameter in model.parameters():
            parameter.add_(torch.randn_like(parameter) * .05)
    return model


def music(bar):
    return {k: bar[k] for k in ('notes', 'chords', 'key', 'reference', 'length', 'meter')}


def unisons_before(bar, given):
    """(onset, pitch, group) of each free note at a given note's onset and pitch written before that note."""
    seen, out = set(), []
    for n in bar['notes']:
        here = (F(n['onset']), n['pitch'])
        if n.get('locked'):
            seen.add(here)
        elif here in given and here not in seen:
            out.append(here + (n['group'],))
    return out


def melody_locks(group=6):
    return [Lock(onset=F(o), pitch=p, duration=F(d), group=group, identity=('voice', '1', '1'), tag=i)
            for i, (o, p, d) in enumerate([(0, 72, 1), (1, 74, F(1, 2)), (F(3, 2), 76, F(1, 2)), (2, 79, 2)])]


class PartsTests(unittest.TestCase):
    def setUp(self):
        self.model = randomized(seed=3)
        self.vocab = TimeVocabulary.load()

    def test_split_and_assemble_keep_every_tensor(self):
        planner, composer = split(self.model)
        rebuilt = assemble(planner, composer)
        original = self.model.state_dict()
        self.assertEqual(set(original), set(rebuilt.state_dict()))
        for name, tensor in rebuilt.state_dict().items():
            self.assertTrue(torch.equal(tensor, original[name]), name)
        total = sum(p.numel() for p in self.model.parameters())
        shared = self.model.modulation_in.weight.numel()
        self.assertEqual(sum(p.numel() for p in planner.parameters()) + sum(p.numel() for p in composer.parameters()),
                         total + shared)

    def test_assembled_model_generates_the_same_bars(self):
        planner, composer = split(self.model)
        a = Composer(self.model, self.vocab, seed=4, key=(2, 0))
        b = Composer(assemble(planner, composer), self.vocab, seed=4, key=(2, 0))
        for _ in range(4):
            self.assertEqual(music(a.next_bar(max_notes=24)), music(b.next_bar(max_notes=24)))

    def test_composer_alone(self):
        _, composer = split(self.model)
        alone = Composer(planner_free(composer), self.vocab, seed=2, key=(0, 0))
        bars = [alone.next_bar(max_notes=16) for _ in range(4)]
        self.assertTrue(all(b['reference'] is None for b in bars))        # the pointer never restates by itself
        self.assertEqual(alone.next_bar(max_notes=16, reference=1)['reference'], 1)   # a named bar still works
        with self.assertRaises(ValueError):
            alone.next_bar(key=None)                                       # no key head without the planner
        plans = {tuple(p.reshape(-1).tolist()) for _, p, _ in alone.bank}
        self.assertEqual(len(plans), 1)                                    # always the empty plan

    def test_planner_alone_matches_the_model(self):
        planner, _ = split(self.model)
        composer = Composer(self.model, self.vocab, seed=6, key=(5, 1))
        bars = [composer.next_bar(max_notes=12) for _ in range(3)]
        key = 5 + 12
        rows = [summary_of_bar(b['notes'], key=key, previous_key=None if i == 0 else key, length=F(4), index=i)
                for i, b in enumerate(bars)]
        for mine, theirs in zip(rows, composer.summaries):
            self.assertTrue(np.allclose(mine, theirs, atol=1e-6))
        history = torch.tensor([rows], dtype=torch.float32)
        with torch.no_grad():
            self.assertTrue(torch.allclose(planner.plan_bars(history), self.model.plan_bars(history), atol=1e-6))
            self.assertTrue(torch.allclose(planner.plan_bars(history)[0, -1], composer.plan.reshape(-1), atol=1e-5))
            self.assertTrue(torch.equal(planner.empty_plan(), self.model.plan_norm(self.model.plan_empty)))

    def test_save_and_load_parts(self):
        with tempfile.TemporaryDirectory() as directory:
            info = save_parts(self.model, pathlib.Path(directory) / 'parts', {'note': 'test'})
            self.assertEqual(set(info), {'planner', 'composer'})
            planner, composer = load_parts(pathlib.Path(directory) / 'parts')
            self.assertIsInstance(planner, PlannerPart)
            rebuilt = assemble(planner, composer)
            for name, tensor in rebuilt.state_dict().items():
                self.assertTrue(torch.equal(tensor, self.model.state_dict()[name]), name)
            with self.assertRaises(FileExistsError):
                save_parts(self.model, pathlib.Path(directory) / 'parts')

    def test_planner_frozen_trains_only_the_composer(self):
        model = randomized(seed=8).train()
        history = torch.randn(1, 3, SMALL['summary_dim'])
        with planner_frozen(model):
            plans = model.plan_bars(history)
            (plans.sum() + model.kind_in.weight.sum()).backward()
        self.assertIsNone(model.summary_input.weight.grad)
        self.assertIsNotNone(model.kind_in.weight.grad)
        self.assertNotIn('plan_bars', model.__dict__)                       # the method is restored


class LockTests(unittest.TestCase):
    def setUp(self):
        self.model = randomized(seed=5)
        self.vocab = TimeVocabulary.load()

    def test_without_locks_it_is_the_v31_composer(self):
        for seed, kwargs in ((1, {}), (2, {'chord_mode': 'bar', 'groups': ('keys', 'brass')}),
                             (3, {'chord_mode': 'hold', 'density': 2}),
                             (4, {'chords': ((0, 0, MAJ), (2, 7, DOM7))})):
            a = Composer(self.model, self.vocab, seed=seed, key=(9, 1))
            b = TaskComposer(self.model, self.vocab, seed=seed, key=(9, 1))
            for _ in range(3):
                self.assertEqual(music(a.next_bar(max_notes=20, **kwargs)),
                                 music(b.next_bar_locked(max_notes=20, **kwargs)))

    def check_stream_order(self, bar):
        """Onsets never go back; at each onset the notes written before a lock sort below it."""
        onsets = [F(n['onset']) for n in bar['notes']]
        self.assertEqual(onsets, sorted(onsets))
        for i, n in enumerate(bar['notes']):
            if not n.get('locked'):
                continue
            mine = stream_key(n['pitch'] is None, GROUPS.index(n['group']) if n['group'] else 6, n['pitch'])
            for before in bar['notes'][:i]:
                if before['onset'] == n['onset'] and not before.get('locked'):
                    group = GROUPS.index(before['group']) if before['group'] else 6
                    self.assertLess(stream_key(before['pitch'] is None, group, before['pitch']), mine)

    def test_locks_are_written_exactly_and_in_stream_order(self):
        for seed in range(6):
            composer = TaskComposer(self.model, self.vocab, seed=seed, key=(0, 0))
            for _ in range(3):
                bar = composer.next_bar_locked(groups=('keys', 'low_strings'), locks=melody_locks(), max_notes=30)
                written = [(F(n['onset']), n['pitch'], F(n['duration']), n['group'], n['tag'])
                           for n in bar['notes'] if n.get('locked')]
                self.assertEqual(written, [(F(0), 72, F(1), None, 0), (F(1), 74, F(1, 2), None, 1),
                                           (F(3, 2), 76, F(1, 2), None, 2), (F(2), 79, F(2), None, 3)])
                self.assertEqual(bar['locks'], 4)
                self.assertTrue(np.isfinite(bar['lockScore']) and bar['lockScore'] < 0)
                self.check_stream_order(bar)
                for n in bar['notes']:
                    if not n.get('locked'):
                        self.assertIn(n['group'], ('keys', 'low_strings'))
            slot = composer.state.registry[('voice', '1', '1')]
            self.assertTrue(all(n['voice'] == slot for b in [bar] for n in b['notes'] if n.get('locked')))

    def test_free_notes_never_take_a_locked_voice(self):
        composer = TaskComposer(self.model, self.vocab, seed=11, key=(0, 0))
        locks = melody_locks(group=GROUPS.index('keys'))
        for _ in range(3):
            bar = composer.next_bar_locked(groups=('keys',), locks=locks, max_notes=30)
            slot = composer.state.registry[('voice', '1', '1')]
            self.assertTrue(all(n['voice'] != slot for n in bar['notes'] if not n.get('locked')))

    def check_given_notes_come_first(self, bar, locks):
        """A free note at the very onset and pitch of a lock comes only after that lock (as a doubling), and no
        voice has the same pitch twice at one onset."""
        self.assertEqual(unisons_before(bar, {(F(lock.onset), lock.pitch) for lock in locks}), [])
        repeats = Counter((F(n['onset']), n['voice'], n['pitch']) for n in bar['notes'])
        self.assertEqual(max(repeats.values()), 1)

    def test_a_given_note_is_not_copied_into_the_free_groups_first(self):
        open_group = [Lock(onset=F(o), pitch=p, duration=F(1), tag=(o, p)) for o, p in ((0, 48), (0, 64), (1, 67),
                                                                                    (2, 72), (3, 60))]
        for seed in range(8):
            for locks, groups in ((melody_locks(), ('keys',)), (open_group, ('woodwinds', 'high_strings'))):
                composer = TaskComposer(self.model, self.vocab, seed=seed, key=(0, 0))
                for _ in range(2):
                    bar = composer.next_bar_locked(groups=groups, locks=locks, max_notes=40)
                    self.assertEqual(bar['locks'], len(locks))
                    self.check_given_notes_come_first(bar, locks)

    def test_the_given_part_may_be_chosen_at_its_onset(self):
        """A lock in a group the free notes may not use: picking that group means the lock, never a free note."""
        violin = melody_locks(group=GROUPS.index('high_strings'))
        for seed in range(6):
            composer = TaskComposer(self.model, self.vocab, seed=seed, key=(0, 0))
            for _ in range(2):
                bar = composer.next_bar_locked(groups=('keys', 'high_strings'), free_groups=('keys',), locks=violin,
                                               max_notes=30)
                self.assertEqual(bar['locks'], 4)
                self.assertTrue(all(n['group'] == ('high_strings' if n.get('locked') else 'keys')
                                    for n in bar['notes']))
                repeats = Counter((F(n['onset']), n['voice'], n['pitch']) for n in bar['notes'])
                self.assertEqual(max(repeats.values()), 1)

    def test_unison_before_a_lock_at_most_once_per_group(self):
        locks = melody_locks()
        given = {(F(lock.onset), lock.pitch) for lock in locks}
        for seed in range(6):
            composer = TaskComposer(self.model, self.vocab, seed=seed, key=(0, 0))
            for _ in range(2):
                bar = composer.next_bar_locked(groups=('keys', 'woodwinds'), locks=locks, max_notes=40,
                                               unison='before')
                self.assertEqual(bar['locks'], 4)
                self.assertEqual(max(Counter(unisons_before(bar, given)).values(), default=1), 1)
        with self.assertRaises(ValueError):
            TaskComposer(self.model, self.vocab, seed=0).next_bar_locked(unison='never')

    def test_locks_outside_the_bar_are_reported(self):
        composer = TaskComposer(self.model, self.vocab, seed=1)
        bar = composer.next_bar_locked(length=F(2), meter=(2, 4), locks=melody_locks(), max_notes=10)
        self.assertEqual(bar['locks'], 3)
        self.assertEqual(bar['locksOutsideBar'], 1)

    def test_orchestration_assigns_allowed_groups_to_every_given_note(self):
        notes = [(0, p) for p in (36, 48, 55, 64, 72)] + [(2, p) for p in (43, 50, 59, 67, 74)]
        locks = [Lock(onset=F(o), pitch=p, duration=F(2), tag=(o, p)) for o, p in notes]
        allowed = ('woodwinds', 'brass', 'high_strings', 'low_strings')
        results = []
        for _ in range(2):
            composer = TaskComposer(self.model, self.vocab, seed=3, key=(0, 0))
            bar = composer.next_bar_locked(groups=allowed, locks=locks, free_notes=False)
            self.assertEqual(sorted((F(n['onset']), n['pitch']) for n in bar['notes']),
                             sorted((F(o), p) for o, p in notes))
            self.assertTrue(all(n['group'] in allowed and n['locked'] for n in bar['notes']))
            results.append([(n['group'], n['voice']) for n in bar['notes']])
        self.assertEqual(results[0], results[1])                     # 'best' is deterministic

    def test_expression_only_and_open_pitches(self):
        composer = TaskComposer(self.model, self.vocab, seed=7, key=(0, 0))
        given = [Lock(onset=F(o), pitch=p, duration=F(1), group=GROUPS.index('keys'), identity=('pf', '1', '1'))
                 for o, p in ((0, 60), (1, 62), (2, 64), (3, 65))]
        bar = composer.next_bar_locked(groups=('keys',), locks=given, free_notes=False)
        self.assertEqual([(n['onset'], n['pitch'], n['duration']) for n in bar['notes']],
                         [('0', 60, '1'), ('1', 62, '1'), ('2', 64, '1'), ('3', 65, '1')])
        self.assertTrue(all(1 <= n['velocity'] <= 127 for n in bar['notes']))
        rhythm = [Lock(onset=F(o), duration=F(1, 2), group=GROUPS.index('keys'), identity=('pf', '1', '1'))
                  for o in (0, F(1, 2), 1, 2)]
        bar = composer.next_bar_locked(groups=('keys',), locks=rhythm, free_notes=False)
        self.assertEqual([F(n['onset']) for n in bar['notes']], [F(0), F(1, 2), F(1), F(2)])
        self.assertTrue(all(0 <= n['pitch'] <= 127 for n in bar['notes']))

    def test_free_filter(self):
        composer = TaskComposer(self.model, self.vocab, seed=2, key=(0, 0))
        keep = lambda position, group, pitch: pitch is not None and pitch % 12 in (0, 4, 7)   # noqa: E731
        for _ in range(3):
            bar = composer.next_bar_locked(groups=('keys', 'woodwinds'), locks=melody_locks(), free_filter=keep,
                                           max_notes=30)
            self.assertTrue(all(n['pitch'] % 12 in (0, 4, 7) for n in bar['notes'] if not n.get('locked')))
            self.assertEqual(bar['locks'], 4)

    def test_locked_chords_and_locked_notes_together(self):
        chords = ((0, 0, MAJ), (F(3, 2), 7, DOM7), (3, 9, QUALITY_INDEX['min']))
        for seed in range(4):
            composer = TaskComposer(self.model, self.vocab, seed=seed, key=(0, 0))
            bar = composer.next_bar_locked(groups=('keys',), locks=melody_locks(), chords=chords, max_notes=20)
            self.assertEqual([(F(c['onset']), c['root'], c['quality']) for c in bar['chords']],
                             [(F(o), r, q) for o, r, q in chords])
            self.assertEqual(bar['locks'], 4)

    def test_best_of_candidates(self):
        def run():
            composer = TaskComposer(self.model, self.vocab, seed=21, key=(0, 0))
            bars = [composer.best_of(4, groups=('keys',), locks=melody_locks(), max_notes=20) for _ in range(2)]
            return composer, bars
        (c1, b1), (_, b2) = run(), run()
        self.assertEqual([music(b) for b in b1], [music(b) for b in b2])
        for bar in b1:
            self.assertEqual(len(bar['candidates']), 4)
            self.assertAlmostEqual(bar['lockScore'], max(bar['candidates']), places=2)
        self.assertEqual(c1.bar_index, 2)
        self.assertEqual(len(c1.summaries), 2)
        self.assertEqual([e[0] for e in c1.bank], [0, 1])

    def test_locked_clashes(self):
        def note(onset, pitch, duration, locked=False):
            return {'onset': str(onset), 'pitch': pitch, 'duration': str(duration), 'locked': locked}
        bar = {'notes': [note(0, 60, 2), note(0, 61, 1, True), note(1, 67, 1, True), note(2, 59, 1, True),
                         note(3, 72, 1, True), note(2, None, 1)]}
        # 61 sits a semitone above the free 60; 59 starts when the free 60 has ended; 67 and 72 do not clash
        self.assertEqual(TaskComposer.locked_clashes(bar), 1)
        self.assertEqual(TaskComposer.locked_clashes({'notes': []}), 0)

    def test_clash_penalty_selects_fewest_clashes(self):
        composer = TaskComposer(self.model, self.vocab, seed=21, key=(0, 0))
        bar = composer.best_of(6, clash_penalty=1000., groups=('keys',), locks=melody_locks(), max_notes=20)
        self.assertEqual(len(bar['candidateClashes']), 6)
        self.assertEqual(bar['lockedClashes'], min(bar['candidateClashes']))
        self.assertEqual(bar['lockedClashes'], bar['candidateClashes'][bar['chosenCandidate']])

    def test_fork_is_independent(self):
        composer = TaskComposer(self.model, self.vocab, seed=4, key=(0, 0))
        composer.next_bar_locked(max_notes=10)
        before = (composer.bar_index, composer.position, len(composer.state.registry), composer.state.events)
        fork = composer.fork(99)
        fork.next_bar_locked(max_notes=10, locks=melody_locks())
        self.assertEqual((composer.bar_index, composer.position, len(composer.state.registry), composer.state.events),
                         before)
        twin = TaskComposer(self.model, self.vocab, seed=4, key=(0, 0))
        twin.next_bar_locked(max_notes=10)
        self.assertEqual(music(composer.next_bar_locked(max_notes=10)), music(twin.next_bar_locked(max_notes=10)))

    def test_synthetic_reference(self):
        motif = [{'onset': F(0), 'duration': F(1), 'pitch': 72, 'group': 4},
                 {'onset': F(1), 'duration': F(1), 'pitch': 76, 'group': 4}]
        reference = reference_from_notes(motif, self.vocab, tonic=0, length=F(4))
        self.assertEqual(sorted(reference.at), [self.vocab.index[F(0)], self.vocab.index[F(1)]])
        composer = TaskComposer(self.model, self.vocab, seed=1, key=(0, 0))
        composer.next_bar_locked(max_notes=8)
        bar = composer.next_bar_locked(max_notes=8, reference=reference)
        self.assertEqual(bar['reference'], 'synthetic')
        self.assertEqual([e[0] for e in composer.bank], [0, 1])


class MotifTests(unittest.TestCase):
    MOTIF = [{'onset': F(o), 'duration': F(d), 'pitch': p, 'group': 4}
             for o, p, d in ((0, 72, F(1, 2)), (F(1, 2), 74, F(1, 2)), (1, 76, 1), (2, 79, 2))]

    def pitches(self, how, steps=0, tonic=0, mode=0, motif=None):
        bars = transform_motif(motif or self.MOTIF, F(4), tonic=tonic, mode=mode, how=how, steps=steps)
        return [[(n['onset'], n['pitch'], n['duration']) for n in bar] for bar in bars]

    def test_transformations_in_c_major(self):
        self.assertEqual(self.pitches('sequence', 1)[0],
                         [(0, 74, F(1, 2)), (F(1, 2), 76, F(1, 2)), (1, 77, 1), (2, 81, 2)])
        self.assertEqual([p for _, p, _ in self.pitches('invert')[0]], [72, 71, 69, 65])
        self.assertEqual([o for o, _, _ in self.pitches('retrograde')[0]], [F(7, 2), F(3), F(2), F(0)])
        self.assertEqual(self.pitches('augment'), [[(0, 72, 1), (1, 74, 1), (2, 76, 2)], [(0, 79, 4)]])
        diminished = self.pitches('diminish')[0]
        self.assertEqual(len(diminished), 8)
        self.assertEqual(diminished[4], (2, 72, F(1, 4)))
        self.assertEqual(self.pitches('fragment', -1)[0][3:], [(2, 71, F(1, 2)), (F(5, 2), 72, F(1, 2)), (3, 74, 1)])

    def test_sequence_in_minor_keeps_chromatic_notes(self):
        motif = [{'onset': F(0), 'duration': F(1), 'pitch': 68, 'group': 4},   # G# leading tone in A minor
                 {'onset': F(1), 'duration': F(1), 'pitch': 69, 'group': 4}]
        self.assertEqual([p for _, p, _ in self.pitches('sequence', 0, tonic=9, mode=1, motif=motif)[0]], [68, 69])
        self.assertEqual([p for _, p, _ in self.pitches('sequence', 7, tonic=9, mode=1, motif=motif)[0]], [80, 81])

    def test_plan(self):
        self.assertEqual([h for h, _ in development_plan(5)], ['repeat', 'sequence', 'fragment', 'free', 'invert'])


@unittest.skipUnless(WEIGHTS.exists(), 'trained v3.1 weights not present')
class TrainedWeightsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from four_pillar_v31_sample import load
        cls.model, cls.vocab, _ = load(WEIGHTS)

    def test_trained_parts_and_a_locked_melody(self):
        planner, composer = split(self.model)
        a = Composer(self.model, self.vocab, seed=11, key=(0, 0))
        b = Composer(assemble(planner, composer), self.vocab, seed=11, key=(0, 0))
        self.assertEqual(music(a.next_bar()), music(b.next_bar()))
        task = TaskComposer(self.model, self.vocab, seed=5, key=(0, 0))
        bar = task.best_of(4, groups=('keys',), locks=melody_locks())
        self.assertEqual(bar['locks'], 4)
        self.assertTrue(any(not n.get('locked') for n in bar['notes']))

    def test_trained_accompaniment_and_the_voice(self):
        """A sung melody over piano. Default: the piano never writes the melody note itself before the melody;
        unison='before': it may double it there, once per note (the trained model does so often)."""
        melody = [[(0, 72), (1, 72), (2, 79), (3, 79)], [(0, 81), (1, 81), (2, 79)], [(0, 77), (1, 77), (2, 76), (3, 76)]]
        doubled_first = 0
        for unison in ('after', 'before'):
            task = TaskComposer(self.model, self.vocab, seed=3, key=(0, 0))
            for bar_notes in melody:
                locks = [Lock(onset=F(o), pitch=p, duration=F(1 if i < len(bar_notes) - 1 or o == 3 else 2), group=6,
                              identity=('voice', '1', '1'), dynamic=0) for i, (o, p) in enumerate(bar_notes)]
                bar = task.next_bar_locked(groups=('keys',), locks=locks, temperature=.9, top_p=.95, unison=unison)
                self.assertEqual(bar['locks'], len(locks))
                free = [n for n in bar['notes'] if not n.get('locked')]
                self.assertTrue(free)
                self.assertTrue(all(n['group'] == 'keys' for n in free))
                before = unisons_before(bar, {(F(lock.onset), lock.pitch) for lock in locks})
                if unison == 'after':
                    self.assertEqual(before, [])
                else:
                    self.assertEqual(max(Counter(before).values(), default=1), 1)
                    doubled_first += len(before)
                repeats = Counter((F(n['onset']), n['voice'], n['pitch']) for n in bar['notes'])
                self.assertEqual(max(repeats.values()), 1)
        self.assertGreater(doubled_first, 0)


if __name__ == '__main__':
    unittest.main()
