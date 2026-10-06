"""Bounded, auditable score samples for the four-pillar technical trial."""
from __future__ import annotations

import gzip
import json
import math
import random
from bisect import bisect_left
from dataclasses import dataclass

import numpy as np
import torch

from four_pillar_codec import (BOS, END_BAR, END_ONSET, ONSET, PAD, EncodedScore,
                               _fraction, encode_score)
from four_pillar_split import SCORES
from four_pillar_trial_model import PLAN_BARS, SUMMARY_DIM
from score_events_v2 import ScoreEvents


@dataclass
class TrialScore:
    score: ScoreEvents
    encoded: EncodedScore
    summaries: np.ndarray
    notes_by_index: dict


def summarize_bars(score: ScoreEvents) -> np.ndarray:
    raw = np.zeros((len(score.measures), SUMMARY_DIM), dtype=np.float32)
    note_count = np.zeros(len(score.measures), dtype=np.float32)
    pitched = np.zeros(len(score.measures), dtype=np.float32)
    group_count = np.zeros(len(score.measures), dtype=np.float32)
    from four_pillar_codec import GROUPS
    group_to_idx = {group: i for i, group in enumerate(GROUPS)}
    for note in score.events:
        b = note.bar
        note_count[b] += 1
        if note.pitch is not None:
            raw[b, note.pitch % 12] += 1
            raw[b, 19] += note.pitch / 127
            pitched[b] += 1
        if note.group in group_to_idx:
            raw[b, 12 + group_to_idx[note.group]] += 1
            group_count[b] += 1
    for b in range(len(score.measures)):
        if pitched[b]:
            raw[b, :12] /= pitched[b]
            raw[b, 19] /= pitched[b]
        if group_count[b]:
            raw[b, 12:18] /= group_count[b]
        raw[b, 18] = math.log1p(note_count[b]) / math.log(129)
    return raw


def load_selected(split: dict) -> dict[str, list[TrialScore]]:
    selected = {r['scoreId']: (partition, r)
                for partition, rows in split['scores'].items() for r in rows}
    out = {'train': [], 'validation': []}
    with gzip.open(SCORES, 'rt') as stream:
        for line in stream:
            record = json.loads(line)
            row = selected.get(record['scoreId'])
            if row is None:
                continue
            partition, expected = row
            if record['scoreSha256'] != expected['scoreSha256'] or record['compositionKey'] != expected['compositionKey']:
                raise ValueError('score content or composition changed after split was frozen')
            score = ScoreEvents.from_candidate(record)
            out[partition].append(TrialScore(score=score, encoded=encode_score(score),
                                              summaries=summarize_bars(score),
                                              notes_by_index={n.source_index: n for n in score.events}))
    if any(len(out[s]) != len(split['scores'][s]) for s in out):
        raise ValueError('split selection missing from score corpus')
    return out


def _notes_in_bar(item: TrialScore, bar: int):
    start, end = item.encoded.bar_spans[bar]
    spans = item.encoded.note_spans
    first = bisect_left(spans, (start, -1))
    for idx in range(first, len(spans)):
        a, b = spans[idx]
        if a >= end:
            break
        yield item.notes_by_index[item.encoded.source_indices[idx]], a, b


