#!/usr/bin/env python3
"""Four-pillar v3.1 composition tasks: given material inside the bars being written.

Cantelvio Score asks for five tasks: continue, melody-from-chords, accompany-melody, develop-motif and
orchestrate. v3.1 writes one event at a time in a fixed stream order (per onset: chord changes, unpitched
notes, pitched notes from the lowest up) and only ever sees what is already written, so given material has to
enter the stream in that same order. `TaskComposer` extends the v3.1 `Composer` (decoding only; the trained
model, its code and its weights are unchanged):

locks        Given notes inside the bar being written. A lock fixes its onset and any of group, voice
             identity, pitch, duration and expression; whatever it leaves open is chosen by the model. Free
             events the model proposes are kept when they come before the next lock in stream order (and pass
             the task's filter); any other proposal (a later onset, a note above the lock at its onset, the end
             of the bar) is read as "write the lock now". So is, at a lock's onset, picking the lock's group
             (offered even when the model's own notes may not use it) or proposing the lock's very pitch in
             another group: without this the masked model keeps writing the given note into the free groups.
             With unison='before' one such note per group is kept as a unison doubling first, as in the
             training order; a lock with an open group is always recognised by its pitch and then takes the
             group and voice of that proposal. The model's own notes never repeat a pitch in one voice at one
             onset. Locks are kept exactly; they are never moved or dropped, except a lock whose onset falls
             outside the bar (reported).
orchestration  A lock without a group or voice gets the (group, voice) under which the model finds that exact
             pitch and duration most likely: p(group) p(voice | group) p(pitch | group, voice) p(duration | ...),
             enumerated over the allowed groups and their voices (attribute-decoder steps only); when the model
             itself proposes that pitch there (free notes allowed), the proposal's group and voice are used, a
             draw from the same posterior.
candidates   Best of K: K copies of the composer write the same bar with different random draws; the copy
             under which the locked material is most probable is kept. For a locked melody this is the
             melody's log-probability given the accompaniment written around it (`lockScore`).
references   A bar may restate a synthetic reference (`Reference`, e.g. a transformed motif, see
             `transform_motif`) instead of an earlier bar.

Everything here is a sampling-side constraint, not new training; musical quality has to be judged by
listening.
"""
from __future__ import annotations

import bisect
import collections
import copy
import math
import time
from dataclasses import dataclass
from fractions import Fraction

import numpy as np
import torch

from four_pillar_codec import DYNAMICS, GROUPS, WEDGES
from four_pillar_v31_data import BarContext, Reference, bar_profile, bar_vector, density_bucket, meter_codes
from four_pillar_v31_model import (ABS_UNPITCHED, DENSITY_BUCKETS, KIND_CHORD, KIND_END, KIND_NOTE, PITCH_UNPITCHED,
                                   SOURCE_NONE, SOURCES, UNKNOWN_GROUP)
from four_pillar_v31_sample import CHORD_MODES, NAMES, Composer, Sampler, bar_summary, gumbel_choice, valid_range
from four_pillar_v31_tonal import QUALITIES, REL_OFFSET, apply_key_change, key_id, key_parts, tonic_ref

PERCUSSION = GROUPS.index('percussion')
MAJOR_SCALE, MINOR_SCALE = (0, 2, 4, 5, 7, 9, 11), (0, 2, 3, 5, 7, 8, 10)


@dataclass
class Lock:
    """A given note inside a generated bar. `None` leaves an attribute to the model."""
    onset: Fraction                    # position in the bar (quarters)
    pitch: int | None = None           # sounding MIDI pitch (ignored when unpitched)
    duration: Fraction | None = None   # quarters
    group: int | None = None           # 0..5 = GROUPS, 6 = outside the six groups (e.g. a voice part)
    identity: tuple | None = None      # voice identity, e.g. (part, staff, voice)
    unpitched: bool = False
    drum: int | None = None            # GM drum key for unpitched locks
    velocity: int | None = None
    dynamic: int | None = None         # 0 = none, 1 + index into DYNAMICS
    accent: int | None = None
    wedge: int | None = None           # 0 = none, 1 + index into WEDGES
    tag: object = None                 # returned with the written note


def stream_key(unpitched: bool, group: int | None, pitch: int | None) -> tuple:
    """Order of notes at one onset in the v3.1 stream: unpitched (by group) before pitched (low to high, then by
    group). An unknown group sorts last among equals, an unknown pitch first."""
    g = 7 if group is None else group
    if unpitched:
        return 0, g, 0
    return 1, -1 if pitch is None else pitch, g


