"""Small, source-paired Lieder pilot for the *full* four-pillar network.

This intentionally does not substitute for the final orchestral corpus, four
task mixture, work-level deduplication or held-out listening evaluation. Each
selected score is checked against the old R/H/B/M timeline before use.
"""
from __future__ import annotations

import json
import tarfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from four_pillar_split import build_split, digest
from four_pillar_trial_data import load_selected, summarize_bars
from four_pillar_trial_model import PLAN_BARS, SUMMARY_DIM
from four_pillar_v1_alignment import past_window_before_bar, verified_bar_steps
from four_pillar_v1_codec import causal_teacher_forcing_inputs, encode_dynamic_score
from joint_data import load_corpus
from prepare_classical_scores import score_events, xml_from_mxl
from score_events_v2 import ScoreEvents
from four_pillar_codec import END_BAR, END_ONSET

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'data/sources/OpenScore-Lieder-38c5db5.tar.gz'
JOINT = ROOT / 'data/joint/lieder-joint.npz'


@dataclass
class PairedScore:
    score: ScoreEvents
    piece: dict | None
    encoded: object
    summaries: np.ndarray
    bar_steps: tuple[int, ...]


def load_paired(*, train_count: int = 8, validation_count: int = 2):
    source = json.loads((ROOT / 'data/sources/SOURCE.json').read_text())
    joint_meta = json.loads(JOINT.with_suffix('.json').read_text())
    if (source['commit'] != joint_meta['commit'] or digest(ARCHIVE) != source['sha256']):
        raise ValueError('Lieder source and old joint preparation do not share a verified archive')
    pieces = load_corpus(JOINT)
    selected, rejected = {'train': [], 'validation': []}, {}
    with tarfile.open(ARCHIVE, 'r:gz') as tar:
        for partition, limit in (('train', train_count), ('validation', validation_count)):
            candidates = sorted((p for p in pieces if p['meta']['split'] == partition),
                                key=lambda p: p['meta']['scoreId'])
            for piece in candidates:
                if len(selected[partition]) >= limit:
                    break
                meta = piece['meta']
                member = f"OpenScore-Lieder/scores/{meta['workId']}/{meta['scoreId']}.mxl"
                try:
                    raw = tar.extractfile(member).read()
                    parts, measures, notes, _ = score_events(ET.fromstring(xml_from_mxl(raw)))
                    score = ScoreEvents.from_candidate({
                        'scoreId': meta['scoreId'],
                        'parts': [dict(id=identity, **info) for identity, info in parts],
                        'measures': measures, 'notes': notes})
                    starts = verified_bar_steps(score, piece)
                    if sum(past_window_before_bar(score, piece, bar) is not None
                           for bar in range(1, len(starts))) < 2:
                        raise ValueError('fewer than two usable aligned past bars')
                    encoded = encode_dynamic_score(score)
                    selected[partition].append(PairedScore(
                        score, piece, encoded, summarize_bars(score), starts))
                except (ValueError, KeyError, TypeError, AttributeError, ET.ParseError) as error:
                    rejected[meta['scoreId']] = str(error)
    if len(selected['train']) != train_count or len(selected['validation']) != validation_count:
        raise ValueError('not enough source-verified paired scores for pilot')
    work_sets = {part: {item.piece['meta']['workId'] for item in scores}
                 for part, scores in selected.items()}
    if work_sets['train'] & work_sets['validation']:
        raise ValueError('pilot work leaked between training and validation')
    return selected, rejected


def load_mixed_pilot(*, train_count: int = 8, validation_count: int = 2):
    """Add the independently screened, provisional classical smoke selection."""
    selected, rejected = load_paired(train_count=train_count,
                                     validation_count=validation_count)
    split = build_split(smoke=True)
    classical = load_selected(split)
    for partition, items in classical.items():
        for item in items:
            encoded = encode_dynamic_score(item.score)
            selected[partition].append(PairedScore(
                item.score, None, encoded, item.summaries, ()))
    return selected, rejected, split


def make_example(item: PairedScore, bar: int, *, context: int = 256,
                 history_bars: int = 32) -> tuple[dict, dict]:
    """One teacher-forced target bar with verified old-model *past* context."""
    if not 0 < bar < len(item.score.measures) or context < 16:
        raise ValueError('invalid target bar or event context')
    prior = (past_window_before_bar(item.score, item.piece, bar)
             if item.piece is not None else {})
    if prior is None:
        raise ValueError('bar has no source-verified old-model prefix')
    prior.pop('source', None)  # audit metadata is not a network argument
    start, end = item.encoded.bar_spans[bar]
    limit = min(end, start + context)
    stop = max((index + 1 for index in range(start, limit)
                if item.encoded.tokens[index] in (END_ONSET, END_BAR)), default=None)
    if stop is None:
        raise ValueError('no complete onset slice fits the context')
    left, right = start - 1, stop - 1
    teacher = causal_teacher_forcing_inputs(item.encoded, start=left, stop=right)
    known_history = min(history_bars, bar)
    history = torch.zeros(1, history_bars, SUMMARY_DIM)
    history[0, :known_history] = torch.from_numpy(item.summaries[bar - known_history:bar])
    history_known = torch.zeros(1, history_bars, dtype=torch.bool)
    history_known[0, :known_history] = True
    inputs = dict(history=history, history_known=history_known,
                  decoder_input=teacher['decoder_input'],
                  voice_features=teacher['voice_features'],
                  voice_known=teacher['voice_known'],
                  voice_pointer_input=teacher['voice_pointer_input'],
                  material=torch.empty(1, 0, dtype=torch.long),
                  material_known=torch.empty(1, 0, dtype=torch.bool),
                  task_id=torch.zeros(1, dtype=torch.long),
                  intent_id=torch.zeros(1, dtype=torch.long), **prior)
    targets = {
        'event': teacher['event_target'],
        'event_known': teacher['event_known'],
        'voice_pointer': teacher['voice_pointer_target'],
        'voice_pointer_known': teacher['voice_pointer_target_known'],
    }
    future = item.summaries[bar:bar + PLAN_BARS]
    future_count = len(future)
    summary = torch.zeros(1, PLAN_BARS, SUMMARY_DIM)
    summary[0, :future_count] = torch.from_numpy(future)
    summary_known = torch.zeros_like(summary, dtype=torch.bool)
    summary_known[0, :future_count] = True
    targets['form_summary'], targets['form_summary_known'] = summary, summary_known
    # AugmentedNet's score-aligned chord analysis is a sourced *target*, never
    # a future chord condition for free continuation.
    roots = torch.zeros(1, PLAN_BARS, dtype=torch.long)
    qualities = torch.zeros_like(roots)
    chord_known = torch.zeros(1, PLAN_BARS, dtype=torch.bool)
    if item.piece is not None:
        for offset in range(min(PLAN_BARS, len(item.bar_steps) - bar)):
            step = item.bar_steps[bar + offset]
            root = int(item.piece['arrays']['ch_root'][step])
            quality = int(item.piece['arrays']['ch_q'][step])
            if 0 <= root < 12 and 0 <= quality < 40:
                roots[0, offset], qualities[0, offset] = root, quality
                chord_known[0, offset] = True
        targets.update(harmony_root=roots, harmony_root_known=chord_known,
                       harmony_quality=qualities, harmony_quality_known=chord_known)
    return inputs, targets
