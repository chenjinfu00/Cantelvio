"""Verified past-only R/H/B/M context paired with exact OpenScore Lieder scores.

The score and old joint arrays must originate from the same pinned Lieder
archive. A matching score ID alone is insufficient: every bar start and length
must agree in the exact quarter-note timeline. Tuplets in the target score are
never rounded to construct the old context; the old grid is used only as a
soft prior from *completed* past steps.
"""
from __future__ import annotations

from fractions import Fraction

import numpy as np
import torch

from joint_data import T_MAX, encode_window
from score_events_v2 import ScoreEvents

STEP_KEYS = ('R', 'H', 'B', 'M', 'pos', 'meter', 'level', 'phrase',
             'lkey', 'beatphase', 'chord', 'since', 'change', 'barlen', 'beatlen')
GLOBAL_KEYS = ('domain', 'style', 'refmode')


def verified_bar_steps(score: ScoreEvents, piece: dict) -> tuple[int, ...]:
    """Return exact old-grid starts or reject a non-identical score timeline."""
    if score.score_id != piece['meta']['scoreId']:
        raise ValueError('score ID differs from old joint source')
    arrays = piece['arrays']
    bars = np.asarray(arrays['bar'])
    if (bars.ndim != 1 or len(bars) == 0 or bars[0] != 0
            or np.any(np.diff(bars) < 0) or bars[-1] != len(score.measures) - 1):
        raise ValueError('old joint bar sequence differs from exact score')
    changes = np.flatnonzero(np.r_[True, bars[1:] != bars[:-1]])
    starts = tuple(int(value) for value in changes)
    if len(starts) != len(score.measures):
        raise ValueError('old joint bar count differs from exact score')
    bounds = (*starts, len(bars))
    for index, measure in enumerate(score.measures):
        start, end = bounds[index:index + 2]
        if (bars[start] != index or Fraction(start, 4) != measure.onset
                or Fraction(end - start, 4) != measure.duration):
            raise ValueError(f'old joint timeline differs at bar {index}')
    return starts


def past_window_before_bar(score: ScoreEvents, piece: dict, bar: int,
                           *, device: torch.device | str = 'cpu') -> dict | None:
    """Encode only completed steps before a target bar; never its target notes."""
    starts = verified_bar_steps(score, piece)
    if not 0 < bar < len(starts):
        return None
    end = starts[bar]
    earlier = [step for step in starts[:bar] if 0 < end - step <= T_MAX]
    if not earlier:
        return None
    begin = earlier[0]
    arrays = piece['arrays']
    if (np.any(np.asarray(arrays['meter'])[begin:end] < 0)
            or np.any(np.asarray(arrays['ch_root'])[begin:end] < 0)):
        return None
    encoded = encode_window(piece, begin, end, T=T_MAX)
    visible = end - begin
    if encoded is None or not 1 <= visible <= T_MAX or not encoded['valid'][:visible].all():
        return None
    window = {key: torch.as_tensor(encoded[key], dtype=torch.long, device=device)[None]
              for key in STEP_KEYS}
    window.update({key: torch.tensor([encoded[key]], dtype=torch.long, device=device)
                   for key in GLOBAL_KEYS})
    return {'legacy_window': window,
            'legacy_visible_steps': torch.tensor([visible], dtype=torch.long, device=device),
            'legacy_end_qn': (score.measures[bar].onset,),
            'target_start_qn': (score.measures[bar].onset,),
            'source': {'scoreId': score.score_id, 'pastStartStep': begin,
                       'pastEndStep': end, 'referenceTonic': encoded['info']['refTonic']}}
