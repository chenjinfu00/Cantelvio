#!/usr/bin/env python3
"""Four-pillar v3.1 streaming generation.

One backbone step per committed event (note, chord change or bar end) with a
ring-buffer cache; the bar plan is computed once per bar from completed bar
summaries; attributes are sampled in the trained order with the same
StreamState features as training. Every bar has a key (given, kept, or chosen
by the model's key head); pitches and chord roots are sampled relative to it
and decoded exactly: sounding pitch = tonic_ref + index - offset, so the note
that plays is the note the model chose, never folded or replaced.

Chord modes: 'free' (the model writes chord changes), 'hold' (no changes),
'bar' (a change at every downbeat, chosen by the model) or given chords
(locked changes at given onsets). Groups and density are learned conditions;
the group switches are also hard masks. Temperature only changes which pitch
is chosen, never whether an event happens.

Reference bars: before each bar the pointer chooses one of the last 511
completed bars for the new bar to restate (or none); reference='auto' samples
it, an integer names a bar, None disables it. The decoder then reads the
reference exactly as in training (StreamState.ref_lookahead / ref_aligned).

Generation runs on `Kernel`, an inference-only view of the trained weights that
performs the same arithmetic as the training modules without per-module call
overhead (one stacked input-embedding lookup, LayerNorm affines folded into the
expression heads, pitch priors precomputed per tonic). Attributes are drawn by
Gumbel-max from a seeded NumPy generator, which samples exactly from softmax.

This is a diagnostic generator and future console core, not evidence of musical
quality. Output keeps exact fractions, sounding pitches and explicit drum keys.
"""
from __future__ import annotations

import argparse
import bisect
import collections
import hashlib
import json
import math
import time
from fractions import Fraction
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

from four_pillar_codec import DYNAMICS, GROUPS, WEDGES
from four_pillar_v31_data import (BarContext, Reference, StreamState, bar_profile, bar_vector, density_bucket,
                                  meter_codes)
from four_pillar_v31_model import (ABS_UNPITCHED, DENSITY_BUCKETS, KIND_CHORD, KIND_END, KIND_NOTE, PITCH_UNPITCHED,
                                   SOURCE_NONE, SOURCES, FourPillarV31, apply_rope, circulant, rope_tables)
from four_pillar_v31_time import DEFAULT_VOCAB, TimeVocabulary
from four_pillar_v31_tonal import (QUALITIES, REL_OFFSET, REL_PITCHES, apply_key_change, key_id, key_parts,
                                   tonic_ref, valid_relative_range)

EXPRESSION = ('velocity', 'dynamic', 'accent', 'wedge', 'drum')
INPUTS = ('in_kind', 'in_group', 'in_pitch', 'in_degree', 'in_register', 'in_drum', 'in_voice', 'in_interval',
          'in_delta', 'in_position', 'in_duration', 'in_velocity', 'in_dynamic', 'in_accent', 'in_wedge', 'in_beat',
          'in_level', 'in_key', 'in_chord_root', 'in_chord_quality', 'in_chord_degree')
CHORD_MODES = ('free', 'hold', 'bar')
NAMES = ('C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B')


def bar_summary(notes: list[dict]) -> list[float]:
    """Same 20 values as four_pillar_trial_data.summarize_bars for one bar (absolute pitch classes)."""
    row = [0.] * 20
    pitched = [n['pitch'] for n in notes if n['pitch'] is not None]
    for p in pitched:
        row[p % 12] += 1
        row[19] += p / 127
    grouped = [n['group'] for n in notes if n['group'] in GROUPS]
    for g in grouped:
        row[12 + GROUPS.index(g)] += 1
    if pitched:
        row[:12] = [x / len(pitched) for x in row[:12]]
        row[19] /= len(pitched)
    if grouped:
        row[12:18] = [x / len(grouped) for x in row[12:18]]
    row[18] = math.log1p(len(notes)) / math.log(129)
    return row


