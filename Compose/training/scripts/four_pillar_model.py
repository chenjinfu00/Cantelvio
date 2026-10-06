"""Training-side four-pillar bootstrap; not a browser model or a trained composer.

The deployed R/H/B/M decoder is retained without changing its parameter names.
New modules are deliberately untrained. A zero-initialized residual gate makes the
initial joint logits identical to the source checkpoint, even with known user
material or a proposed phrase plan. Future training may open those gates.
"""
from __future__ import annotations

import torch
from torch import nn

from joint_data import T_MAX, VOCAB
from joint_model import StructuredJoint

EXTRA_ROLES = ('countermelody', 'inner_voice')
FORM_EVENTS = ('continue', 'phrase_end', 'section_end', 'theme_return')
GROUPS = ('woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings')
NO_GROUP = len(GROUPS)


class KnownMaterialEncoder(nn.Module):
    """Bidirectional access to *explicitly supplied* H/M, never generated targets.

Unknown positions are masked before embedding. Full future visibility is valid
only for material furnished by the user; a training loader must not pass the
complete reference melody or harmony as if it had been supplied.
    """

    def __init__(self, d: int, T: int):
        super().__init__()
        self.T = T
        self.harmony = nn.Embedding(VOCAB['H'], d)
        self.melody = nn.Embedding(VOCAB['M'], d)
        self.position = nn.Embedding(T, d)
        self.known_harmony = nn.Parameter(torch.randn(d) * 0.02)
        self.known_melody = nn.Parameter(torch.randn(d) * 0.02)
        layer = nn.TransformerEncoderLayer(d, 4, d * 2, dropout=0.1,
                                           batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(layer, 2, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d)

    def forward(self, material: dict[str, torch.Tensor]) -> torch.Tensor:
        required = ('H', 'M', 'known_H', 'known_M')
        if any(key not in material for key in required):
            raise ValueError(f'material needs {required}')
        H, M = material['H'], material['M']
        known_h, known_m = material['known_H'], material['known_M']
        if H.shape != M.shape or H.shape != known_h.shape or H.shape != known_m.shape:
            raise ValueError('material tokens and known masks must have matching [batch, steps] shapes')
        if (H.ndim != 2 or H.shape[1] > self.T or H.dtype != torch.long or M.dtype != torch.long
                or known_h.dtype != torch.bool or known_m.dtype != torch.bool):
            raise ValueError('invalid material length, token dtype or known-mask dtype')
        if H.device != self.position.weight.device or any(x.device != H.device for x in (M, known_h, known_m)):
            raise ValueError('material tensors must be on the model device')
        if (H[known_h] < 0).any() or (H[known_h] >= VOCAB['H']).any():
            raise ValueError('known harmony token out of range')
        if (M[known_m] < 0).any() or (M[known_m] >= VOCAB['M']).any():
            raise ValueError('known melody token out of range')
        h = self.harmony(H.masked_fill(~known_h, 0)) * known_h.unsqueeze(-1)
        m = self.melody(M.masked_fill(~known_m, 0)) * known_m.unsqueeze(-1)
        x = h + m + known_h.unsqueeze(-1) * self.known_harmony + known_m.unsqueeze(-1) * self.known_melody
        x = x + self.position(torch.arange(H.shape[1], device=H.device))[None]
        encoded = self.norm(self.encoder(x))
        # Nothing was supplied: do not manufacture a condition from positions.
        any_known = (known_h | known_m).any(dim=1)
        return encoded * any_known[:, None, None]


class FourPillarFoundation(nn.Module):
    """Checkpoint-compatible backbone plus trainable, currently untrained extensions.

    This is a *foundation for subsequent training*, not a complete free-running
    decoder for the four new abilities. An optional supplied phrase context is
    [batch, steps, d]; the causal form memory proposes only future changes.
    """

    def __init__(self, *, base_config: dict | None = None, expression_sizes: dict | None = None):
        super().__init__()
        base_config = dict(base_config or {})
        self.base = StructuredJoint(**{k: v for k, v in base_config.items() if k != 'kind'})
        d, T = self.base.d, self.base.T
        sizes = dict(expression_sizes or {'sub': 34, 'dur': 111, 'ratio': 26, 'dynamic': 16})
        if not all(isinstance(sizes.get(k), int) and sizes[k] > 0 for k in ('sub', 'dur', 'ratio', 'dynamic')):
            raise ValueError('expression vocabulary sizes are required')
        self.expression_sizes = sizes

        self.material = KnownMaterialEncoder(d, T)
        self.material_gate = nn.Parameter(torch.zeros(()))
        self.plan_gate = nn.Parameter(torch.zeros(()))
        self.plan_projection = nn.Linear(d, d)

        # Causal across steps; its final state can be carried to the next window.
        self.form_memory = nn.GRU(d, d, batch_first=True)
        self.form_head = nn.Linear(d, len(FORM_EVENTS))

        # Two additional independent voice slots, not copies of the existing M.
        self.role = nn.Embedding(len(EXTRA_ROLES), d)
        self.group_hint = nn.Linear(len(GROUPS), d, bias=False)
        self.voice_norm = nn.LayerNorm(d)
        self.voice_heads = nn.ModuleDict({
            'pitch': nn.Linear(d, 130),  # MIDI 0..127, rest, hold
            'sub': nn.Linear(d, sizes['sub']),
            'dur': nn.Linear(d, sizes['dur']),
            'ratio': nn.Linear(d, sizes['ratio']),
            'dynamic': nn.Linear(d, sizes['dynamic']),
        })
        # Instrument identity and silence are separate from musical role.
        self.group_head = nn.Linear(d, len(GROUPS) + 1)
        # Hold/change logit, delta-log-QPM mean and log-scale; not trained yet.
        self.tempo_head = nn.Linear(d, 3)

    def forward(self, batch: dict[str, torch.Tensor], *,
                material: dict[str, torch.Tensor] | None = None,
                phrase_context: torch.Tensor | None = None,
                allowed_groups: torch.Tensor | None = None,
                form_state: torch.Tensor | None = None) -> dict:
        B, T = batch['H'].shape
        if T != self.base.T:
            raise ValueError(f'backbone expects {self.base.T} steps, got {T}')
        extra = None
        if material is not None:
            supplied = self.material(material)
            if supplied.shape[:2] != (B, T):
                raise ValueError('material length must match the backbone window')
            extra = torch.tanh(self.material_gate) * supplied
        if phrase_context is not None:
            if phrase_context.shape != (B, T, self.base.d):
                raise ValueError('phrase context must have [batch, steps, d] shape')
            planned = torch.tanh(self.plan_gate) * self.plan_projection(phrase_context)
            extra = planned if extra is None else extra + planned

        joint, hidden = self.base(batch, extra_step=extra, return_features=True)
        summary = hidden.mean(dim=2)
        form, next_form_state = self.form_memory(summary, form_state)

        if allowed_groups is not None:
            if allowed_groups.shape != (B, T, len(GROUPS)) or allowed_groups.dtype != torch.bool:
                raise ValueError('allowed groups must be boolean [batch, steps, six groups]')
            if allowed_groups.device != summary.device:
                raise ValueError('allowed groups must be on the model device')
            hint = self.group_hint(allowed_groups.to(summary.dtype))
        else:
            hint = 0
        voice_input = hidden[:, :, 3, None, :] + self.role.weight[None, None]
        if allowed_groups is not None:
            voice_input = voice_input + hint[:, :, None, :]
        voice = self.voice_norm(voice_input)
        group_logits = self.group_head(voice)
        if allowed_groups is not None:
            allowed = torch.cat([allowed_groups, torch.ones(B, T, 1, dtype=torch.bool, device=summary.device)], dim=-1)
            group_logits = group_logits.masked_fill(~allowed[:, :, None, :], torch.finfo(group_logits.dtype).min)
        return {
            'joint': joint,
            'form': self.form_head(form),
            'form_state': next_form_state,
            'voices': {key: head(voice) for key, head in self.voice_heads.items()},
            'groups': group_logits,
            'tempo': self.tempo_head(form),
        }