def _logp(logits, index: int, allowed=None) -> float:
    """log softmax(logits)[index] over `allowed` (None, a range or a list of indices)."""
    x = torch.as_tensor(logits, dtype=torch.float64).reshape(-1)
    if allowed is not None:
        mask = torch.full_like(x, -math.inf)
        idx = torch.as_tensor(list(allowed), dtype=torch.long)
        mask[idx] = x[idx]
        x = mask
    return float(x[index] - torch.logsumexp(x, 0))


class TaskComposer(Composer):
    """The v3.1 Composer with locks, orchestration, candidates and synthetic references (see module doc).

    With no locks and no synthetic reference, `next_bar_locked` writes exactly what `next_bar` writes for the
    same random state."""

    # ------------------------------------------------------------------ copies (for candidates)
    def fork(self, seed: int) -> 'TaskComposer':
        """An independent copy that shares only the model, kernel and vocabulary; its own random stream."""
        other = copy.copy(self)
        other.rng = np.random.Generator(np.random.PCG64(seed))
        other.state = copy.deepcopy(self.state, {id(self.vocab): self.vocab, id(self.state.config): self.state.config})
        other.cache = [{'k': c['k'].clone(), 'v': c['v'].clone(), 'count': c['count']} for c in self.cache]
        other.planner_cache = [{'k': c['k'].clone(), 'v': c['v'].clone(), 'count': c['count']}
                               for c in self.planner_cache]
        other.bank = collections.deque(self.bank, maxlen=self.bank.maxlen)
        other.summaries = list(self.summaries)
        other.identities = dict(self.identities)
        return other

    def adopt(self, other: 'TaskComposer') -> None:
        """Continue from `other`'s state (keeps this composer's random stream)."""
        rng = self.rng
        self.__dict__.update(other.__dict__)
        self.rng = rng

    # ------------------------------------------------------------------ references
    def _reference(self, chooser, plan, reference):
        if isinstance(reference, Reference):
            return 'synthetic', None, reference
        return super()._reference(chooser, plan, reference)

    # ------------------------------------------------------------------ public API
    def next_bar_locked(self, *, length=Fraction(4), meter=(4, 4), tempo: float | None = 92., groups=GROUPS,
                        request_groups: bool = False, density: int | None = None, key='keep',
                        chord_mode: str = 'free', chords=(), style: str | None = None, max_notes: int = 128,
                        temperature: float = 1., top_p: float = 1., meter_known: bool = True, reference='auto',
                        locks=(), free_notes: bool = True, free_groups=None, free_filter=None,
                        lock_choice: str = 'best', unison: str = 'after') -> dict:
        """Write one bar around `locks` (see Lock).

        groups: groups the model may use (hard mask); free_groups: a subset for the model's own notes (None =
        all of `groups`); free_notes=False writes only the locks (orchestration, expression). free_filter
        (onset position, group, pitch) -> bool keeps a proposed free note, otherwise the proposal is read as
        "next lock" (or the end of the bar). lock_choice: 'best' takes the most likely (group, voice) of an
        open lock, 'sample' draws it. unison: a model note at a lock's onset and very pitch, in a group other
        than the lock's, is read as that lock ('after': the model's notes double a given note at the unison only
        once it is written) or kept once per group as a doubling ('before', the training order; the next such
        proposal is the lock). Locks with an open group are always recognised by their pitch. max_notes caps the
        model's own notes; locks are always written. Other arguments as in Composer.next_bar; `reference` may
        also be a synthetic Reference."""
        if not temperature > 0:
            raise ValueError('temperature must be positive')
        if not 0 < top_p <= 1:
            raise ValueError('top_p must be in (0, 1]')
        if chord_mode not in CHORD_MODES:
            raise ValueError('chord_mode must be free, hold or bar')
        if style is not None and style not in SOURCES:
            raise ValueError('style must be one of ' + ', '.join(SOURCES))
        if lock_choice not in ('best', 'sample'):
            raise ValueError("lock_choice must be 'best' or 'sample'")
        if unison not in ('after', 'before'):
            raise ValueError("unison must be 'after' or 'before'")
        return self._task_bar(Sampler(self.rng, temperature, top_p), length=length, meter=meter, tempo=tempo,
                              groups=groups, request_groups=request_groups, density=density, key=key,
                              chord_mode=chord_mode, chords=chords, style=style, max_notes=max_notes,
                              meter_known=meter_known, reference=reference, locks=list(locks),
                              free_notes=free_notes, free_groups=free_groups, free_filter=free_filter,
                              lock_choice=lock_choice, unison=unison)

    @staticmethod
    def locked_clashes(bar: dict) -> int:
        """Locked (given) pitched notes that start a semitone (or major seventh) away from a free pitched note
        sounding at that moment in this bar. Free notes carried over from earlier bars are not counted."""
        free = [(Fraction(n['onset']), Fraction(n['onset']) + Fraction(n['duration']), n['pitch'])
                for n in bar['notes'] if not n.get('locked') and n.get('pitch') is not None]
        count = 0
        for n in bar['notes']:
            if n.get('locked') and n.get('pitch') is not None:
                t = Fraction(n['onset'])
                count += any(a <= t < e and (q - n['pitch']) % 12 in (1, 11) for a, e, q in free)
        return count

    def best_of(self, candidates: int, *, clash_penalty: float = 0., **kwargs) -> dict:
        """Write the bar `candidates` times from the current state and keep the best (ties: the first).
        A candidate's score is its lockScore (log-probability of the locks) minus `clash_penalty` per locked
        note that a free note sounds a semitone or major seventh against (`locked_clashes`); with the default
        0 only the lockScore counts. Each candidate's lockScore is reported in 'candidates', the number of
        clashes of every candidate in 'candidateClashes', of the chosen one in 'lockedClashes'."""
        if candidates <= 1:
            bar = self.next_bar_locked(**kwargs)
            bar['lockedClashes'] = self.locked_clashes(bar)
            return bar
        seeds = self.rng.integers(0, 2 ** 63 - 1, size=candidates)
        tried = []
        for seed in seeds:
            fork = self.fork(int(seed))
            bar = fork.next_bar_locked(**kwargs)
            bar['lockedClashes'] = self.locked_clashes(bar)
            tried.append((bar, fork))
        best = max(range(len(tried)), key=lambda i: tried[i][0]['lockScore'] - clash_penalty * tried[i][0]['lockedClashes'])
        bar, chosen = tried[best]
        self.adopt(chosen)
        bar['candidates'] = [round(b['lockScore'], 3) for b, _ in tried]
        bar['candidateClashes'] = [b['lockedClashes'] for b, _ in tried]
        bar['chosenCandidate'] = best
        return bar

    # ------------------------------------------------------------------ the bar loop
    def _prepare_locks(self, locks, length):
        prepared, dropped = [], 0
        for order, lock in enumerate(locks):
            onset_index, _ = self.vocab.lookup(Fraction(lock.onset))
            if onset_index >= len(self.vocab) or self.vocab.value(onset_index) >= length:
                dropped += 1
                continue
            duration_index = None
            if lock.duration is not None:
                duration_index, _ = self.vocab.lookup(Fraction(lock.duration), positive=True)
            unpitched = bool(lock.unpitched)
            if not unpitched and lock.pitch is not None and not 0 <= int(lock.pitch) <= 127:
                raise ValueError('locked pitch outside MIDI 0..127')
            prepared.append({'lock': lock, 'onset_index': onset_index, 'duration_index': duration_index,
                             'unpitched': unpitched, 'order': order,
                             'key': (self.vocab.floats[onset_index],) + stream_key(unpitched, lock.group, lock.pitch)
                             + (order,)})
        prepared.sort(key=lambda p: p['key'])
        return collections.deque(prepared), dropped

    @torch.inference_mode()
    def _task_bar(self, chooser, *, length, meter, tempo, groups, request_groups, density, key, chord_mode,
                  chords, style, max_notes, meter_known, reference, locks, free_notes, free_groups, free_filter,
                  lock_choice, unison):
        length = Fraction(length)
        if length <= 0:
            raise ValueError('bar length must be positive')
        allowed_groups = [GROUPS.index(g) for g in groups]
        free_set = set(allowed_groups if free_groups is None else [GROUPS.index(g) for g in free_groups])
        if not allowed_groups:
            max_notes = 0
        m, k, state = self.model, self.kernel, self.state
        plan = self._plan()
        previous = self.key
        if key is None and previous is not None:
            change = chooser.choose('key', m.key_logits(plan).reshape(-1))
            bar_key = apply_key_change(previous, change)
        elif key is None or key == 'keep':
            bar_key = previous if previous is not None else self.initial_key
        else:
            bar_key = key_id(*key)
        chosen = self._reference(chooser, plan, reference)
        bar = BarContext(self.bar_index, self.onset, length, tuple(meter), meter_known, tempo, bar_key, previous,
                         None if chosen is None else chosen[2])
        state.start_bar(bar)
        chooser.bind(state)
        tonic, _ = key_parts(bar_key)
        num, den = meter_codes(meter, meter_known)
        controls = {'ctrl_meter_num': torch.tensor([[num]]), 'ctrl_meter_den': torch.tensor([[den]]),
                    'ctrl_groups': torch.tensor([[([float(i in allowed_groups) for i in range(6)] + [1.])
                                                  if request_groups else [0.] * 7]]),
                    'ctrl_density': torch.tensor([[DENSITY_BUCKETS if density is None else int(density)]]),
                    'ctrl_cont': torch.tensor([[state.bar_continuous()]], dtype=torch.float32),
                    'ctrl_key': torch.tensor([[bar_key]]), 'ctrl_modulation': torch.tensor([[state.modulation()]]),
                    'ctrl_source': torch.tensor([[SOURCE_NONE if style is None else SOURCES.index(style)]])}
        condition = m.bar_condition(plan, controls).reshape(-1)
        pending = sorted((Fraction(o), int(r) % 12, int(q)) for o, r, q in chords if Fraction(o) < length)
        locked_chords = bool(chords)
        queue, locks_dropped = self._prepare_locks(locks, length)
        lock_identities = {p['lock'].identity for p in queue if p['lock'].identity is not None}
        has_locks = bool(queue)
        written = {}                     # (onset index, voice slot) -> pitch indices written there in this bar
        doubled = set()                  # (onset index, group, pitch): free notes at a lock's own onset and pitch
        notes, changes, placed, content = [], [], [], []
        free_written, score, lock_count, folds, proposed = 0, 0., 0, 0, 0
        pitches = {False: range(*valid_range(tonic)), True: list(range(*valid_range(tonic))) + [PITCH_UNPITCHED]}
        started = time.perf_counter()
        values = self.vocab.values
        dropped = 0
        advance_to_chord = False         # a rejected free note before a locked change: write the change next

        def reserved_slots():
            return {state.registry[i] for i in lock_identities if i in state.registry}

        def group_of(lock):
            """The lock's group if it is known before writing it (given, or the group of its voice)."""
            if lock.group is not None:
                return int(lock.group)
            if lock.identity is not None and lock.identity in state.registry:
                return int(state.slot_group[state.registry[lock.identity]])
            return None

        def write(identity, onset, index, group, slot, pitch, pitch_index, duration, velocity, dynamic, accent,
                  wedge, drum, interval, extra):
            written.setdefault((index, slot), set()).add(pitch_index)
            self.identities[slot] = identity
            encoded = state.commit_note(identity, onset, group, slot, pitch, drum, index, duration, velocity, dynamic,
                                        accent, wedge, interval)
            self.hidden = self._advance(encoded)
            position = self.vocab.value(index)
            placed.append((position, None if pitch == ABS_UNPITCHED else pitch))
            content.append((index, group, pitch_index, duration))
            notes.append({'onset': str(position), 'duration': str(self.vocab.value(duration)),
                          'group': GROUPS[group] if group < 6 else None,
                          'voice': slot, 'pitch': None if pitch == ABS_UNPITCHED else pitch, 'drum': drum,
                          'velocity': velocity, 'dynamic': DYNAMICS[dynamic - 1] if dynamic else None,
                          'accent': accent, 'wedge': WEDGES[wedge - 1] if wedge else None, **extra})

        def expression(z, pitch, lock=None):
            ex = k.expression_logits(z)
            given = lock if lock is not None else Lock(Fraction(0))
            velocity = given.velocity
            if velocity is None:
                velocity = chooser.choose('velocity', ex['velocity'], self.velocities)
            dynamic = given.dynamic if given.dynamic is not None else chooser.choose('dynamic', ex['dynamic'])
            accent = given.accent if given.accent is not None else chooser.choose('accent', ex['accent'])
            wedge = given.wedge if given.wedge is not None else chooser.choose('wedge', ex['wedge'])
            drum = None
            if pitch == ABS_UNPITCHED:
                drum = given.drum if given.drum is not None else chooser.choose('drum', ex['drum'], self.drums)
            return velocity, dynamic, accent, wedge, drum

        def emit_lock(z, look, kinds, onsets_allowed, proposal=None):
            """Write the next lock from the pre-kind state z; returns its log-probability under the model.
            proposal: the (group, voice) the model itself just proposed at this lock's onset and pitch; an open
            lock takes it (a draw from the same posterior that lock_choice='best' maximizes)."""
            nonlocal lock_count
            entry = queue.popleft()
            lock, index = entry['lock'], entry['onset_index']
            logp = _logp(k.kind(z), KIND_NOTE, kinds)
            z = k.after_kind(z, KIND_NOTE)
            onset_logits = k.onset_position(z, look)
            logp += _logp(onset_logits, index, onsets_allowed if index in onsets_allowed else None)
            position = self.vocab.value(index)
            onset = state.onset(position)
            aligned = state.ref_aligned(index)
            z = k.after_onset(z, index, onset, aligned)
            unpitched = entry['unpitched']
            group_logits = k.group(z, aligned[0])
            playable = self._playable(allowed_groups)
            if lock.group is not None:
                candidate_groups = [lock.group]
            elif lock.identity is not None and lock.identity in state.registry:
                candidate_groups = [int(state.slot_group[state.registry[lock.identity]])]
            elif proposal is not None:
                candidate_groups = [proposal[0]]
            else:
                candidate_groups = [g for g in playable if (g == PERCUSSION) == unpitched] or list(playable)
            if not candidate_groups:
                raise ValueError('no group can play this lock')
            pitch_given = unpitched or lock.pitch is not None
            options = []      # (log p, group, slot, z after voice, last pitch, pitch index, interval, z after pitch)
            for g in candidate_groups:
                lg = _logp(group_logits, g, candidate_groups) if lock.group is None and len(candidate_groups) > 1 \
                    else (_logp(group_logits, g, playable) if g in playable else 0.)
                zg = k.after_group(z, g)
                slot_features = state.slot_features(g, onset['now'])
                voice_logits = k.voice(zg, slot_features)
                if lock.identity is not None:
                    slots = [state.slot_for(lock.identity)]
                elif proposal is not None and proposal[0] == g and np.isfinite(voice_logits[proposal[1]]):
                    slots = [proposal[1]]
                else:
                    taken = reserved_slots()
                    slots = [int(s) for s in np.flatnonzero(np.isfinite(voice_logits)) if s not in taken]
                    if not slots:
                        slots = [int(s) for s in np.flatnonzero(np.isfinite(voice_logits))]
                finite = [int(s) for s in np.flatnonzero(np.isfinite(voice_logits))]
                for s in slots:
                    lv = _logp(voice_logits, s, finite) if s in finite else 0.
                    last_pitch, voice_features = state.voice_features(s, onset['now'])
                    zs = k.after_voice(zg, s, state.relative(last_pitch), state.voice_interval(s), voice_features,
                                       onset)
                    if pitch_given:
                        pitch = ABS_UNPITCHED if unpitched else int(lock.pitch)
                        pitch_index = PITCH_UNPITCHED if unpitched else state.relative(pitch)
                        pitch_logits = k.pitch(zs, g, tonic, last_pitch, onset, aligned[1])
                        lp = _logp(pitch_logits, pitch_index, pitches[g == PERCUSSION]) \
                            if pitch_index in pitches[g == PERCUSSION] else -50.
                    else:
                        pitch_index, lp, pitch = None, 0., None
                    options.append([lg + lv + lp, g, s, zs, last_pitch, pitch_index, lp])
            if len(options) == 1 or not pitch_given:
                pick = 0 if len(options) == 1 else None
            else:
                pick = None
            if pick is None:
                totals = np.array([o[0] for o in options])
                if lock_choice == 'best' and pitch_given:
                    pick = int(np.argmax(totals))
                else:
                    pick = gumbel_choice(totals, self.rng)
            total, g, s, zs, last_pitch, pitch_index, _ = options[pick]
            if not pitch_given:
                pitch_index = chooser.choose('pitch', k.pitch(zs, g, tonic, last_pitch, onset, aligned[1]),
                                             pitches[g == PERCUSSION], pitch=True)
                pitch = state.absolute(pitch_index)
            else:
                pitch = ABS_UNPITCHED if unpitched else int(lock.pitch)
            interval = state.interval(last_pitch, pitch)
            zp = k.after_pitch(zs, pitch_index, interval)
            duration_logits = k.duration(zp, aligned[2])
            if entry['duration_index'] is not None:
                duration = entry['duration_index']
                total += _logp(duration_logits, duration, self.positive)
            else:
                duration = chooser.choose('duration', duration_logits, self.positive)
            zd = k.after_duration(zp, duration)
            velocity, dynamic, accent, wedge, drum = expression(zd, pitch, lock)
            identity = lock.identity if lock.identity is not None else self.identities.get(s, ('generated', s))
            write(identity, onset, index, g, s, pitch, pitch_index, duration, velocity, dynamic, accent, wedge, drum,
                  interval, {'locked': True, 'tag': lock.tag, 'lockLogp': round(logp + total, 4)})
            lock_count += 1
            return logp + total

        while True:
            look = state.ref_lookahead()
            z = self.hidden + condition + k.lookahead(look)
            chord_onsets = state.onset_range(length, strict=state.bar_events > 0)
            if pending and not len(chord_onsets):
                dropped += len(pending)
                pending = []
            nxt = queue[0] if queue else None
            chord_first = bool(pending) and (nxt is None or pending[0][0] <= self.vocab.value(nxt['onset_index']))
            note_onsets = state.onset_range(pending[0][0] if pending else length)
            playable = self._playable(allowed_groups)
            free_playable = [g for g in playable if g in free_set]
            can_free = (free_notes and free_written < max_notes and len(note_onsets) > 0 and bool(free_playable))
            lock_due = nxt is not None and not chord_first
            if chord_mode == 'bar' and not locked_chords and state.bar_events == 0 and len(chord_onsets):
                kinds = [KIND_CHORD]
            elif pending and chord_first and (advance_to_chord or not can_free):
                kinds = [KIND_CHORD]
            else:
                kinds = [KIND_NOTE] if (can_free or lock_due) else []
                if pending or (chord_mode == 'free' and not locked_chords and len(chord_onsets)):
                    kinds.append(KIND_CHORD)
                kinds.append(KIND_END)
            kind = chooser.choose('kind', k.kind(z), kinds)
            advance_to_chord = False
            if kind == KIND_END and pending and chord_first:
                kind = KIND_CHORD                  # the bar cannot end before its locked change: advance to it
            elif kind == KIND_END and lock_due:
                folds += 1
                score += emit_lock(z, look, [KIND_NOTE, KIND_CHORD, KIND_END], note_onsets)
                continue
            elif kind == KIND_END and pending:
                kind = KIND_CHORD
            if kind == KIND_END:
                self.hidden = self._advance(state.commit_end())
                break
            if kind == KIND_CHORD:
                lock_onset = self.vocab.value(nxt['onset_index']) if lock_due else None
                if pending and not chord_first:
                    folds += 1                     # a locked change after the next lock: write the lock first
                    score += emit_lock(z, look, kinds, note_onsets)
                    continue
                zc = k.after_kind(z, kind)
                root = quality = None
                if pending:
                    offset, root, quality = pending.pop(0)
                    exact = self.vocab.index.get(offset)
                    if exact is not None and exact in chord_onsets:
                        choice = [exact]
                    else:   # not representable exactly: the nearest allowed onset at or after it
                        j = bisect.bisect_left(values, offset)
                        choice = [min(max(j, chord_onsets.start), chord_onsets.stop - 1)]
                    score += _logp(k.kind(z), KIND_CHORD, kinds)
                elif chord_mode == 'bar' and state.bar_events == 0:
                    choice = [chord_onsets.start]
                else:
                    choice = chord_onsets
                onset_logits = k.onset_position(zc, look)
                index = chooser.choose('onset', onset_logits, choice)
                if lock_onset is not None and self.vocab.value(index) > lock_onset:
                    folds += 1                     # a change after the next lock's onset: write the lock first
                    if root is not None:
                        pending.insert(0, (offset, root, quality))
                    score += emit_lock(z, look, kinds, note_onsets)
                    continue
                position = self.vocab.value(index)
                onset = state.onset(position)
                zc = k.after_onset(zc, index, onset, state.ref_aligned(index))
                root_logits = k.chord_root(zc)
                relative = chooser.choose('chord_root', root_logits, None if root is None else [(root - tonic) % 12])
                if root is not None:
                    score += _logp(root_logits, relative)
                zc = k.after_chord_root(zc, relative)
                quality_logits = k.chord_quality(zc)
                given_quality = quality
                quality = chooser.choose('chord_quality', quality_logits, None if quality is None else [quality])
                if given_quality is not None:
                    score += _logp(quality_logits, quality)
                absolute_root = (relative + tonic) % 12
                self.hidden = self._advance(state.commit_chord(absolute_root, quality, onset, index))
                changes.append({'onset': str(position), 'root': absolute_root, 'quality': quality,
                                'name': NAMES[absolute_root] + QUALITIES[quality]['suffix']})
                continue
            # ---- a note: free, or the next lock
            if lock_due and not can_free:
                score += emit_lock(z, look, kinds, note_onsets)
                continue
            zn = k.after_kind(z, KIND_NOTE)
            onset_logits = k.onset_position(zn, look)
            index = chooser.choose('onset', onset_logits, note_onsets)
            lock_index = nxt['onset_index'] if lock_due else None
            if lock_index is not None and index > lock_index:
                folds += 1
                score += emit_lock(z, look, kinds, note_onsets)
                continue
            position = self.vocab.value(index)
            onset = state.onset(position)
            aligned = state.ref_aligned(index)
            zo = k.after_onset(zn, index, onset, aligned)
            at_lock = lock_index is not None and index == lock_index
            options = free_playable
            given_group = group_of(nxt['lock']) if at_lock else None
            if given_group is not None and given_group < len(GROUPS) and given_group not in free_playable:
                options = free_playable + [given_group]     # the given part's group: "the lock comes now"
            group = chooser.choose('group', k.group(zo, aligned[0]), options)
            if group not in free_playable:
                folds += 1                         # the model picks the given part at its onset: write the lock
                score += emit_lock(z, look, kinds, note_onsets)
                continue
            zg = k.after_group(zo, group)
            voice_logits = k.voice(zg, state.slot_features(group, onset['now']))
            taken = reserved_slots()
            if taken:
                masked = voice_logits.copy()
                masked[list(taken)] = -np.inf
                if np.isfinite(masked).any():
                    voice_logits = masked
            slot = chooser.choose_voice(voice_logits, state)
            last_pitch, voice_features = state.voice_features(slot, onset['now'])
            zs = k.after_voice(zg, slot, state.relative(last_pitch), state.voice_interval(slot), voice_features, onset)
            allowed_pitches = pitches[group == PERCUSSION]
            repeated = written.get((index, slot)) if has_locks else None
            if repeated and at_lock and not nxt['unpitched'] and nxt['lock'].pitch is not None:
                repeated = repeated - {state.relative(int(nxt['lock'].pitch))}   # proposing it again: the lock
            if repeated:                           # never the same pitch twice in one voice at one onset
                allowed_pitches = [p for p in allowed_pitches if p not in repeated] or allowed_pitches
            pitch_index = chooser.choose('pitch', k.pitch(zs, group, tonic, last_pitch, onset, aligned[1]),
                                         allowed_pitches, pitch=True)
            pitch = state.absolute(pitch_index)
            if at_lock:
                lock = nxt['lock']
                mine = stream_key(pitch == ABS_UNPITCHED, group, None if pitch == ABS_UNPITCHED else pitch)
                theirs = stream_key(nxt['unpitched'], lock.group, lock.pitch)
                # the lock's own pitch at its onset: the lock itself, unless it may first be doubled (see unison)
                same_note = not nxt['unpitched'] and pitch == lock.pitch and (
                    given_group is None or unison == 'after' or (index, group, pitch) in doubled)
                if same_note or not mine < theirs:
                    folds += 1                     # at the lock's onset but not below it: write the lock now
                    proposal = (group, slot) if same_note and given_group is None else None
                    proposed += proposal is not None
                    score += emit_lock(z, look, kinds, note_onsets, proposal)
                    continue
            if free_filter is not None and not free_filter(position, group, None if pitch == ABS_UNPITCHED else pitch):
                folds += 1                         # not an allowed free note: move on to the next given event
                if lock_due:
                    score += emit_lock(z, look, kinds, note_onsets)
                    continue
                if pending:
                    advance_to_chord = True
                    continue
                self.hidden = self._advance(state.commit_end())     # nothing else may be written: end the bar
                break
            interval = state.interval(last_pitch, pitch)
            zp = k.after_pitch(zs, pitch_index, interval)
            duration = chooser.choose('duration', k.duration(zp, aligned[2]), self.positive)
            zd = k.after_duration(zp, duration)
            velocity, dynamic, accent, wedge, drum = expression(zd, pitch)
            identity = chooser.identity(slot, self.identities)
            write(identity, onset, index, group, slot, pitch, pitch_index, duration, velocity, dynamic, accent, wedge,
                  drum, interval, {})
            if at_lock and pitch == nxt['lock'].pitch:
                doubled.add((index, group, pitch))
            free_written += 1
        self.summaries.append(bar_vector(bar_summary(notes), bar_key, previous,
                                         bar_profile(placed, length, tonic), self.bar_index))
        self.plan = self.model.planner_step(torch.tensor([[self.summaries[-1]]], dtype=torch.float32), self.bar_index,
                                            self.planner_cache)
        self.bank.append((self.bar_index, self.plan.reshape(-1), Reference(content)))
        self.key = bar_key
        result = {'bar': self.bar_index, 'length': str(length), 'meter': list(meter),
                  'key': {'tonic': tonic, 'mode': bar_key // 12,
                          'name': NAMES[tonic] + (' minor' if bar_key >= 12 else ' major')},
                  'chords': changes, 'lockedChordsDropped': dropped, 'notes': notes,
                  'reference': None if chosen is None else chosen[0],
                  'resourceClosure': free_written >= max_notes,
                  'requestedDensity': density, 'actualDensity': density_bucket(len(notes)),
                  'locks': lock_count, 'locksOutsideBar': locks_dropped, 'lockScore': score, 'folds': folds,
                  'locksFromProposals': proposed,
                  'timing': {'events': len(notes) + len(changes) + 1, 'seconds': time.perf_counter() - started}}
        self.bar_index += 1
        self.onset += length
        return result


