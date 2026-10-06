"""Four-pillar v2: causal sounding state, ordered material and stable expression.

The event vocabulary and legacy transplant remain compatible; this revision's
new timeline projection requires its own versioned v2 training checkpoint.
"""
from __future__ import annotations

import torch
import math
from torch import nn

from four_pillar_v1_model import FourPillarComposerV1
from four_pillar_v1_objective import composition_objective


class FourPillarExpressiveV2(FourPillarComposerV1):
    def __init__(self, **kwargs):
        kwargs.setdefault("history_bars", 512)
        super().__init__(**kwargs)
        width = self.score.config['width']
        self.phrase_strength_head = nn.Linear(width, 2)  # mean and spread of source MIDI velocity
        self.tempo_level_head = nn.Linear(width, 1)       # absolute log-QPM per planned bar
        self.timeline_input = nn.Linear(24, width)
        # New continuous heads should not start with random tiny variances.
        # This is an initialization prior, never a replacement for missing labels.
        for head, bias in ((self.numeric_dynamic, (0.75, 0.0)),
                           (self.midi_velocity, (0.65, -0.7)),
                           (self.tempo_head, (-2.0, 0.0, -1.0)),
                           (self.tempo_level_head, (math.log(100.0),)),
                           (self.phrase_strength_head, (0.65, 0.15))):
            nn.init.zeros_(head.weight)
            with torch.no_grad():
                head.bias.copy_(torch.tensor(bias))

    def _motifs(self, tokens, known, batch_size, device):
        # Ordered motifs: pooling bare token embeddings erased order completely.
        if tokens is None and known is None:
            return super()._motifs(tokens, known, batch_size, device)
        if (tokens is None or known is None or tokens.ndim != 3
                or tokens.shape != known.shape or tokens.shape[0] != batch_size
                or tokens.shape[1] > 8 or known.dtype != torch.bool):
            raise ValueError('invalid ordered motif memory')
        b, k, length = tokens.shape
        if not k:
            return super()._motifs(None, None, batch_size, device)
        if length > self.score.config['context']:
            raise ValueError('motif exceeds context')
        safe = tokens.masked_fill(~known, 0)
        embedded = self.score.token(safe).reshape(b * k, length, -1)
        mask = known.reshape(b * k, length)
        positions = torch.arange(1, length + 1, device=device)
        embedded = (embedded + self.score.token_position(positions)[None]) * mask[..., None]
        sentinel = self.score.material_sentinel.expand(b * k, -1, -1)
        encoded = self.score.material_encoder(torch.cat((sentinel, embedded), dim=1),
            src_key_padding_mask=torch.cat((torch.zeros(b * k, 1, dtype=torch.bool,
                                                        device=device), ~mask), dim=1))
        exists = known.any(dim=2)
        memory = self.motif_norm(self.motif_projection(encoded[:, 0])).reshape(b, k, -1)
        return memory * exists[..., None], exists

    def forward(self, timeline=None, **kwargs) -> dict:
        if timeline is not None:
            if (timeline.shape != (*kwargs['decoder_input'].shape, 24)
                    or not torch.isfinite(timeline).all()):
                raise ValueError('invalid causal timeline features')
            kwargs['causal_additions'] = self.timeline_input(timeline)
        material, known = kwargs['material'], kwargs['material_known']
        if material.shape[1]:
            # Supplied notes must inform phrase planning as well as the local
            # decoder. Unknown material is masked before embedding.
            length = material.shape[1]
            positions = torch.arange(1, length+1, device=material.device)
            embedded = (self.score.token(material.masked_fill(~known, 0))
                        + self.score.token_position(positions)[None]) * known[..., None]
            sentinel = self.score.material_sentinel.expand(material.shape[0], -1, -1)
            hidden = self.score.material_encoder(torch.cat((sentinel, embedded), dim=1),
                src_key_padding_mask=torch.cat((torch.zeros(material.shape[0],1,dtype=torch.bool,
                                                            device=material.device),~known),dim=1))
            kwargs['planner_additions'] = hidden[:,0] * known.any(dim=1)[:,None]
        output = super().forward(**kwargs)
        for name in ('numeric_dynamic', 'midi_velocity'):
            mean, scale = output[name].unbind(-1)
            output[name] = torch.stack((mean, scale.clamp(-4, 2)), -1)
        tempo = output['tempo']
        output['tempo'] = torch.stack((tempo[..., 0], tempo[..., 1],
                                      tempo[..., 2].clamp(-4, 1)), -1)
        plan = output['plan']
        output['phrase_strength'] = self.phrase_strength_head(plan)
        output['tempo_level'] = self.tempo_level_head(plan).squeeze(-1)
        return output


def expressive_objective(outputs: dict, targets: dict):
    # Raw motif shift is measured in semitones; conservative provisional
    # weights prevent a rare octave move from dwarfing event supervision.
    base, report = composition_objective(outputs, targets, weights={
        'motif_recall': 0.10, 'motif_pitch_shift': 0.01,
        'motif_log_duration': 0.03, 'key_direction': 0.10})
    total = base
    for name, weight in (('phrase_strength', 0.10), ('tempo_level', 0.05)):
        value, known = targets.get(name), targets.get(name + '_known')
        if value is None and known is None:
            continue
        prediction = outputs[name]
        if (value is None or known is None or value.shape != prediction.shape
                or known.shape != prediction.shape or known.dtype != torch.bool):
            raise ValueError(name + ' needs matching value and source-known mask')
        if value.device != prediction.device or known.device != prediction.device:
            raise ValueError(name + ' is on the wrong device')
        count = int(known.sum())
        loss = (prediction - value.masked_fill(~known, 0).float()).square()
        mean = loss.masked_fill(~known, 0).sum() / max(count, 1)
        if count:
            total = total + weight * mean
        report[name] = {'loss': float(mean.detach()), 'known': count}
    if not torch.isfinite(total):
        raise FloatingPointError('nonfinite expressive objective')
    return total, report
