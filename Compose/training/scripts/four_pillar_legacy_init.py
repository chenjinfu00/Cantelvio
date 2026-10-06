"""Auditable partial initialization of the score trial from the continued R/H/B/M model.

This is weight transplantation, not an R/H/B/M-to-score aligned teacher. Old
H and M self-attention/FFN branches seed the corresponding half-head channels
of the score decoder; old harmonic vectors seed the past-bar summary input.
The new event vocabulary, cross attention and form planner remain new weights.
"""
from __future__ import annotations

from pathlib import Path

import torch

from four_pillar_split import digest
from four_pillar_trial_model import FourPillarTrial
from joint_model import StructuredJoint

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'runs/joint-continued-expression-v1/best-base.pt'


def initialize_from_legacy(model: FourPillarTrial, source: Path = SOURCE) -> dict:
    checkpoint = torch.load(source, map_location='cpu', weights_only=True)
    config = checkpoint.get('config')
    if not isinstance(config, dict) or config.get('kind') != 'structured':
        raise ValueError('source is not a continued StructuredJoint checkpoint')
    if 'state_dict' not in checkpoint or 'step' not in checkpoint:
        raise ValueError('legacy checkpoint lacks weights or source step')
    with torch.random.fork_rng(devices=[]):
        old = StructuredJoint(**{k: v for k, v in config.items() if k != 'kind'})
    old.load_state_dict(checkpoint['state_dict'], strict=True)
    width, heads = model.config['width'], model.config['heads']
    d, old_heads = old.d, config['heads']
    if (width != 2 * d or heads != old_heads or
            len(model.decoder.layers) < len(old.layers)):
        raise ValueError('legacy warm start needs width=2*old_d, matching heads and enough decoder layers')
    if model.summary_input.in_features < 12:
        raise ValueError('summary input lacks 12 pitch classes')
    # New head j has the old H head j in its first half and old M head j in
    # its second half. Thus no old tensor is silently resized or interpolated.
    old_head_width = d // old_heads
    positions = {}
    for name, offset in (('H', 0), ('M', old_head_width)):
        positions[name] = (torch.arange(d) // old_head_width) * (2 * old_head_width)
        positions[name] += torch.arange(d) % old_head_width + offset
    copied = 0
    ff = config['ff']
    if model.decoder.layers[0].linear1.out_features < 2 * ff:
        raise ValueError('new decoder feed-forward layer is too narrow for both branches')

    with torch.no_grad():
        h_idx, m_idx = positions['H'], positions['M']
        model.summary_input.weight[h_idx[:, None], torch.arange(12)[None, :]] = old.chord_root.weight[:12].T
        model.summary_input.weight[m_idx[:, None], torch.arange(12)[None, :]] = old.rel_head['M'].weight.T
        copied += 2 * d * 12
        for layer_index, source_layer in enumerate(old.layers):
            target = model.decoder.layers[layer_index]
            for name, stream in (('H', 1), ('M', 3)):
                idx = positions[name]
                hidden = torch.arange(ff) + (0 if name == 'H' else ff)
                for projection_index, projection in enumerate(('q', 'k', 'v')):
                    destination_rows = width * projection_index + idx
                    source_projection = getattr(source_layer, projection)[stream]
                    target.self_attn.in_proj_weight[destination_rows[:, None], idx[None, :]] = source_projection.weight
                    target.self_attn.in_proj_bias[destination_rows] = source_projection.bias
                    copied += d * d + d
                target.self_attn.out_proj.weight[idx[:, None], idx[None, :]] = source_layer.o[stream].weight
                target.self_attn.out_proj.bias[idx] = source_layer.o[stream].bias
                target.linear1.weight[hidden[:, None], idx[None, :]] = source_layer.ff1[stream].weight
                target.linear1.bias[hidden] = source_layer.ff1[stream].bias
                target.linear2.weight[idx[:, None], hidden[None, :]] = source_layer.ff2[stream].weight
                target.linear2.bias[idx] = source_layer.ff2[stream].bias
                copied += d * d + d + 2 * ff * d + ff + d
                for old_norm, new_norm in (('ln1', target.norm1), ('ln2', target.norm3)):
                    source_norm = getattr(source_layer, old_norm)[stream]
                    new_norm.weight[idx] = source_norm.weight
                    new_norm.bias[idx] = source_norm.bias
                    copied += 2 * d
    return {
        'method': 'continued-joint-H-M-half-head-transplant-v1',
        'source': str(source.resolve()),
        'sha256': digest(source),
        'sourceStep': checkpoint['step'],
        'sourceConfig': config,
        'decoderLayersSeeded': len(old.layers),
        'copiedScalars': copied,
        'summarySources': ['chord_root.weight[:12]', 'rel_head.M.weight'],
        'decoderSources': ['H/M q,k,v,o', 'H/M ff1,ff2', 'H/M ln1,ln2'],
        'notTransferred': ['R/B branch', 'old four-track token embeddings and output heads',
                           'cross attention', 'event vocabulary', 'form planner'],
        'oldBackboneRunAtInference': False,
    }