# ====================================================================== motifs and synthetic references
def _scale(mode: int) -> tuple:
    return MINOR_SCALE if mode else MAJOR_SCALE


def diatonic(pitch: int, tonic: int, mode: int) -> tuple[int, int]:
    """(scale step counted from the tonic in the octave of tonic_ref, chromatic offset 0/+1 above that step)."""
    base = tonic_ref(tonic)
    scale = _scale(mode)
    rel = pitch - base
    octave, within = divmod(rel, 12)
    step = max(i for i, s in enumerate(scale) if s <= within)
    return octave * 7 + step, within - scale[step]


def from_diatonic(step: int, offset: int, tonic: int, mode: int) -> int:
    octave, within = divmod(step, 7)
    return tonic_ref(tonic) + 12 * octave + _scale(mode)[within] + offset


def transform_motif(notes, length: Fraction, *, tonic: int, mode: int, how: str, steps: int = 0) -> list[list[dict]]:
    """Transform one bar's motif notes ({'onset','duration','pitch','group'}, pitch absolute or None) in its key.

    how: 'repeat'; 'sequence' (diatonic shift by `steps`); 'invert' (diatonic mirror around the first pitch, then
    shifted by `steps`); 'retrograde' (time reversed); 'augment' (twice as slow: two bars); 'diminish' (twice as
    fast, stated twice); 'fragment' (the first half, stated twice, the repeat shifted by `steps`).
    Returns one list of notes per bar (two for 'augment')."""
    length = Fraction(length)
    notes = sorted(notes, key=lambda n: (Fraction(n['onset']), n['pitch'] if n['pitch'] is not None else -1))

    def shift(n, delta_steps, mirror_axis=None):
        if n['pitch'] is None:
            return dict(n)
        step, offset = diatonic(int(n['pitch']), tonic, mode)
        if mirror_axis is not None:
            step = 2 * mirror_axis - step
        pitch = from_diatonic(step + delta_steps, offset, tonic, mode)
        return dict(n, pitch=max(0, min(127, pitch)))

    def timed(n, onset, duration):
        return dict(n, onset=Fraction(onset), duration=Fraction(duration))

    if how == 'repeat':
        return [[dict(n) for n in notes]]
    if how == 'sequence':
        return [[shift(n, steps) for n in notes]]
    if how == 'invert':
        pitched = [n for n in notes if n['pitch'] is not None]
        axis = diatonic(int(pitched[0]['pitch']), tonic, mode)[0] if pitched else 0
        return [[shift(n, steps, axis) for n in notes]]
    if how == 'retrograde':
        return [[timed(n, max(Fraction(0), length - Fraction(n['onset']) - Fraction(n['duration'])), n['duration'])
                 for n in notes]]
    if how == 'augment':
        bars = [[], []]
        for n in notes:
            onset, duration = 2 * Fraction(n['onset']), 2 * Fraction(n['duration'])
            if onset < length:
                bars[0].append(timed(n, onset, min(duration, length - onset)))
            else:
                bars[1].append(timed(n, onset - length, min(duration, 2 * length - onset)))
        return bars
    if how == 'diminish':
        half = length / 2
        once = [timed(n, Fraction(n['onset']) / 2, Fraction(n['duration']) / 2) for n in notes]
        return [once + [timed(n, Fraction(n['onset']) + half, n['duration']) for n in once]]
    if how == 'fragment':
        half = length / 2
        first = [timed(n, n['onset'], min(Fraction(n['duration']), half - Fraction(n['onset'])))
                 for n in notes if Fraction(n['onset']) < half]
        return [first + [shift(timed(n, Fraction(n['onset']) + half, n['duration']), steps) for n in first]]
    raise ValueError(f'unknown transformation {how!r}')