class Kernel:
    """Inference-only fused view of FourPillarV31 weights (CPU, no autograd).

    Every method mirrors one model method used in training; tests compare both
    paths. Rebuild the kernel if the model's weights change.
    """

    @torch.no_grad()
    def __init__(self, model: FourPillarV31):
        m, c = model, model.config
        self.model, self.width, self.heads = m, c['width'], c['heads']
        self.dim = self.width // self.heads
        d = lambda t: t.detach().clone()  # noqa: E731
        ln = lambda n: (d(n.weight), d(n.bias), n.eps)  # noqa: E731
        lin = lambda n: (d(n.weight), d(n.bias))  # noqa: E731
        modules = (m.kind_in, m.group_in, m.pitch_in, m.degree_in, m.register_in, m.drum_in, m.voice_in,
                   m.interval_in, m.delta_in, m.position_in, m.duration_in, m.velocity_in, m.dynamic_in, m.accent_in,
                   m.wedge_in, m.beat_in, m.level_in, m.key_in, m.chord_root_in, m.chord_quality_in, m.chord_degree_in)
        self.input_offsets = np.cumsum([0] + [e.num_embeddings for e in modules[:-1]]).astype(np.int64)
        self.input_table = torch.cat([d(e.weight) for e in modules])
        self.continuous_in, self.input_norm = lin(m.continuous_in), ln(m.input_norm)
        self.blocks = [(ln(b.norm), lin(b.attention.qkv), lin(b.attention.out), ln(b.ffnorm), lin(b.ff[0]), lin(b.ff[2]))
                       for b in m.blocks]
        self.final_norm = ln(m.norm)
        self.emb = {name: d(getattr(m, name).weight) for name in (
            'kind_in', 'group_in', 'pitch_in', 'voice_in', 'interval_in', 'position_in', 'duration_in', 'beat_in',
            'level_in', 'chord_root_in', 'chord_quality_in', 'ref_next_in', 'ref_remain_in', 'ref_group_in',
            'ref_pitch_in', 'ref_duration_in')}
        self.ref_pcs = lin(m.ref_pcs)
        self.copy, self.copy_pitch = d(m.copy).tolist(), d(m.copy_pitch).tolist()
        self.steps = {name: (ln(s.norm), lin(s.up), lin(s.down)) for name, s in m.steps.items()}
        self.head = {name: (ln(h.norm), lin(h.linear)) for name, h in m.heads.items()}
        self.onset_continuous, self.voice_state = lin(m.onset_continuous), lin(m.voice_state)
        self.harmony_state = lin(m.harmony_state)
        self.slot_bias = (lin(m.slot_bias[0]), lin(m.slot_bias[2]))
        # LayerNorm(z) = n(z) * g + b, so W @ LayerNorm(z) + c = (W * g) @ n(z) + (W @ b + c).
        eps = {m.heads[name].norm.eps for name in EXPRESSION}
        if len(eps) != 1:
            raise ValueError('expression heads need one LayerNorm epsilon to fuse')
        weights, biases, self.expression_sizes = [], [], []
        for name in EXPRESSION:
            h = m.heads[name]
            weights.append(h.linear.weight * h.norm.weight[None, :])
            biases.append(h.linear.weight @ h.norm.bias + h.linear.bias)
            self.expression_sizes.append(h.linear.out_features)
        self.expression = (torch.cat(weights).detach(), torch.cat(biases).detach(), eps.pop())
        # Pitch priors. Degree of relative class i is (i - offset) mod 12 for every tonic.
        index = torch.arange(REL_PITCHES)
        self.degree = (index - REL_OFFSET) % 12
        last = torch.arange(130)[:, None]
        bias = torch.cat((d(m.interval_bias), torch.zeros(7, 1)), 1)     # entry 50: no previous pitch
        steps = []
        for tonic in range(12):
            absolute = index[None, :] - REL_OFFSET + tonic_ref(tonic)
            step = absolute - last.clamp(max=127)
            interval = torch.where(step.abs() <= 24, step + 24, torch.full_like(step, 49))
            steps.append(torch.where(last < 128, interval, torch.full_like(interval, 50)))
        steps = torch.stack(steps)                                        # [12 tonics, 130 last pitches, 139]
        self.interval_tables = torch.stack([bias[g][steps] for g in range(7)])   # [7 groups, 12, 130, 139]
        kernels = torch.cat([circulant(d(k)) for k in (m.sounding_kernel, m.bass_kernel, m.chord_kernel)])
        self.pitch_class_matrix = kernels[:, self.degree].contiguous()    # [36, 139]
        self.scale = d(m.scale_bias)[:, self.degree]                     # [2 modes, 139]
        self.chord_gather = torch.stack([(self.degree - root) % 12 for root in range(12)])   # [12 roots, 139]
        self.valid = {t: valid_relative_range(t) for t in range(12)}
        self.octave = torch.stack([(index - REL_OFFSET + tonic_ref(t)).clamp(0, 127) // 12 for t in range(12)])

    # ---------------------------------------------------------------- building blocks
    def _norm(self, x, params):
        return F.layer_norm(x, (self.width,), params[0], params[1], params[2])

    def _step(self, name, z):
        norm, up, down = self.steps[name]
        return z + F.linear(F.gelu(F.linear(self._norm(z, norm), *up)), *down)

    def _head(self, name, z):
        norm, linear = self.head[name]
        return F.linear(self._norm(z, norm), *linear)

    # ---------------------------------------------------------------- backbone
    def embed(self, encoded: dict) -> torch.Tensor:
        index = torch.from_numpy(np.fromiter((encoded[n] for n in INPUTS), np.int64, len(INPUTS)) + self.input_offsets)
        x = F.embedding(index, self.input_table).sum(0)
        x = x + F.linear(torch.tensor(encoded['in_cont'], dtype=torch.float32), *self.continuous_in)
        return self._norm(x, self.input_norm)

    def rope(self, index: int, encoded: dict) -> tuple:
        return rope_tables(self.dim, torch.tensor([index]), torch.tensor([encoded['rope_time']], dtype=torch.float64),
                           torch.tensor([encoded['rope_beat']], dtype=torch.float64),
                           torch.tensor([encoded['rope_bar']], dtype=torch.float64), 'cpu', torch.float32)

    def backbone_step(self, x: torch.Tensor, rope: tuple, cache: list[dict]) -> torch.Tensor:
        for (norm, qkv, out, ffnorm, up, down), layer in zip(self.blocks, cache):
            qkv_x = F.linear(self._norm(x, norm), *qkv).view(3, 1, self.heads, 1, self.dim)
            q, k = apply_rope(qkv_x[:2], rope).unbind(0)   # one rotary call for queries and keys
            v = qkv_x[2]
            slot = layer['count'] % layer['k'].shape[2]
            layer['k'][:, :, slot] = k[:, :, 0]
            layer['v'][:, :, slot] = v[:, :, 0]
            layer['count'] += 1
            used = min(layer['count'], layer['k'].shape[2])
            y = F.scaled_dot_product_attention(q, layer['k'][:, :, :used], layer['v'][:, :, :used])
            x = x + F.linear(y.reshape(self.width), *out)
            x = x + F.linear(F.gelu(F.linear(self._norm(x, ffnorm), *up)), *down)
        return self._norm(x, self.final_norm)

    # ---------------------------------------------------------------- attribute decoder (model order)
    def lookahead(self, look) -> torch.Tensor:
        """look = StreamState.ref_lookahead(): (next reference onset, stay onset, notes left class)."""
        return self.emb['ref_next_in'][look[0]] + self.emb['ref_remain_in'][look[2]]

    @staticmethod
    def _copy(logits, index, weight):
        if index < logits.shape[-1]:
            logits[index] += weight
        return logits

    def kind(self, z):
        return self._head('kind', z)

    def after_kind(self, z, kind):
        return self._step('kind', z + self.emb['kind_in'][kind])

    def onset_position(self, z, look):
        logits = self._head('onset', z)
        return self._copy(self._copy(logits, look[0], self.copy[0]), look[1], self.copy[1])

    def after_onset(self, z, position, onset, aligned):
        """aligned = StreamState.ref_aligned(position): reference group, pitch, duration and degrees here."""
        cont = F.linear(torch.tensor(onset['cont'], dtype=torch.float32), *self.onset_continuous)
        e = self.emb
        ref = (e['ref_group_in'][aligned[0]] + e['ref_pitch_in'][aligned[1]] + e['ref_duration_in'][aligned[2]]
               + F.linear(torch.tensor(aligned[3], dtype=torch.float32), *self.ref_pcs))
        return self._step('onset', z + e['position_in'][position] + e['beat_in'][onset['beat']]
                          + e['level_in'][onset['level']] + cont + ref)

    def chord_root(self, z):
        return self._head('chord_root', z)

    def after_chord_root(self, z, root):
        return self._step('chord_root', z + self.emb['chord_root_in'][root])

    def chord_quality(self, z):
        return self._head('chord_quality', z)

    def group(self, z, ref_group: int):
        return self._copy(self._head('group', z), ref_group, self.copy[2])

    def after_group(self, z, group):
        return self._step('group', z + self.emb['group_in'][group])

    def voice(self, z, slot_features: np.ndarray) -> np.ndarray:
        """Voice logits with forbidden slots at -inf (existing slots of another group)."""
        first, second = self.slot_bias
        bias = F.linear(F.gelu(F.linear(torch.from_numpy(slot_features), *first)), *second).squeeze(-1)
        logits = (self._head('voice', z) + bias).numpy()
        allowed = ((slot_features[:, 0] > .5) & (slot_features[:, 2] > .5)) | (slot_features[:, 1] > .5)
        return np.where(allowed, logits, -np.inf)

    def after_voice(self, z, slot, last_relative, previous_interval, voice_features, onset):
        e = self.emb
        z = (z + e['voice_in'][slot] + e['pitch_in'][last_relative] + e['interval_in'][previous_interval]
             + F.linear(torch.tensor(voice_features, dtype=torch.float32), *self.voice_state)
             + F.linear(torch.tensor(onset['harm'], dtype=torch.float32), *self.harmony_state)
             + e['chord_root_in'][onset['chord_root']] + e['chord_quality_in'][onset['chord_quality']])
        return self._step('voice', z)

    def pitch(self, z, group: int, tonic: int, last_pitch: int, onset, ref_pitch: int) -> torch.Tensor:
        """[140] logits; classes outside the sounding range are -inf (the model masks them in training too)."""
        bass = [0.] * 12
        if onset['bass'] < 12:
            bass[onset['bass']] = 1.
        context = torch.tensor(onset['pcs'] + bass + onset['chord_tones'], dtype=torch.float32)
        prior = (self.interval_tables[group, tonic, last_pitch] + context @ self.pitch_class_matrix
                 + self.scale[onset['mode']] + self._head('degree', z)[self.degree]
                 + self._head('register', z)[self.octave[tonic]])
        if onset['chord_root'] < 12:
            relative = self._head('chord_rel', z)
            prior = prior + relative[self.chord_gather[onset['chord_root']]]
        logits = self._copy(self._head('pitch', z), ref_pitch, self.copy_pitch[group])
        pitched = logits[:REL_PITCHES] + prior
        valid = self.valid[tonic]
        pitched[:valid.start] = -math.inf
        pitched[valid.stop:] = -math.inf
        return torch.cat((pitched, logits[REL_PITCHES:]))

    def after_pitch(self, z, pitch, interval):
        return self._step('pitch', z + self.emb['pitch_in'][pitch] + self.emb['interval_in'][interval])

    def duration(self, z, ref_duration: int):
        return self._copy(self._head('duration', z), ref_duration, self.copy[3])

    def after_duration(self, z, duration):
        return self._step('duration', z + self.emb['duration_in'][duration])

    def expression_logits(self, z) -> dict:
        weight, bias, eps = self.expression
        out = F.linear(F.layer_norm(z, (self.width,), None, None, eps), weight, bias)
        return dict(zip(EXPRESSION, out.split(self.expression_sizes)))


def gumbel_choice(logits, rng: np.random.Generator, allowed=None, temperature: float = 1., top_p: float = 1.) -> int:
    """Exact draw from softmax(logits / temperature) over `allowed` (None, a range or a list); with top_p < 1,
    from the smallest most-likely set whose probability reaches top_p (nucleus), renormalized."""
    x = np.asarray(logits, dtype=np.float64)
    if temperature != 1.:
        x = x / temperature
    offset = 0
    if isinstance(allowed, range) and allowed.step == 1:
        x, offset = x[allowed.start:allowed.stop], allowed.start
    elif allowed is not None:
        masked = np.full_like(x, -np.inf)
        masked[allowed] = x[allowed]
        x = masked
    if not len(x) or not np.isfinite(x).any():
        raise ValueError('every choice is masked')
    if top_p < 1.:
        order = np.argsort(-x)
        p = np.exp(x[order] - x[order[0]])
        p /= p.sum()
        keep = order[:int(np.searchsorted(np.cumsum(p), top_p) + 1)]
        nucleus = np.full_like(x, -np.inf)
        nucleus[keep] = x[keep]
        x = nucleus
    return offset + int(np.argmax(x + rng.gumbel(size=x.shape)))


class Composer:
    def __init__(self, model: FourPillarV31, vocab: TimeVocabulary, seed: int = 0, key: tuple[int, int] = (0, 0)):
        """key: (tonic 0..11, mode 0 major / 1 minor) of the first bar unless a bar asks otherwise."""
        self.model, self.vocab = model.eval(), vocab
        self.kernel = Kernel(model)
        self.rng = np.random.Generator(np.random.PCG64(seed))
        self.state = StreamState(vocab, model.config)
        self.cache = model.new_cache()
        self.position = 0
        self.summaries: list[list[float]] = []
        self.planner_cache = model.new_planner_cache()
        with torch.inference_mode():
            self.plan = model.plan_norm(model.plan_empty)[None, None]     # no completed bar yet
        # (bar index, planner state after the bar, Reference) of the bars a new bar may restate
        self.bank: collections.deque = collections.deque(maxlen=model.config['history_bars'] - 1)
        self.identities: dict[int, tuple] = {}
        self.bar_index = 0
        self.onset = Fraction(0)
        self.initial_key = key_id(*key)
        self.key: int | None = None
        self.positive = range(1, len(vocab))
        self.velocities, self.drums = range(1, 128), range(35, 82)
        self.hidden = self._advance(self.state.start_input())

    @torch.inference_mode()
    def _advance(self, encoded: dict) -> torch.Tensor:
        hidden = self.kernel.backbone_step(self.kernel.embed(encoded), self.kernel.rope(self.position, encoded),
                                           self.cache)
        self.position += 1
        return hidden

    def _plan(self) -> torch.Tensor:
        return self.plan

    def _playable(self, allowed_groups: list[int]) -> list[int]:
        """Allowed groups that still have a voice: once all voice slots exist, only their groups can play."""
        if len(self.state.registry) < self.model.config['voices']:
            return allowed_groups
        return [g for g in allowed_groups if (self.state.slot_group == g).any()]

    def next_bar(self, *, length=Fraction(4), meter=(4, 4), tempo: float | None = 92., groups=GROUPS,
                 request_groups: bool = False, density: int | None = None, key='keep', chord_mode: str = 'free',
                 chords=(), style: str | None = None, max_notes: int = 128, temperature: float = 1.,
                 top_p: float = 1., meter_known: bool = True, reference='auto') -> dict:
        """Generate one bar.

        key: (tonic, mode) for this bar, 'keep' (previous key, or the composer's first key) or None (the
        model's key head chooses, relative to the previous key). chord_mode: 'free', 'hold' or 'bar';
        chords: ((offset, absolute root 0..11, quality index), ...) locks the bar's chord changes instead.
        groups: allowed six-group ids (hard mask); request_groups also tells the model which groups to write
        for; density: requested bucket 0..7 or None; style: one of SOURCES (corpus style) or None.
        reference: 'auto' (the pointer chooses an earlier bar to restate, or none), an earlier bar index, or None.
        Temperature and top_p (nucleus) apply to pitch only; whether and when events happen is never truncated."""
        if not temperature > 0:
            raise ValueError('temperature must be positive')
        if not 0 < top_p <= 1:
            raise ValueError('top_p must be in (0, 1]')
        if chord_mode not in CHORD_MODES:
            raise ValueError('chord_mode must be free, hold or bar')
        if style is not None and style not in SOURCES:
            raise ValueError('style must be one of ' + ', '.join(SOURCES))
        return self._bar(Sampler(self.rng, temperature, top_p), length=length, meter=meter, tempo=tempo, groups=groups,
                         request_groups=request_groups, density=density, key=key, chord_mode=chord_mode,
                         chords=chords, style=style, max_notes=max_notes, meter_known=meter_known, reference=reference)

    def feed_bar(self, events: list[dict], *, length=Fraction(4), meter=(4, 4), tempo: float | None = 92.,
                 groups=GROUPS, request_groups: bool = False, density: int | None = None, key='keep',
                 style: str | None = None, meter_known: bool = True, record: list | None = None,
                 reference=None) -> dict:
        """Commit given events (a prompt or a locked prefix) through exactly the generation path.

        events: {'kind': 'chord', 'onset', 'root' (absolute pitch class), 'quality'} or {'kind': 'note',
        'onset', 'group', 'identity', 'pitch' (absolute MIDI, 128 = unpitched), 'duration', 'velocity',
        'dynamic', 'accent', 'wedge', 'drum'}; onsets (positions in the bar) and durations are vocabulary
        indices. `record` receives the logits at every step."""
        notes = sum(1 for e in events if e['kind'] == 'note')
        return self._bar(Feeder(events, record), length=length, meter=meter, tempo=tempo, groups=groups,
                         request_groups=request_groups, density=density, key=key, chord_mode='free', chords=(),
                         style=style, max_notes=notes + 1, meter_known=meter_known, reference=reference)

    def _reference(self, chooser, plan, reference):
        """Pointer logits over the bank (logged for parity checks) and the chosen bank entry or None."""
        pointer = None
        if self.bank:
            keys = torch.stack([entry[1] for entry in self.bank])[None]
            distance = torch.tensor([[[self.bar_index - entry[0] for entry in self.bank]]])
            pointer = self.model.ref_logits(plan.reshape(1, 1, -1), keys, distance).reshape(-1)
            chooser.log('bar_ref', pointer)
        if reference == 'auto':
            pick = 0 if pointer is None else gumbel_choice(pointer.numpy(), self.rng)
            return None if pick == 0 else self.bank[pick - 1]
        if reference is None:
            return None
        if isinstance(reference, bool) or not isinstance(reference, int):
            raise ValueError("reference must be 'auto', None or an earlier bar index")
        for entry in self.bank:
            if entry[0] == reference:
                return entry
        raise ValueError('the reference must be one of the last completed bars')

    @torch.inference_mode()
    def _bar(self, chooser, *, length, meter, tempo, groups, request_groups, density, key, chord_mode, chords,
             style, max_notes, meter_known, reference):
        length = Fraction(length)
        if length <= 0:
            raise ValueError('bar length must be positive')
        allowed_groups = [GROUPS.index(g) for g in groups]
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
        locked = bool(chords)
        notes, changes, placed, content, position = [], [], [], [], Fraction(0)
        pitches = {False: range(*valid_range(tonic)), True: list(range(*valid_range(tonic))) + [PITCH_UNPITCHED]}
        started = time.perf_counter()
        values = self.vocab.values
        dropped = 0
        while True:
            look = state.ref_lookahead()
            z = self.hidden + condition + k.lookahead(look)
            chord_onsets = state.onset_range(length, strict=state.bar_events > 0)
            if pending and not len(chord_onsets):
                dropped += len(pending)        # no onset left in this bar for the locked change
                pending = []
            note_onsets = state.onset_range(pending[0][0] if pending else length)   # before a locked change
            playable = self._playable(allowed_groups)
            can_note = len(notes) < max_notes and len(note_onsets) > 0 and bool(playable)
            if chord_mode == 'bar' and not locked and state.bar_events == 0 and len(chord_onsets):
                kinds = [KIND_CHORD]
            elif pending and not can_note:
                kinds = [KIND_CHORD]
            else:
                kinds = [KIND_NOTE] if can_note else []
                if pending or (chord_mode == 'free' and not locked and len(chord_onsets)):
                    kinds.append(KIND_CHORD)
                kinds.append(KIND_END)
            kind = chooser.choose('kind', k.kind(z), kinds)
            if kind == KIND_END and pending:
                kind = KIND_CHORD                  # the bar cannot end before its locked change: advance to it
            if kind == KIND_END:
                self.hidden = self._advance(state.commit_end())
                break
            z = k.after_kind(z, kind)
            if kind == KIND_CHORD:
                root = quality = None
                if pending:
                    offset, root, quality = pending.pop(0)
                    exact = self.vocab.index.get(offset)
                    if exact is not None and exact in chord_onsets:
                        choice = [exact]
                    else:   # not representable exactly: the nearest allowed onset at or after it
                        j = bisect.bisect_left(values, offset)
                        choice = [min(max(j, chord_onsets.start), chord_onsets.stop - 1)]
                elif chord_mode == 'bar' and state.bar_events == 0:
                    choice = [chord_onsets.start]
                else:
                    choice = chord_onsets
                index = chooser.choose('onset', k.onset_position(z, look), choice)
                position = self.vocab.value(index)
                onset = state.onset(position)
                z = k.after_onset(z, index, onset, state.ref_aligned(index))
                relative = chooser.choose('chord_root', k.chord_root(z),
                                          None if root is None else [(root - tonic) % 12])
                z = k.after_chord_root(z, relative)
                quality = chooser.choose('chord_quality', k.chord_quality(z), None if quality is None else [quality])
                absolute_root = (relative + tonic) % 12
                self.hidden = self._advance(state.commit_chord(absolute_root, quality, onset, index))
                changes.append({'onset': str(position), 'root': absolute_root, 'quality': quality,
                                'name': NAMES[absolute_root] + QUALITIES[quality]['suffix']})
                continue
            index = chooser.choose('onset', k.onset_position(z, look), note_onsets)
            position = self.vocab.value(index)
            onset = state.onset(position)
            aligned = state.ref_aligned(index)
            z = k.after_onset(z, index, onset, aligned)
            group = chooser.choose('group', k.group(z, aligned[0]), playable)
            z = k.after_group(z, group)
            slot = chooser.choose_voice(k.voice(z, state.slot_features(group, onset['now'])), state)
            last_pitch, voice_features = state.voice_features(slot, onset['now'])
            z = k.after_voice(z, slot, state.relative(last_pitch), state.voice_interval(slot), voice_features, onset)
            pitch_index = chooser.choose('pitch', k.pitch(z, group, tonic, last_pitch, onset, aligned[1]),
                                         pitches[group == GROUPS.index('percussion')], pitch=True)
            pitch = state.absolute(pitch_index)              # exact: tonic_ref + index - offset
            interval = state.interval(last_pitch, pitch)
            z = k.after_pitch(z, pitch_index, interval)
            duration = chooser.choose('duration', k.duration(z, aligned[2]), self.positive)
            z = k.after_duration(z, duration)
            expression = k.expression_logits(z)
            velocity = chooser.choose('velocity', expression['velocity'], self.velocities)
            dynamic = chooser.choose('dynamic', expression['dynamic'])
            accent = chooser.choose('accent', expression['accent'])
            wedge = chooser.choose('wedge', expression['wedge'])
            drum = chooser.choose('drum', expression['drum'], self.drums) if pitch == ABS_UNPITCHED else None
            identity = chooser.identity(slot, self.identities)
            self.identities[slot] = identity
            encoded = state.commit_note(identity, onset, group, slot, pitch, drum, index, duration, velocity,
                                        dynamic, accent, wedge, interval)
            self.hidden = self._advance(encoded)
            placed.append((position, None if pitch == ABS_UNPITCHED else pitch))
            content.append((index, group, pitch_index, duration))
            notes.append({'onset': str(position), 'duration': str(self.vocab.value(duration)),
                          'group': GROUPS[group] if group < 6 else None,
                          'voice': slot, 'pitch': None if pitch == ABS_UNPITCHED else pitch, 'drum': drum,
                          'velocity': velocity, 'dynamic': DYNAMICS[dynamic - 1] if dynamic else None,
                          'accent': accent, 'wedge': WEDGES[wedge - 1] if wedge else None})
        self.summaries.append(bar_vector(bar_summary(notes), bar_key, previous,
                                         bar_profile(placed, length, tonic), self.bar_index))
        self.plan = self.model.planner_step(torch.tensor([[self.summaries[-1]]], dtype=torch.float32), self.bar_index,
                                            self.planner_cache)      # one cached planner step per bar
        self.bank.append((self.bar_index, self.plan.reshape(-1), Reference(content)))
        self.key = bar_key
        result = {'bar': self.bar_index, 'length': str(length), 'meter': list(meter),
                  'key': {'tonic': tonic, 'mode': bar_key // 12, 'name': NAMES[tonic] + (' minor' if bar_key >= 12 else ' major')},
                  'chords': changes, 'lockedChordsDropped': dropped, 'notes': notes,
                  'reference': None if chosen is None else chosen[0],
                  'resourceClosure': len(notes) >= max_notes,
                  'requestedDensity': density, 'actualDensity': density_bucket(len(notes)),
                  'timing': {'events': len(notes) + len(changes) + 1, 'seconds': time.perf_counter() - started}}
        self.bar_index += 1
        self.onset += length
        return result


def valid_range(tonic: int) -> tuple[int, int]:
    r = valid_relative_range(tonic)
    return r.start, r.stop


class Sampler:
    """Draws every attribute from the model; temperature and top_p only affect pitch."""

    def __init__(self, rng: np.random.Generator, temperature: float, top_p: float = 1.):
        self.rng, self.temperature, self.top_p = rng, temperature, top_p

    def choose(self, name, logits, allowed=None, pitch=False):
        if allowed is not None and len(allowed) == 1:
            return allowed[0]
        if pitch:
            return gumbel_choice(logits.numpy(), self.rng, allowed, self.temperature, self.top_p)
        return gumbel_choice(logits.numpy(), self.rng, allowed)

    def choose_voice(self, logits, state):
        return gumbel_choice(logits, self.rng)

    def log(self, name, logits):
        pass

    def identity(self, slot, identities):
        return identities.get(slot, ('generated', slot))

    def bind(self, state):
        pass


class Feeder:
    """Returns given event attributes in the generation order; optionally records logits."""

    def __init__(self, events, record=None):
        self.events, self.record, self.index, self.state = list(events), record, 0, None

    def _event(self):
        return self.events[self.index]

    def _log(self, name, logits):
        if self.record is not None:
            values = logits if isinstance(logits, np.ndarray) else logits.numpy()
            self.record.append((self.index, name, torch.from_numpy(np.array(values, dtype=np.float32).reshape(-1))))

    def log(self, name, logits):
        self._log(name, logits)

    def choose(self, name, logits, allowed=None, pitch=False):
        self._log(name, logits)
        if name == 'kind':
            if self.index >= len(self.events):
                return KIND_END
            return KIND_CHORD if self._event()['kind'] == 'chord' else KIND_NOTE
        event = self._event()
        if name == 'chord_root':
            return (event['root'] - self.tonic) % 12
        if name == 'chord_quality':
            self.index += 1               # a chord event is complete after its quality
            return event['quality']
        if name == 'pitch':
            value = event['pitch'] - self.tonic_ref + REL_OFFSET if event['pitch'] < 128 else PITCH_UNPITCHED
        else:
            value = event[name]
        if name == 'group' and value == 6:
            return value   # given material may come from a part outside the six groups (e.g. a voice)
        if name in ('onset', 'group', 'pitch', 'duration') and allowed is not None and value not in allowed:
            raise ValueError(f'given {name} {value} is not allowed here')
        return value

    def choose_voice(self, logits, state):
        self._log('voice', logits)
        self.tonic, self.tonic_ref = state.tonic, state.tonic_ref
        return state.slot_for(self._event()['identity'])

    def identity(self, slot, identities):
        identity = self._event()['identity']
        self.index += 1
        return identity

    def bind(self, state):
        self.tonic, self.tonic_ref = state.tonic, state.tonic_ref


def load(checkpoint: Path, vocab_path: Path = DEFAULT_VOCAB) -> tuple[FourPillarV31, TimeVocabulary, dict]:
    weights = torch.load(checkpoint, map_location='cpu', weights_only=False)
    if weights.get('schema') != 'four-pillar-v31-weights-1':
        raise ValueError('requires v3.1 weights.pt, never a v2/v3 checkpoint')
    vocab = TimeVocabulary.load(vocab_path)
    if weights['vocabSha256'] != hashlib.sha256(Path(vocab_path).read_bytes()).hexdigest():
        raise ValueError('time vocabulary differs from the one this checkpoint was trained with')
    model = FourPillarV31(weights['architecture'])
    model.load_state_dict(weights['model'], strict=True)
    return model, vocab, weights


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--bars', type=int, default=8)
    parser.add_argument('--seed', type=int, default=41977)
    parser.add_argument('--key', default='C', help='tonic name of the first bar, e.g. C, F#, Bb; add m for minor (Am)')
    parser.add_argument('--model-keys', action='store_true', help='let the key head choose later keys')
    parser.add_argument('--chord-mode', choices=CHORD_MODES, default='free')
    parser.add_argument('--style', choices=SOURCES, help='corpus style (default: unspecified)')
    parser.add_argument('--groups', default=','.join(GROUPS))
    parser.add_argument('--request-groups', action='store_true')
    parser.add_argument('--density', type=int)
    parser.add_argument('--tempo', type=float, default=92.)
    parser.add_argument('--temperature', type=float, default=1.)
    parser.add_argument('--top-p', type=float, default=1., help='nucleus for pitch only (1 = exact sampling)')
    parser.add_argument('--references', choices=('auto', 'none'), default='auto',
                        help='auto: the pointer may restate an earlier bar; none: never')
    parser.add_argument('--threads', type=int, default=1)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.bars <= 256:
        parser.error('bars must be 1..256')
    if args.density is not None and not 0 <= args.density < DENSITY_BUCKETS:
        parser.error(f'density must be 0..{DENSITY_BUCKETS - 1}')
    groups = [g for g in args.groups.split(',') if g]
    if any(g not in GROUPS for g in groups):
        parser.error('groups must be among ' + ','.join(GROUPS))
    name = args.key[:-1] if args.key.endswith('m') else args.key
    spelled = {'Db': 'C#', 'D#': 'Eb', 'Gb': 'F#', 'G#': 'Ab', 'A#': 'Bb'}.get(name, name)
    if spelled not in NAMES:
        parser.error('unknown key ' + args.key)
    torch.set_num_threads(args.threads)
    model, vocab, weights = load(args.checkpoint)
    composer = Composer(model, vocab, args.seed, key=(NAMES.index(spelled), int(args.key.endswith('m'))))
    bars = [composer.next_bar(groups=groups, request_groups=args.request_groups, density=args.density,
                              tempo=args.tempo, temperature=args.temperature, top_p=args.top_p, chord_mode=args.chord_mode,
                              style=args.style, reference='auto' if args.references == 'auto' else None,
                              key=None if args.model_keys and i else 'keep') for i in range(args.bars)]
    args.output.write_text(json.dumps({'schema': 'v31-event-audition-2', 'step': weights['step'],
                                       'qualityValidated': False, 'bars': bars}, indent=1))
    seconds = [b['timing']['seconds'] for b in bars]
    print(json.dumps({'bars': len(bars), 'notes': sum(len(b['notes']) for b in bars),
                      'chords': sum(len(b['chords']) for b in bars), 'maxBarSeconds': round(max(seconds), 3),
                      'references': [b['reference'] for b in bars],
                      'output': str(args.output)}))


if __name__ == '__main__':
    main()
