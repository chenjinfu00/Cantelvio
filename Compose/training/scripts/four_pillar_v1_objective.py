"""Source-masked objectives for the untrained four-pillar architecture.

No missing note, chord, group, role, dynamic or tempo field becomes a negative
example. Hard-locked material is excluded from prediction loss. The weights
below are placeholders for later numerical calibration, not validated optima.
"""
from __future__ import annotations

import torch
from torch.nn import functional as F


def _masked(losses: torch.Tensor, known: torch.Tensor) -> tuple[torch.Tensor, int]:
    if losses.shape != known.shape or known.dtype != torch.bool:
        raise ValueError('loss and known-mask shape mismatch')
    count = int(known.sum())
    return (losses.masked_fill(~known, 0).sum() / max(count, 1), count)


def _target(targets: dict, name: str, shape: torch.Size, device: torch.device):
    value, known = targets.get(name), targets.get(name + '_known')
    if value is None and known is None:
        return None
    if value is None or known is None or value.shape != shape or known.shape != shape:
        raise ValueError(f'{name} needs target and source-known mask of shape {tuple(shape)}')
    if value.device != device or known.device != device or known.dtype != torch.bool:
        raise ValueError(f'{name} target/mask device or dtype mismatch')
    return value, known


def _unlocked(targets: dict, name: str, known: torch.Tensor) -> torch.Tensor:
    locked = targets.get(name + '_locked')
    if locked is None:
        return known
    if locked.shape != known.shape or locked.dtype != torch.bool or locked.device != known.device:
        raise ValueError(f'{name} locked-mask mismatch')
    return known & ~locked


def composition_objective(outputs: dict, targets: dict,
                          weights: dict[str, float] | None = None) -> tuple[torch.Tensor, dict]:
    """Return a differentiable sum plus per-head loss/coverage for later audits.

    Expected target names: event, voice_pointer, harmony_root,
    harmony_quality, form_summary, form_density, form_register, form_texture,
    group_activity, key_direction, motif, motif_recall,
    motif_pitch_shift, motif_log_duration, tempo_change, tempo_delta,
    numeric_dynamic, midi_velocity. Each optional field needs a matching
    `<name>_known` mask. No missing task is silently filled with a label.
    """
    defaults = {'event': 1.0, 'voice_pointer': 1.0, 'harmony_root': 0.5,
                'harmony_quality': 0.5, 'form_summary': 0.25,
                'form_density': 0.25, 'form_register': 0.25,
                'form_texture': 0.25, 'group_activity': 0.25,
                'key_direction': 0.25, 'motif': 0.05,
                'motif_recall': 0.05, 'motif_pitch_shift': 0.05,
                'motif_log_duration': 0.05,
                'tempo_change': 0.25, 'tempo_delta': 0.25,
                'numeric_dynamic': 0.1, 'midi_velocity': 0.1}
    weights = {**defaults, **(weights or {})}
    if any(value < 0 for value in weights.values()):
        raise ValueError('objective weights must be nonnegative')
    anchor = outputs['tokens']
    total = anchor.new_zeros(())
    report = {}

    def add(name: str, losses: torch.Tensor, known: torch.Tensor):
        nonlocal total
        value, count = _masked(losses, known)
        if count:
            total = total + weights[name] * value
        report[name] = {'loss': float(value.detach()), 'known': count}

    categories = {
        'event': 'tokens', 'voice_pointer': 'voice_pointer',
        'harmony_root': 'harmony_root', 'harmony_quality': 'harmony_quality',
        'form_texture': 'form_texture', 'key_direction': 'key_direction',
        'motif': 'motif', 'motif_recall': 'motif_recall',
    }
    for name, output_key in categories.items():
        if name not in targets and name + '_known' not in targets:
            continue
        logits = outputs[output_key]
        shape = logits.shape[:-1]
        pair = _target(targets, name, shape, logits.device)
        if pair is None:
            continue
        value, known = pair
        known = _unlocked(targets, name, known)
        if known.any() and ((value[known] < 0).any() or
                            (value[known] >= logits.shape[-1]).any()):
            raise ValueError(f'{name} label outside available classes')
        safe = value.masked_fill(~known, 0).long()
        losses = F.cross_entropy(logits.movedim(-1, 1), safe, reduction='none')
        add(name, losses, known)

    continuous = {
        'form_summary': ('summaries', 'mse'),
        'form_density': ('form_density', 'mse'),
        'form_register': ('form_register', 'mse'),
        'group_activity': ('group_activity', 'bce'),
        'numeric_dynamic': ('numeric_dynamic', 'gaussian'),
        'midi_velocity': ('midi_velocity', 'gaussian'),
    }
    for name, (key, kind) in continuous.items():
        if name not in targets and name + '_known' not in targets:
            continue
        prediction = outputs[key]
        expected = prediction.shape[:-1] if kind == 'gaussian' else prediction.shape
        pair = _target(targets, name, expected, prediction.device)
        if pair is None:
            continue
        value, known = pair
        known = _unlocked(targets, name, known)
        safe = value.masked_fill(~known, 0).float()
        if kind == 'gaussian':
            mean, log_scale = prediction.unbind(dim=-1)
            losses = 0.5 * ((safe - mean) ** 2 * torch.exp(-2 * log_scale.clamp(-8, 8))
                            + 2 * log_scale.clamp(-8, 8))
        elif kind == 'bce':
            losses = F.binary_cross_entropy_with_logits(prediction, safe, reduction='none')
        else:
            losses = (prediction - safe).square()
        add(name, losses, known)

    for name, head in (('tempo_change', 0), ('tempo_delta', 1)):
        if name not in targets and name + '_known' not in targets:
            continue
        prediction = outputs['tempo']
        pair = _target(targets, name, prediction.shape[:-1], prediction.device)
        if pair is None:
            continue
        value, known = pair
        known = _unlocked(targets, name, known)
        safe = value.masked_fill(~known, 0).float()
        if name == 'tempo_change':
            losses = F.binary_cross_entropy_with_logits(prediction[..., head], safe,
                                                         reduction='none')
        else:
            mean, log_scale = prediction[..., 1], prediction[..., 2].clamp(-8, 8)
            losses = 0.5 * ((safe - mean).square() * torch.exp(-2 * log_scale) + 2 * log_scale)
        add(name, losses, known)
    for name, head in (('motif_pitch_shift', 0), ('motif_log_duration', 1)):
        if name not in targets and name + '_known' not in targets:
            continue
        prediction = outputs['motif_transform'][..., head]
        pair = _target(targets, name, prediction.shape, prediction.device)
        if pair is None:
            continue
        value, known = pair
        known = _unlocked(targets, name, known)
        add(name, (prediction - value.masked_fill(~known, 0).float()).square(), known)
    if not report or not any(row['known'] for row in report.values()):
        raise ValueError('no source-known supervision in four-pillar batch')
    if not torch.isfinite(total):
        raise FloatingPointError('nonfinite four-pillar objective')
    return total, report