def reference_from_notes(notes, vocab, *, tonic: int, length: Fraction) -> Reference:
    """A synthetic reference bar (as the decoder reads one) from notes {'onset','duration','pitch','group'} whose
    pitches are read relative to `tonic` (the key of the bar they come from)."""
    base = tonic_ref(tonic)
    out, running = [], 0.
    for n in sorted(notes, key=lambda n: (Fraction(n['onset']), n['pitch'] if n['pitch'] is not None else -1)):
        index, _ = vocab.lookup(Fraction(n['onset']))
        if vocab.floats[index] < running:
            index = bisect.bisect_left(vocab.floats, running)
        if index >= len(vocab) or vocab.value(index) >= length:
            continue
        running = vocab.floats[index]
        duration, _ = vocab.lookup(Fraction(n['duration']), positive=True)
        group = n['group'] if n['group'] is not None else UNKNOWN_GROUP
        pitch = PITCH_UNPITCHED if n['pitch'] is None else int(n['pitch']) - base + REL_OFFSET
        out.append((index, group, pitch, duration))
    return Reference(out)


DEVELOPMENT_PLAN = (('repeat', 0), ('sequence', 1), ('fragment', -1), ('free', 0),
                    ('invert', 0), ('sequence', -1), ('diminish', 0), ('free', 0))


def development_plan(bars: int) -> list[tuple[str, int]]:
    """The default motif development for `bars` bars: restate, sequence up a step, fragment, free bar on the motif;
    then inversion, sequence down, diminution, free (repeating). An 'augment' would need two bars and is only
    used on request."""
    return [DEVELOPMENT_PLAN[i % len(DEVELOPMENT_PLAN)] for i in range(bars)]