def make_example(item: TrialScore, bar: int, *, history_bars: int,
                 context: int, task: str) -> dict:
    if not 1 <= bar < len(item.score.measures):
        raise ValueError('target requires at least one completed bar')
    if task not in ('free', 'given_high_voice', 'given_low_voice', 'past_motif'):
        raise ValueError('unknown technical trial task')
    start, end = item.encoded.bar_spans[bar]
    limit = min(end, start + context)
    # A fixed token cutoff can bisect a note or a simultaneous-onset slice.
    # Only complete slices are valid teacher-forced targets.
    stop = next((i + 1 for i in range(limit - 1, start - 1, -1)
                 if item.encoded.tokens[i] in (END_ONSET, END_BAR)), None)
    if stop is None:
        raise ValueError('no complete onset slice fits the event context')
    target = list(item.encoded.tokens[start:stop])
    loss_mask = list(item.encoded.loss_mask[start:stop])
    if not target:
        raise ValueError('empty target bar')
    first = max(0, bar - history_bars)
    history = np.zeros((history_bars, SUMMARY_DIM), dtype=np.float32)
    known = np.zeros(history_bars, dtype=np.bool_)
    window = item.summaries[first:bar]
    history[:len(window)] = window
    known[:len(window)] = True
    future = np.zeros((PLAN_BARS, SUMMARY_DIM), dtype=np.float32)
    future_known = np.zeros(PLAN_BARS, dtype=np.bool_)
    available = item.summaries[bar:bar + PLAN_BARS]
    future[:len(available)] = available
    future_known[:len(available)] = True
    # Proxy recurrence target from *future* musical data is supervision only.
    a = future[0, :12]
    n = np.linalg.norm(a)
    cosine = (history[:, :12] @ a / np.maximum(np.linalg.norm(history[:, :12], axis=1) * n, 1e-8))
    cosine[~known] = -1
    winner = int(cosine.argmax())
    motif = winner + 1 if cosine[winner] > 0.92 and n > 0.1 else 0

    material: list[int] = []
    if task in ('given_high_voice', 'given_low_voice'):
        visible = [(n, a, b) for n, a, b in _notes_in_bar(item, bar) if b <= stop and n.pitch is not None]
        voices = {}
        for note, a, b in visible:
            voices.setdefault(note.voice_id, []).append(note.pitch)
        if voices:
            key = (max if task == 'given_high_voice' else min)(
                voices, key=lambda voice: float(np.mean(voices[voice])))
            for note, a, b in visible:
                if note.voice_id != key:
                    continue
                piece = ([ONSET] + _fraction(note.onset - item.score.measures[bar].onset)
                         + list(item.encoded.tokens[a:b]))
                if len(material) + len(piece) > context:
                    break
                material += piece
    elif task == 'past_motif':
        preceding = bar - 1
        first_notes = list(_notes_in_bar(item, preceding))[:8]
        for note, a, b in first_notes:
            piece = ([ONSET] + _fraction(note.onset - item.score.measures[preceding].onset)
                     + list(item.encoded.tokens[a:b]))
            if len(material) + len(piece) > context:
                break
            material += piece
    return dict(target=target, loss_mask=loss_mask, history=history,
                history_known=known, future=future, future_known=future_known,
                motif=motif, material=material, task=task,
                score_id=item.score.score_id, bar=bar)


def sample_example(scores: list[TrialScore], rng: random.Random, *, history_bars: int,
                   context: int, task: str | None = None) -> dict:
    for _ in range(32):
        item = rng.choice(scores)  # equal chance per score, not per adjacent window
        bar = rng.randrange(1, len(item.score.measures))
        chosen_task = task or rng.choice(('free', 'given_high_voice',
                                           'given_low_voice', 'past_motif'))
        try:
            return make_example(item, bar, history_bars=history_bars,
                                context=context, task=chosen_task)
        except ValueError as exc:
            if str(exc) != 'no complete onset slice fits the event context':
                raise
    raise ValueError('could not sample a complete onset slice in 32 attempts')


def collate(examples: list[dict], *, context: int, device: torch.device) -> dict:
    B = len(examples)
    lengths = [len(e['target']) for e in examples]
    L = max(lengths)
    target = torch.full((B, L), PAD, dtype=torch.long, device=device)
    decoder_input = torch.full((B, L), PAD, dtype=torch.long, device=device)
    loss_mask = torch.zeros((B, L), dtype=torch.bool, device=device)
    M = min(context, max((len(e['material']) for e in examples), default=0))
    material = torch.full((B, M), PAD, dtype=torch.long, device=device)
    material_known = torch.zeros((B, M), dtype=torch.bool, device=device)
    for i, example in enumerate(examples):
        n = lengths[i]
        target[i, :n] = torch.tensor(example['target'], dtype=torch.long, device=device)
        decoder_input[i, :n] = torch.tensor([BOS] + example['target'][:-1], dtype=torch.long, device=device)
        loss_mask[i, :n] = torch.tensor(example['loss_mask'], dtype=torch.bool, device=device)
        m = min(M, len(example['material']))
        if m:
            material[i, :m] = torch.tensor(example['material'][:m], dtype=torch.long, device=device)
            material_known[i, :m] = True
    return {
        'history': torch.as_tensor(np.stack([e['history'] for e in examples]), device=device),
        'history_known': torch.as_tensor(np.stack([e['history_known'] for e in examples]), device=device),
        'future': torch.as_tensor(np.stack([e['future'] for e in examples]), device=device),
        'future_known': torch.as_tensor(np.stack([e['future_known'] for e in examples]), device=device),
        'motif_target': torch.tensor([e['motif'] for e in examples], dtype=torch.long, device=device),
        'decoder_input': decoder_input, 'target': target, 'loss_mask': loss_mask,
        'material': material, 'material_known': material_known,
    }
