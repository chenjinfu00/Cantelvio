"""Untrained integrated four-pillar composer architecture (not a browser runtime).

Harmony is an explicit chord-conditioned stream and a frozen, exact copy of the
continued R/H/B/M prior when a genuinely aligned *past* window is supplied.
Counterpoint is the causal event decoder plus an unbounded voice-registry
pointer. Form has four-bar plans and motif memory. Orchestration chooses group
and role before pitch, subject to hard resource masks. None of these heads has
been trained or evaluated for musical quality in this architecture.
"""
from __future__ import annotations

import math
from fractions import Fraction
from pathlib import Path
from typing import Sequence

import torch
from torch import nn

from four_pillar_codec import GROUPS, ROLES
from four_pillar_legacy_init import SOURCE, initialize_from_legacy
from four_pillar_trial_model import FourPillarTrial, PLAN_BARS
from four_pillar_v1_codec import V1_VOCAB_SIZE, VOICE_CHOICE
from joint_data import STREAMS, T_MAX, UNK
from joint_model import StructuredJoint

TASKS = ('free', 'given_melody', 'given_chords', 'given_motif')
INTENTS = ('unspecified', 'etude', 'nocturne')
VOICE_FEATURES = len(GROUPS) + len(ROLES) + 2  # group, role, sounding range
LEGACY_STEP_KEYS = ('R', 'H', 'B', 'M', 'pos', 'meter', 'level', 'phrase',
                    'lkey', 'beatphase', 'chord', 'since', 'change', 'barlen', 'beatlen')
LEGACY_GLOBAL_KEYS = ('domain', 'style', 'refmode')


class FourPillarComposerV1(nn.Module):
    """Complete forward interface for all four composition pillars, not a trained generator.

    `history` is committed bars only. `material` and `chords` are explicitly
    supplied future conditions. `legacy_window`, if present, is a genuinely
    aligned old-format *past* window, never synthesized from the target score.
    `voice_features` describes a dynamic per-sample registry; N may grow without
    a model-imposed maximum. Score serialization and hard-lock merge live in
    separate v1 contract modules.
    """

    def __init__(self, *, source: Path = SOURCE, width: int = 192, heads: int = 6,
                 planner_layers: int = 3, decoder_layers: int = 4,
                 history_bars: int = 32, context: int = 2048,
                 legacy_transfer: dict | None = None):
        super().__init__()
        source = Path(source)
        self.score = FourPillarTrial(width=width, heads=heads,
                                     planner_layers=planner_layers,
                                     decoder_layers=decoder_layers,
                                     history_bars=history_bars, context=context,
                                     vocab_size=V1_VOCAB_SIZE)
        # A full v2 checkpoint already contains the frozen prior. Its manifest
        # supplies architecture/provenance without reading historical weights.
        self.transfer = (initialize_from_legacy(self.score, source)
                         if legacy_transfer is None else dict(legacy_transfer))
        old_config = self.transfer['sourceConfig']
        self.legacy = StructuredJoint(**{k: v for k, v in old_config.items() if k != 'kind'})
        if legacy_transfer is None:
            checkpoint = torch.load(source, map_location='cpu', weights_only=True)
            self.legacy.load_state_dict(checkpoint['state_dict'], strict=True)
        self.legacy.requires_grad_(False)
        self.legacy.eval()
        self.task = nn.Embedding(len(TASKS), width)
        self.intent = nn.Embedding(len(INTENTS), width)
        self.tempo_input = nn.Linear(2, width)
        self.chord_root = nn.Embedding(12, width)
        self.chord_quality = nn.Embedding(40, width)
        self.chord_bar = nn.Embedding(PLAN_BARS, width)
        self.chord_offset = nn.Linear(2, width)
        self.chord_norm = nn.LayerNorm(width)
        self.motif_norm = nn.LayerNorm(width)
        self.motif_projection = nn.Linear(width, width)
        self.memory_motif_query = nn.Linear(width, width)
        self.no_memory_motif = nn.Linear(width, 1)
        self.motif_transform = nn.Linear(width, 2)  # semitone shift, log-duration ratio
        self.legacy_projection = nn.Sequential(nn.LayerNorm(self.legacy.d),
                                               nn.Linear(self.legacy.d, width))
        self.legacy_stream = nn.Parameter(torch.randn(len(STREAMS), width) * 0.02)
        self.legacy_gate = nn.Parameter(torch.tensor(-2.2))  # sigmoid ≈ 0.10
        self.condition_norm = nn.LayerNorm(width)
        self.form_density = nn.Linear(width, 1)
        self.form_register = nn.Linear(width, 2)
        self.form_texture = nn.Linear(width, 4)
        self.group_activity = nn.Linear(width, len(GROUPS))
        self.key_direction = nn.Linear(width, 13)  # 12 pitch-class shifts + hold
        self.harmony_root = nn.Linear(width, 12)
        self.harmony_quality = nn.Linear(width, 40)
        self.tempo_head = nn.Linear(width, 3)  # change logit, delta-log-QPM mean, log-scale
        self.voice_key = nn.Linear(VOICE_FEATURES, width)
        self.voice_query = nn.Linear(width, width)
        self.new_voice = nn.Linear(width, 1)
        self.new_voice_feedback = nn.Parameter(torch.randn(width) * 0.02)
        self.numeric_dynamic = nn.Linear(width, 2)  # MusicXML numeric dynamics; separately masked
        self.midi_velocity = nn.Linear(width, 2)  # MIDI source only; separately masked

    def train(self, mode: bool = True):
        super().train(mode)
        self.legacy.eval()  # frozen teacher dropout must never alter the prior
        return self

    def _past_legacy(self, window: dict[str, torch.Tensor] | None,
                     visible_steps: torch.Tensor | None,
                     legacy_end_qn: Sequence[Fraction] | None,
                     target_start_qn: Sequence[Fraction] | None,
                     batch_size: int, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
        width = self.score.config['width']
        if window is None:
            if any(x is not None for x in (visible_steps, legacy_end_qn, target_start_qn)):
                raise ValueError('legacy visibility supplied without a legacy window')
            return torch.zeros(batch_size, len(STREAMS), width, device=device), torch.zeros(
                batch_size, len(STREAMS), dtype=torch.bool, device=device)
        if any(x is None for x in (visible_steps, legacy_end_qn, target_start_qn)):
            raise ValueError('legacy prior requires visible steps and past/target time bounds')
        if (visible_steps.shape != (batch_size,) or visible_steps.dtype != torch.long
                or (visible_steps < 1).any() or (visible_steps > T_MAX).any()
                or len(legacy_end_qn) != batch_size
                or len(target_start_qn) != batch_size
                or any(Fraction(end) > Fraction(start)
                       for end, start in zip(legacy_end_qn, target_start_qn))):
            raise ValueError('legacy window is not a verified past-only prefix')
        if any(key not in window for key in LEGACY_STEP_KEYS + LEGACY_GLOBAL_KEYS):
            raise ValueError('legacy window lacks old-model fields')
        safe = {}
        after = torch.arange(T_MAX, device=device)[None] >= visible_steps[:, None]
        final = visible_steps[:, None] - 1
        for key in LEGACY_STEP_KEYS:
            value = window[key]
            if value.shape != (batch_size, T_MAX) or value.device != device:
                raise ValueError(f'invalid legacy window field {key}')
            if key in STREAMS:
                safe[key] = value.masked_fill(after, UNK)
            else:
                last = value.gather(1, final)
                safe[key] = torch.where(after, last.expand_as(value), value)
        for key in LEGACY_GLOBAL_KEYS:
            value = window[key]
            if value.shape != (batch_size,) or value.device != device:
                raise ValueError(f'invalid legacy global field {key}')
            safe[key] = value
        with torch.no_grad():
            _, hidden = self.legacy(safe, return_features=True)
            past = hidden[torch.arange(batch_size, device=device), visible_steps - 1]
        # Preserve R/H/B/M as four separately addressable memories. Averaging
        # them here would discard the source model's stream identities.
        transferred = self.legacy_projection(past) + self.legacy_stream[None]
        return torch.sigmoid(self.legacy_gate) * transferred, torch.ones(
            batch_size, len(STREAMS), dtype=torch.bool, device=device)

    def _chords(self, chords: dict[str, torch.Tensor] | None,
                batch_size: int, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
        width = self.score.config['width']
        if chords is None:
            return torch.zeros(batch_size, 0, width, device=device), torch.zeros(
                batch_size, 0, dtype=torch.bool, device=device)
        if any(key not in chords for key in ('root', 'quality', 'bar', 'known', 'hard_lock',
                                             'offset_num', 'offset_den')):
            raise ValueError('chord material needs root, quality, bar, exact offset and masks')
        root, quality, bar = (chords[k] for k in ('root', 'quality', 'bar'))
        numerator, denominator = chords['offset_num'], chords['offset_den']
        known, hard = chords['known'], chords['hard_lock']
        if (root.ndim != 2 or root.shape[0] != batch_size
                or any(x.shape != root.shape for x in (quality, bar, numerator, denominator,
                                                       known, hard))
                or known.dtype != torch.bool or hard.dtype != torch.bool
                or (hard & ~known).any()):
            raise ValueError('invalid chord material shape or hard-lock mask')
        if known.any() and (((root[known] < 0) | (root[known] >= 12)).any()
                            or ((quality[known] < 0) | (quality[known] >= 40)).any()
                            or ((bar[known] < 0) | (bar[known] >= PLAN_BARS)).any()
                            or (numerator[known] < 0).any() or (denominator[known] <= 0).any()):
            raise ValueError('known chord outside vocabulary or four-bar plan')
        roots = root.masked_fill(~known, 0)
        qualities = quality.masked_fill(~known, 0)
        bars = bar.masked_fill(~known, 0)
        offsets = torch.stack((numerator.masked_fill(~known, 0).float().log1p(),
                               denominator.masked_fill(~known, 1).float().log1p()), dim=-1)
        encoded = self.chord_norm(self.chord_root(roots) + self.chord_quality(qualities)
                                  + self.chord_bar(bars) + self.chord_offset(offsets)) * known[..., None]
        return encoded, known

    def _motifs(self, tokens: torch.Tensor | None, known: torch.Tensor | None,
                batch_size: int, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
        width = self.score.config['width']
        if tokens is None and known is None:
            return torch.zeros(batch_size, 0, width, device=device), torch.zeros(
                batch_size, 0, dtype=torch.bool, device=device)
        if (tokens is None or known is None or tokens.ndim != 3 or tokens.shape != known.shape
                or tokens.shape[0] != batch_size or tokens.shape[1] > 8
                or known.dtype != torch.bool):
            raise ValueError('motif memory needs up to eight masked event fragments')
        if known.any() and ((tokens[known] < 0).any() or (tokens[known] >= V1_VOCAB_SIZE).any()):
            raise ValueError('known motif token outside event vocabulary')
        safe = tokens.masked_fill(~known, 0)
        embedded = self.score.token(safe) * known[..., None]
        pooled = embedded.sum(dim=2) / known.sum(dim=2).clamp(min=1)[..., None]
        exists = known.any(dim=2)
        return self.motif_norm(self.motif_projection(pooled)) * exists[..., None], exists

    def forward(self, *, history: torch.Tensor, history_known: torch.Tensor,
                decoder_input: torch.Tensor, material: torch.Tensor,
                material_known: torch.Tensor, task_id: torch.Tensor,
                intent_id: torch.Tensor, voice_features: torch.Tensor,
                voice_known: torch.Tensor, voice_pointer_input: torch.Tensor,
                chords: dict[str, torch.Tensor] | None = None,
                motif_tokens: torch.Tensor | None = None,
                motif_known: torch.Tensor | None = None,
                log_qpm: torch.Tensor | None = None,
                tempo_known: torch.Tensor | None = None,
                allowed_groups: torch.Tensor | None = None,
                allowed_roles: torch.Tensor | None = None,
                allowed_pitches: torch.Tensor | None = None,
                locked_tokens: torch.Tensor | None = None,
                locked_mask: torch.Tensor | None = None,
                voice_allowed: torch.Tensor | None = None,
                allow_new_voice: torch.Tensor | None = None,
                causal_additions: torch.Tensor | None = None,
                planner_additions: torch.Tensor | None = None,
                legacy_window: dict[str, torch.Tensor] | None = None,
                legacy_visible_steps: torch.Tensor | None = None,
                legacy_end_qn: Sequence[Fraction] | None = None,
                target_start_qn: Sequence[Fraction] | None = None) -> dict:
        batch_size = history.shape[0]
        device = history.device
        length = decoder_input.shape[1]
        if (task_id.shape != (batch_size,) or intent_id.shape != (batch_size,)
                or task_id.dtype != torch.long or intent_id.dtype != torch.long
                or (task_id < 0).any() or (task_id >= len(TASKS)).any()
                or (intent_id < 0).any() or (intent_id >= len(INTENTS)).any()):
            raise ValueError('invalid task or intent IDs')
        if voice_features.ndim == 3:
            if (voice_features.shape[0] != batch_size
                    or voice_features.shape[2] != VOICE_FEATURES
                    or voice_known.shape != voice_features.shape[:2]):
                raise ValueError('static voice registry shape mismatch')
            voice_features = voice_features[:, None].expand(-1, length, -1, -1)
            voice_known = voice_known[:, None].expand(-1, length, -1)
        if (voice_features.ndim != 4 or voice_features.shape[:2] != (batch_size, length)
                or voice_features.shape[-1] != VOICE_FEATURES
                or voice_known.shape != voice_features.shape[:3]
                or voice_known.dtype != torch.bool):
            raise ValueError('dynamic voice registry shape mismatch')
        N = voice_features.shape[2]
        counts = voice_known.long().sum(dim=-1)
        if N and not torch.equal(voice_known, torch.arange(N, device=device)[None, None] < counts[..., None]):
            raise ValueError('known voices must be a contiguous causal registry prefix')
        if (voice_pointer_input.shape != (batch_size, length)
                or voice_pointer_input.dtype != torch.long):
            raise ValueError('voice pointer feedback must match decoder tokens')
        has_choice = decoder_input == VOICE_CHOICE
        if (torch.any(has_choice != (voice_pointer_input >= 0))
                or (voice_pointer_input[has_choice] > counts[has_choice]).any()):
            raise ValueError('voice pointer feedback must follow a known VOICE_CHOICE')
        # Registry positions are score-local identities, not a capped voice
        # vocabulary. Distinct voices may share every group/role/range field.
        # A deterministic positional code keeps their pointer keys distinct
        # without imposing a maximum number of voices.
        dimensions = torch.arange(0, self.score.config['width'], 2, device=device)
        frequencies = torch.exp(-math.log(10000.0) * dimensions / self.score.config['width'])
        phases = torch.arange(N, device=device)[:, None] * frequencies[None]
        identities = torch.zeros(N, self.score.config['width'], device=device)
        identities[:, 0::2], identities[:, 1::2] = phases.sin(), phases.cos()
        keys = self.voice_key(voice_features) + identities[None, None]
        if N:
            selected = keys.gather(2, voice_pointer_input.clamp(min=0, max=N - 1)[
                ..., None, None].expand(-1, -1, 1, keys.shape[-1])).squeeze(2)
        else:
            selected = torch.zeros(batch_size, length, keys.shape[-1], device=device)
        feedback = torch.where((voice_pointer_input == counts)[..., None],
                               self.new_voice_feedback[None, None], selected)
        feedback = feedback * has_choice[..., None]
        if causal_additions is not None:
            if causal_additions.shape != feedback.shape:
                raise ValueError('causal additions must match decoder hidden shape')
            feedback = feedback + causal_additions
        legacy, legacy_known = self._past_legacy(
            legacy_window, legacy_visible_steps, legacy_end_qn,
            target_start_qn, batch_size, device)
        chord_memory, chord_known = self._chords(chords, batch_size, device)
        motif_memory, motif_exists = self._motifs(motif_tokens, motif_known,
                                                   batch_size, device)
        if log_qpm is None and tempo_known is None:
            tempo_condition = torch.zeros(batch_size, self.score.config['width'], device=device)
        else:
            if (log_qpm is None or tempo_known is None
                    or log_qpm.shape != (batch_size,) or tempo_known.shape != (batch_size,)
                    or tempo_known.dtype != torch.bool
                    or (tempo_known & ~torch.isfinite(log_qpm)).any()):
                raise ValueError('tempo needs known log-QPM and source mask')
            tempo_condition = self.tempo_input(torch.stack((
                log_qpm.masked_fill(~tempo_known, 0), tempo_known.float()), dim=-1))
            tempo_condition = tempo_condition * tempo_known[:, None]
        condition = self.task(task_id) + self.intent(intent_id) + tempo_condition
        if planner_additions is not None:
            if planner_additions.shape != condition.shape:
                raise ValueError('planner additions must match condition shape')
            condition = condition + planner_additions
        condition = condition + legacy.mean(dim=1) * legacy_known[:, 0, None]
        if chord_memory.shape[1]:
            condition = condition + chord_memory.sum(dim=1) / chord_known.sum(dim=1).clamp(min=1)[:, None]
        if motif_memory.shape[1]:
            condition = condition + motif_memory.sum(dim=1) / motif_exists.sum(dim=1).clamp(min=1)[:, None]
        memory = torch.cat((legacy, chord_memory, motif_memory), dim=1)
        memory_known = torch.cat((legacy_known, chord_known, motif_exists), dim=1)
        core = self.score(history=history, history_known=history_known,
                          decoder_input=decoder_input, material=material,
                          material_known=material_known, allowed_groups=allowed_groups,
                          allowed_roles=allowed_roles, allowed_pitches=allowed_pitches,
                          locked_tokens=locked_tokens, locked_mask=locked_mask,
                          planner_context=self.condition_norm(condition),
                          extra_memory=memory, extra_memory_known=memory_known,
                          token_additions=feedback)
        plan, event = core['plan'], core['event_hidden']
        memory_motif_logits = torch.cat((self.no_memory_motif(plan),
            torch.einsum('bpd,bkd->bpk', self.memory_motif_query(plan), motif_memory)
            / math.sqrt(plan.shape[-1])), dim=-1)
        if motif_memory.shape[1]:
            memory_motif_logits[..., 1:] = memory_motif_logits[..., 1:].masked_fill(
                ~motif_exists[:, None], torch.finfo(memory_motif_logits.dtype).min)
        query = self.voice_query(event)
        pointers = torch.einsum('bld,blnd->bln', query, keys) / math.sqrt(query.shape[-1])
        available = voice_known
        if allowed_groups is not None and N:
            group_specified = voice_features[..., :len(GROUPS)].sum(dim=-1) > 0
            group_index = voice_features[..., :len(GROUPS)].argmax(dim=-1)
            grouped = allowed_groups[:, None].expand(-1, length, -1).gather(2, group_index)
            available = available & (~group_specified | grouped)
        if voice_allowed is not None:
            if voice_allowed.shape == (batch_size, N):
                voice_allowed = voice_allowed[:, None].expand(-1, length, -1)
            if voice_allowed.shape != voice_known.shape or voice_allowed.dtype != torch.bool:
                raise ValueError('voice allowed mask mismatch')
            available = available & voice_allowed
        pointers = pointers.masked_fill(~available, torch.finfo(pointers.dtype).min)
        new_pointer = self.new_voice(event)
        if allow_new_voice is not None:
            if allow_new_voice.shape != new_pointer.shape[:2] or allow_new_voice.dtype != torch.bool:
                raise ValueError('new-voice resource mask mismatch')
            new_pointer = new_pointer.masked_fill(~allow_new_voice[..., None],
                                                  torch.finfo(new_pointer.dtype).min)
        if allow_new_voice is not None and (~available.any(dim=-1) & ~allow_new_voice).any():
            raise ValueError('no permitted existing or new voice for an event')
        voice_logits = torch.full((batch_size, length, N + 1),
                                  torch.finfo(query.dtype).min, device=device)
        voice_logits[..., :N] = pointers
        voice_logits.scatter_(2, counts[..., None], new_pointer)
        root_logits = self.harmony_root(plan)
        quality_logits = self.harmony_quality(plan)
        locked_chords = None
        if chords is not None:
            hard = chords['hard_lock']
            # The planner has one anchor chord per bar; exact additional
            # within-bar changes remain in the immutable supplied sidecar.
            locked_chords = {key: value.clone() for key, value in chords.items()}
            for sample in range(batch_size):
                for bar_index in range(PLAN_BARS):
                    first = ((chords['bar'][sample] == bar_index) & hard[sample]
                             & (chords['offset_num'][sample] == 0)).nonzero()
                    if first.numel():
                        slot = int(first[0, 0])
                        root_logits[sample, bar_index] = torch.finfo(root_logits.dtype).min
                        quality_logits[sample, bar_index] = torch.finfo(quality_logits.dtype).min
                        root_logits[sample, bar_index, chords['root'][sample, slot]] = 0
                        quality_logits[sample, bar_index, chords['quality'][sample, slot]] = 0
        return {
            **core,
            'voice_pointer': voice_logits,
            'form_density': self.form_density(plan),
            'form_register': self.form_register(plan),
            'form_texture': self.form_texture(plan),
            'motif_recall': memory_motif_logits,
            'motif_transform': self.motif_transform(plan),
            'group_activity': self.group_activity(plan),
            'key_direction': self.key_direction(plan),
            'harmony_root': root_logits,
            'harmony_quality': quality_logits,
            'tempo': self.tempo_head(plan),
            'numeric_dynamic': self.numeric_dynamic(event),
            'midi_velocity': self.midi_velocity(event),
            'legacy_prior_known': legacy_known[:, 0],
            'chord_condition_known': chord_known,
            'motif_condition_known': motif_exists,
            'locked_chords': locked_chords,
        }

    def parameter_counts(self) -> dict[str, int]:
        return {'total': sum(p.numel() for p in self.parameters()),
                'trainable': sum(p.numel() for p in self.parameters() if p.requires_grad),
                'frozen_legacy': sum(p.numel() for p in self.legacy.parameters())}
