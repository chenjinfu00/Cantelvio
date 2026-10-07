#!/usr/bin/env python3
"""Harmonizer v1: melody -> chords, for Cantelvio Score's accompany-melody task.

v3.1 writes the chord of a beat before the melody note of that beat (event order: chord changes, then notes
from the lowest up), so with a given melody it has to guess the harmony. This small separate model reads the
whole given melody in both directions and proposes the chords; four_pillar_v31_tasks.TaskComposer then locks
them (chords=...) together with the melody while v3.1 writes the accompaniment.

Model     bidirectional transformer encoder over the melody on a sixteenth-note grid (the grid of the Lieder
          joint corpus); a chord distribution at every step over v3.1's chord vocabulary: 12 absolute roots x
          the 40 qualities of data/chord-qualities.json. Besides the melody it reads the notated key signature
          (as the pitch class of its major tonic; the mode is left to the model). Training uses random
          transpositions, so local keys and modulations are inferred from the melody.
Texture   (config 'texture', harmonizer v2) optionally also every note of the score: per step the sounding
          and starting pitch classes and the bass pitch class. With it the same model analyses a whole score
          (harmonic analysis); without it (dropped at random in training) it harmonizes a melody.
Decoding  Viterbi over the steps; the probability of a chord change depends on the metric level (downbeat,
          beat, eighth, sixteenth) and is estimated from the training labels. Output: chord changes per bar
          (offset in quarters, root, quality), the format TaskComposer locks.
Data      training/data/joint/lieder-joint.npz: OpenScore Lieder (CC0), the vocal line as melody, AugmentedNet
          v1.9.1 chords; splits by work (924 train / 111 validation / 96 test pieces).

    .venv-training/bin/python training/scripts/harmonizer_v1.py \\
        --run-dir training/runs/harmonizer-v1-<date> --steps 4000          # --resume continues a run
    .venv-training/bin/python training/scripts/harmonizer_v1.py \\
        --run-dir training/runs/harmonizer-v1-<date> --tune-decoding       # then: the Viterbi penalty
"""
from __future__ import annotations

import argparse
import json
import math
import time
from fractions import Fraction
from pathlib import Path

import numpy as np
import torch
from torch import nn

from four_pillar_v31_tonal import QUALITIES

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / 'data/joint/lieder-joint.npz'
KEYSIG_CACHE = ROOT / 'data/joint/lieder-keysig-v1.npz'      # notated key signatures on the corpus grid
TEXTURE_CACHE = ROOT / 'data/joint/lieder-texture-v1.npz'    # all notes of the aligned scores on the corpus grid
SCORES = ROOT / 'data/four-pillar-score-all-train-v1.sqlite'
DEFAULT_WEIGHTS = ROOT / 'runs/harmonizer-v1-20261003/weights.pt'   # used by Cantelvio Score's adapter
ANALYSIS_WEIGHTS = ROOT / 'runs/harmonizer-v2-20261003/weights.pt'  # with texture: harmonic analysis
NO_BASS = 12
SCHEMA = 'ailegro-harmonizer-v1'
N_QUAL = len(QUALITIES)
N_CLASSES = 12 * N_QUAL                     # class = quality * 12 + absolute root
# Metres and grid exactly as training/scripts/build_joint_lieder.py builds the corpus.
METERS = {(2, 4): 0, (3, 4): 1, (4, 4): 2, (2, 2): 3, (3, 8): 4, (6, 8): 5, (9, 8): 6, (12, 8): 7,
          (6, 4): 8, (3, 2): 9, (4, 8): 10, (5, 4): 11, (2, 8): 12}
UNKNOWN_METER = 13
COMPOUND = {(6, 8), (9, 8), (12, 8), (6, 4)}
MAX_BAR = 24
REST_PC, REST_OCTAVE, UNKNOWN_KEYSIG = 12, 7, 12
CONFIG = {'width': 128, 'heads': 4, 'layers': 4, 'ff': 512, 'dropout': 0.1, 'steps': 256, 'keysig': True}


def keysig_class(fifths) -> int:
    """Pitch class of the major tonic of a key signature (sharps > 0), 12 when unknown."""
    return UNKNOWN_KEYSIG if fifths is None else (int(fifths) * 7) % 12


def family(quality: int) -> str:
    """maj (dominant sevenths included), min, dim (half and full diminished sevenths included), aug, other."""
    tones = set(QUALITIES[quality]['intervals'])
    if {4, 7} <= tones:
        return 'maj'
    if {3, 7} <= tones:
        return 'min'
    if {3, 6} <= tones:
        return 'dim'
    if {4, 8} <= tones:
        return 'aug'
    return 'other'


FAMILY = np.array([['maj', 'min', 'dim', 'aug', 'other'].index(family(q)) for q in range(N_QUAL)])


# ====================================================================== the melody grid
def beat_steps(n: int, d: int) -> int:
    if (n, d) in COMPOUND:
        return 6 if d == 8 else 12
    return {4: 4, 2: 8, 8: 2, 16: 1}.get(d, 4)


def metrical_level(pos: int, beat: int) -> int:
    if pos == 0:
        return 0
    if pos % beat == 0:
        return 1
    return 2 if pos % 2 == 0 else 3


def melody_grid(notes, bars) -> dict:
    """Melody arrays on the sixteenth-note grid, as in the Lieder joint corpus.

    notes: (onset, duration, pitch or pitches) in quarters from the start of the first bar (grace notes left
    out by the caller); bars: (actual length in quarters, (numerator, denominator)[, key signature fifths or
    None]) in order. A first bar shorter than its metre is a pickup that ends at the barline. The melody is
    the top-note skyline; a later onset replaces an earlier sustained note."""
    offsets, total = [], Fraction(0)
    for length, *_ in bars:
        offsets.append(total)
        total += Fraction(length)
    n_steps = int(round(total * 4))
    bar = np.full(n_steps, -1, np.int32)
    pos = np.zeros(n_steps, np.int16)
    barlen = np.zeros(n_steps, np.int16)
    meter = np.full(n_steps, -1, np.int16)
    level = np.zeros(n_steps, np.int8)
    keysig = np.full(n_steps, UNKNOWN_KEYSIG, np.int8)
    starts = []
    for index, (shape, offset) in enumerate(zip(bars, offsets)):
        length, (num, den) = shape[0], shape[1]
        s0, s1 = int(round(offset * 4)), int(round((offset + Fraction(length)) * 4))
        keysig[s0:s1] = keysig_class(shape[2] if len(shape) > 2 else None)
        starts.append(s0)
        nominal = int(round(Fraction(num * 4, den) * 4))
        mid = METERS.get((num, den), -1)
        if mid < 0 or nominal > MAX_BAR or nominal <= 0:
            mid = -1
        shift = nominal - (s1 - s0) if (index == 0 and s1 - s0 < nominal) else 0
        beat = beat_steps(num, den)
        for j, step in enumerate(range(s0, min(s1, n_steps))):
            p = min(j + shift, max(nominal - 1, 0))
            bar[step], pos[step], meter[step], barlen[step] = index, p, mid, nominal
            level[step] = metrical_level(p, beat)
    pitch = np.full(n_steps, -1, np.int16)
    start = np.full(n_steps, -1, np.int32)
    for onset, duration, pitches in notes:
        top = max(pitches) if isinstance(pitches, (list, tuple)) else int(pitches)
        s0 = int(round(float(onset) * 4))
        s1 = max(s0 + 1, int(round((float(onset) + float(duration)) * 4)))
        for step in range(max(s0, 0), min(s1, n_steps)):
            current = pitch[step]
            if current < 0 or top > current or (top == current and s0 > start[step]) or s0 > start[step]:
                pitch[step], start[step] = top, s0
    onset_flag = ((start == np.arange(n_steps)) & (pitch >= 0)).astype(np.int8)
    return {'bar': bar, 'pos': pos, 'barlen': barlen, 'meter': meter, 'level': level, 'mel_pitch': pitch,
            'mel_on': onset_flag, 'keysig': keysig, 'starts': starts}


def texture_grid(notes, n_steps: int) -> dict[str, np.ndarray]:
    """Every pitched note of the score on the same grid: sounding count per pitch class (at most 3), pitch
    classes starting at the step (bit mask) and the lowest sounding pitch class (NO_BASS when silent).
    notes: (onset, duration, pitch) in quarters from the start of the first bar."""
    count = np.zeros((n_steps, 12), np.uint8)
    onset_bits = np.zeros(n_steps, np.uint16)
    lowest = np.full(n_steps, 999, np.int16)
    for onset, duration, pitch in notes:
        s0 = int(round(float(onset) * 4))
        s1 = max(s0 + 1, int(round((float(onset) + float(duration)) * 4)))
        a, b = max(s0, 0), min(s1, n_steps)
        if a >= b:
            continue
        pc = int(pitch) % 12
        count[a:b, pc] = np.minimum(count[a:b, pc] + 1, 3)
        lowest[a:b] = np.minimum(lowest[a:b], int(pitch))
        if 0 <= s0 < n_steps:
            onset_bits[s0] |= 1 << pc
    bass = np.where(lowest < 999, lowest % 12, NO_BASS).astype(np.int8)
    return {'tex_count': count, 'tex_onset': onset_bits, 'tex_bass': bass}


def inputs(arrays: dict, a: int, b: int, shift: int = 0) -> dict[str, np.ndarray]:
    """Model inputs for steps a..b (transposed by `shift` semitones)."""
    pitch = np.asarray(arrays['mel_pitch'][a:b]).astype(np.int64)
    rest = pitch < 0
    shifted = np.where(rest, 0, pitch + shift)
    meter = np.asarray(arrays['meter'][a:b]).astype(np.int64)
    keysig = (np.asarray(arrays['keysig'][a:b]).astype(np.int64) if 'keysig' in arrays
              else np.full(b - a, UNKNOWN_KEYSIG, np.int64))
    texture = {}
    if 'tex_count' in arrays:
        count = np.roll(np.asarray(arrays['tex_count'][a:b]).astype(np.float32) / 3., shift, axis=1)
        bits = np.asarray(arrays['tex_onset'][a:b]).astype(np.int64)
        onset = np.roll(((bits[:, None] >> np.arange(12)) & 1).astype(np.float32), shift, axis=1)
        bass = np.asarray(arrays['tex_bass'][a:b]).astype(np.int64)
        known = np.full(b - a, int(arrays.get('tex_known', 1)), np.int64)
        texture = {'texture': np.concatenate([count, onset], 1) * known[:, None],
                   'bass': np.where((bass >= NO_BASS) | (known == 0), NO_BASS, (bass + shift) % 12),
                   'known': known}
    else:
        texture = {'texture': np.zeros((b - a, 24), np.float32), 'bass': np.full(b - a, NO_BASS, np.int64),
                   'known': np.zeros(b - a, np.int64)}
    return {**texture, 'keysig': np.where(keysig >= UNKNOWN_KEYSIG, UNKNOWN_KEYSIG, (keysig + shift) % 12),
            'pc': np.where(rest, REST_PC, shifted % 12),
            'octave': np.where(rest, REST_OCTAVE, np.clip(shifted // 12 - 2, 0, 6)),
            'onset': np.asarray(arrays['mel_on'][a:b]).astype(np.int64) * (~rest),
            'pos': np.clip(np.asarray(arrays['pos'][a:b]).astype(np.int64), 0, MAX_BAR - 1),
            'level': np.asarray(arrays['level'][a:b]).astype(np.int64),
            'meter': np.where(meter < 0, UNKNOWN_METER, meter)}


def targets(arrays: dict, a: int, b: int, shift: int = 0) -> np.ndarray:
    """Chord class per step (-100 where the harmony or the metre is unknown)."""
    root = np.asarray(arrays['ch_root'][a:b]).astype(np.int64)
    quality = np.asarray(arrays['ch_q'][a:b]).astype(np.int64)
    ok = (root >= 0) & (quality >= 0) & (quality < N_QUAL) & (np.asarray(arrays['meter'][a:b]) >= 0)
    return np.where(ok, quality * 12 + (root + shift) % 12, -100)


# ====================================================================== the model
class Harmonizer(nn.Module):
    def __init__(self, config: dict = CONFIG):
        super().__init__()
        self.config = dict(config)
        d = config['width']
        self.pc = nn.Embedding(13, d)
        self.octave = nn.Embedding(8, d)
        self.onset = nn.Embedding(2, d)
        self.pos = nn.Embedding(MAX_BAR, d)
        self.level = nn.Embedding(4, d)
        self.meter = nn.Embedding(UNKNOWN_METER + 1, d)
        if config.get('keysig'):
            self.keysig = nn.Embedding(UNKNOWN_KEYSIG + 1, d)
        if config.get('texture'):
            self.texture = nn.Linear(24, d)
            self.bass = nn.Embedding(NO_BASS + 1, d)
            self.known = nn.Embedding(2, d)
        layer = nn.TransformerEncoderLayer(d, config['heads'], config['ff'], config['dropout'], batch_first=True,
                                           norm_first=True)
        self.encoder = nn.TransformerEncoder(layer, config['layers'], enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d)
        self.head = nn.Linear(d, N_CLASSES)
        position = torch.arange(4096).unsqueeze(1)
        rate = torch.exp(torch.arange(0, d, 2) * (-math.log(10000.) / d))
        table = torch.zeros(4096, d)
        table[:, 0::2], table[:, 1::2] = torch.sin(position * rate), torch.cos(position * rate)
        self.register_buffer('sinusoid', table, persistent=False)

    def forward(self, x: dict[str, torch.Tensor], padding: torch.Tensor | None = None) -> torch.Tensor:
        """x: [B, T] long tensors (see `inputs`); padding: [B, T] True at padded steps -> logits [B, T, classes]."""
        h = (self.pc(x['pc']) + self.octave(x['octave']) + self.onset(x['onset']) + self.pos(x['pos'])
             + self.level(x['level']) + self.meter(x['meter']) + self.sinusoid[:x['pc'].shape[1]])
        if self.config.get('keysig'):
            h = h + self.keysig(x['keysig'])
        if self.config.get('texture'):
            h = h + self.texture(x['texture'].float()) + self.bass(x['bass']) + self.known(x['known'])
        return self.head(self.norm(self.encoder(h, src_key_padding_mask=padding)))


def save(model: Harmonizer, path: Path, extra: dict) -> None:
    torch.save({'schema': SCHEMA, 'config': model.config, 'state': model.state_dict(), **extra}, path)


def load(path: Path) -> tuple[Harmonizer, dict]:
    data = torch.load(path, map_location='cpu', weights_only=False)
    if data.get('schema') != SCHEMA:
        raise ValueError(f'{path} is not a {SCHEMA} checkpoint')
    model = Harmonizer(data['config'])
    model.load_state_dict(data['state'])
    return model.eval(), {k: v for k, v in data.items() if k not in ('state',)}


# ====================================================================== decoding
@torch.inference_mode()
def posteriors(model: Harmonizer, arrays: dict, window: int | None = None) -> np.ndarray:
    """Log-probabilities [steps, classes]; long melodies are read in overlapping whole-bar windows whose
    probabilities are averaged."""
    window = window or model.config['steps']
    n = len(arrays['mel_pitch'])
    bar = np.asarray(arrays['bar'])
    starts = [0] + [t for t in range(1, n) if bar[t] != bar[t - 1]]
    spans, i = [], 0
    while True:
        a = starts[i]
        if n - a <= window:
            spans.append((a, n))
            break
        j = i
        while j + 1 < len(starts) and starts[j + 1] - a <= window:
            j += 1
        b = starts[j] if j > i else a + window
        spans.append((a, b))
        middle, k = a + (b - a) // 2, i + 1           # next window: from the last bar start before the middle
        while k + 1 < len(starts) and starts[k + 1] <= middle:
            k += 1
        i = k
    total = np.zeros((n, N_CLASSES))
    weight = np.zeros(n)
    for a, b in spans:
        x = {k: torch.as_tensor(v)[None] for k, v in inputs(arrays, a, b).items()}
        p = torch.softmax(model(x)[0].double(), -1).numpy()
        w = np.minimum(np.arange(1, b - a + 1), np.arange(b - a, 0, -1)).astype(float)   # trust window centres
        total[a:b] += p * w[:, None]
        weight[a:b] += w
    return np.log(np.maximum(total / np.maximum(weight, 1e-9)[:, None], 1e-12))


RHYTHMS = ('auto', 'beat', 'half-bar', 'bar', 'two-bars')
# P(the chord changes at an allowed position) per setting, from the training labels (2026-10-03)
RHYTHM_CHANGE = {'beat': .429, 'half-bar': .587, 'bar': .702, 'two-bars': .741}
# weight of the melody's fit to a chord when chords may change only at those positions (tuned on validation)
RHYTHM_FIT = {'beat': 3., 'half-bar': 2., 'bar': 2., 'two-bars': 2.}


def change_mask(arrays: dict, rhythm: str = 'auto') -> np.ndarray | None:
    """Steps where the chord may change for a harmonic-rhythm setting (None = anywhere, as learned):
    'beat' on beats, 'half-bar' on downbeats and the beat in the middle of the bar, 'bar' on downbeats,
    'two-bars' on every second downbeat (counted from the first full bar)."""
    if rhythm not in RHYTHMS:
        raise ValueError(f'harmonic rhythm must be one of {", ".join(RHYTHMS)}')
    if rhythm == 'auto':
        return None
    level, pos = np.asarray(arrays['level']), np.asarray(arrays['pos'])
    if rhythm == 'beat':
        return level <= 1
    downbeat = (pos == 0) & (level == 0)
    if rhythm == 'bar':
        return downbeat
    if rhythm == 'two-bars':
        bars = np.asarray(arrays['bar'])
        first = int(bars[np.flatnonzero(downbeat)[0]]) if downbeat.any() else 0
        return downbeat & ((bars - first) % 2 == 0)
    barlen = np.asarray(arrays['barlen'])
    middle = (barlen % 2 == 0) & (pos == barlen // 2) & (level <= 1)
    return downbeat | middle


def viterbi(logp: np.ndarray, level: np.ndarray, change: np.ndarray, penalty: float = 1.,
            allowed: np.ndarray | None = None) -> np.ndarray:
    """Most likely chord path: at each step stay, or change (log-probability change[level]) to another chord.
    The emissions are the model's posteriors, which already prefer likely chords, so the uniform choice among
    the other chords (-log(k - 1)) is scaled by `penalty` (tuned on the validation split). `allowed`: steps
    where a change may happen (see change_mask)."""
    n, k = logp.shape
    stay = np.log1p(-np.exp(change))
    move = change - penalty * math.log(k - 1)
    delta = logp[0].copy()
    back = np.zeros((n, k), np.int32)
    for t in range(1, n):
        lv = int(level[t])
        if allowed is not None and not allowed[t]:
            delta = delta + logp[t]          # the chord carries on
            back[t] = np.arange(k)
            continue
        best = int(np.argmax(delta))
        from_stay = delta + stay[lv]
        from_move = delta[best] + move[lv]
        take = from_move > from_stay
        back[t] = np.where(take, best, np.arange(k))
        delta = np.where(take, from_move, from_stay) + logp[t]
    path = np.zeros(n, np.int64)
    path[-1] = int(np.argmax(delta))
    for t in range(n - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


TONES = np.zeros((N_CLASSES, 12))
for _class in range(N_CLASSES):
    TONES[_class, [(_class % 12 + i) % 12 for i in QUALITIES[_class // 12]['intervals']]] = 1


def melody_weights(arrays: dict) -> np.ndarray:
    """Melody time per step and pitch class [steps, 12]: a sounding step counts 1, an onset 2, rests 0."""
    pitch = np.asarray(arrays['mel_pitch'])
    w = np.zeros((len(pitch), 12))
    sounding = pitch >= 0
    w[np.flatnonzero(sounding), pitch[sounding] % 12] = 1. + np.asarray(arrays['mel_on'])[sounding]
    return w


def segment_viterbi(logp: np.ndarray, allowed: np.ndarray, change: float, melody: np.ndarray | None = None,
                    fit: float = 0.) -> np.ndarray:
    """One chord per segment between allowed positions: a segment scores each chord by the log of its mean
    probability over the segment's steps (a vote, not a product of per-step evidence) plus `fit` times the
    share of the segment's melody time on the chord's tones (`melody`: melody_weights); consecutive segments
    keep or change the chord with probability 1 - change / change."""
    n, k = logp.shape
    starts = [0] + [t for t in range(1, n) if allowed[t]]
    bounds = starts + [n]
    probs = np.exp(logp)
    score = np.log(np.maximum(np.stack([probs[a:b].mean(0) for a, b in zip(bounds[:-1], bounds[1:])]), 1e-12))
    if melody is not None and fit:
        for i, (a, b) in enumerate(zip(bounds[:-1], bounds[1:])):
            w = melody[a:b].sum(0)
            if w.sum() > 0:
                score[i] += fit * (TONES @ w) / w.sum()
    stay, move = math.log1p(-change), math.log(change)
    delta = score[0].copy()
    back = np.zeros((len(starts), k), np.int32)
    for i in range(1, len(starts)):
        best = int(np.argmax(delta))
        take = delta[best] + move > delta + stay
        back[i] = np.where(take, best, np.arange(k))
        delta = np.where(take, delta[best] + move, delta + stay) + score[i]
    chosen = np.zeros(len(starts), np.int64)
    chosen[-1] = int(np.argmax(delta))
    for i in range(len(starts) - 1, 0, -1):
        chosen[i - 1] = back[i, chosen[i]]
    path = np.zeros(n, np.int64)
    for (a, b), c in zip(zip(bounds[:-1], bounds[1:]), chosen):
        path[a:b] = c
    return path


def chord_changes(path: np.ndarray, arrays: dict) -> dict[int, list[tuple[Fraction, int, int]]]:
    """{bar: [(offset in quarters, root, quality)]} for every change of the decoded path (bar offsets count
    from the bar's first sounding step, so a pickup bar starts at 0)."""
    out, previous = {}, None
    starts = arrays['starts']
    for t, cls in enumerate(path):
        cls = int(cls)
        if cls == previous:
            continue
        b = int(arrays['bar'][t])
        offset = Fraction(t - starts[b], 4)
        out.setdefault(b, []).append((offset, cls % 12, cls // 12))
        previous = cls
    return out


def harmonize(model: Harmonizer, info: dict, notes, bars, *, vocab=None, texture=None,
              rhythm: str = 'auto') -> tuple[dict, np.ndarray]:
    """Chords for a melody: ({bar: [(offset, root, quality)]}, per-step classes). `texture`: every note of the
    score (onset, duration, pitch), for a model trained with texture (harmonic analysis). `rhythm`: how often
    chords may change (RHYTHMS, see change_mask). `vocab` (v3.1 time vocabulary) snaps offsets to
    representable onsets."""
    arrays = melody_grid(notes, bars)
    if texture is not None and model.config.get('texture'):
        arrays.update(texture_grid(texture, len(arrays['bar'])))
    logp = posteriors(model, arrays)
    if rhythm == 'auto':
        path = viterbi(logp, arrays['level'], np.asarray(info['changeLogp']), info.get('viterbiPenalty', 1.))
    else:
        path = segment_viterbi(logp, change_mask(arrays, rhythm),
                               info.get('rhythmChange', RHYTHM_CHANGE).get(rhythm, RHYTHM_CHANGE[rhythm]),
                               melody_weights(arrays), info.get('rhythmFit', RHYTHM_FIT).get(rhythm, 0.))
    changes = chord_changes(path, arrays)
    if vocab is not None:
        changes = {b: [(vocab.value(vocab.lookup(o)[0]), r, q) for o, r, q in spans] for b, spans in changes.items()}
    return changes, path


# ====================================================================== training
def load_pieces(path: Path = CORPUS, texture: bool = False) -> list[dict]:
    """The Lieder joint corpus with a 'keysig' array per piece (notated key signatures, see keysig_cache) and,
    with `texture`, every note of the aligned scores (see texture_cache)."""
    from joint_data import load_corpus
    pieces = load_corpus(path)
    if not KEYSIG_CACHE.exists():
        keysig_cache(pieces)
    with np.load(KEYSIG_CACHE) as data:
        values, offsets = data['keysig'], data['offsets']
    if len(offsets) != len(pieces) + 1 or offsets[-1] != sum(len(p['arrays']['bar']) for p in pieces):
        raise ValueError(f'{KEYSIG_CACHE} does not match {path}; delete it to rebuild')
    for i, piece in enumerate(pieces):
        piece['arrays']['keysig'] = values[offsets[i]:offsets[i + 1]]
    if texture:
        if not TEXTURE_CACHE.exists():
            texture_cache(pieces)
        with np.load(TEXTURE_CACHE) as data:
            count, onset, bass, known, offsets = (data['count'], data['onset'], data['bass'], data['known'],
                                                   data['offsets'])
        if len(offsets) != len(pieces) + 1 or offsets[-1] != sum(len(p['arrays']['bar']) for p in pieces):
            raise ValueError(f'{TEXTURE_CACHE} does not match {path}; delete it to rebuild')
        for i, piece in enumerate(pieces):
            a, b = offsets[i], offsets[i + 1]
            piece['arrays'].update(tex_count=count[a:b], tex_onset=onset[a:b], tex_bass=bass[a:b],
                                   tex_known=int(known[i]))
    return pieces


def texture_cache(pieces, scores: Path = SCORES, out: Path = TEXTURE_CACHE) -> None:
    """Every note of the score (all parts) on the corpus grid, for pieces whose score timeline matches the
    corpus exactly (four_pillar_v1_alignment.verified_bar_steps); other pieces get known = 0."""
    import sqlite3
    import zlib
    from four_pillar_v1_alignment import verified_bar_steps
    from score_events_v2 import ScoreEvents
    db = sqlite3.connect(f'file:{scores}?mode=ro', uri=True)
    counts, onsets, basses, known, offsets = [], [], [], [], [0]
    for piece in pieces:
        n = len(piece['arrays']['bar'])
        grid = {'tex_count': np.zeros((n, 12), np.uint8), 'tex_onset': np.zeros(n, np.uint16),
                'tex_bass': np.full(n, NO_BASS, np.int8)}
        ok = 0
        row = db.execute('SELECT payload FROM scores WHERE score_id=?', (piece['meta']['scoreId'],)).fetchone()
        if row is not None:
            score = ScoreEvents.from_candidate(json.loads(zlib.decompress(row[0])))
            try:
                verified_bar_steps(score, piece)
                t0 = score.measures[0].onset
                grid = texture_grid([(e.onset - t0, e.duration, e.pitch) for e in score.events
                                     if e.pitch is not None and not e.grace and e.duration > 0], n)
                ok = 1
            except ValueError:
                pass
        counts.append(grid['tex_count'])
        onsets.append(grid['tex_onset'])
        basses.append(grid['tex_bass'])
        known.append(ok)
        offsets.append(offsets[-1] + n)
    np.savez_compressed(out, count=np.concatenate(counts), onset=np.concatenate(onsets),
                        bass=np.concatenate(basses), known=np.asarray(known, np.int8),
                        offsets=np.asarray(offsets, np.int64))


def keysig_cache(pieces, scores: Path = SCORES, out: Path = KEYSIG_CACHE) -> None:
    """Key signature (major-tonic pitch class, 12 = unknown) per corpus step, from the score database
    (bar n of the corpus = measure n of the score; pieces missing from the database stay unknown)."""
    import sqlite3
    import zlib
    from score_events_v2 import ScoreEvents
    db = sqlite3.connect(f'file:{scores}?mode=ro', uri=True)
    chunks, offsets = [], [0]
    for piece in pieces:
        bars = np.asarray(piece['arrays']['bar'])
        row = db.execute('SELECT payload FROM scores WHERE score_id=?', (piece['meta']['scoreId'],)).fetchone()
        values = np.full(len(bars), UNKNOWN_KEYSIG, np.int8)
        if row is not None:
            score = ScoreEvents.from_candidate(json.loads(zlib.decompress(row[0])))
            per_bar = [keysig_class((m.key or {}).get('fifths')) for m in score.measures]
            if per_bar:
                index = np.clip(bars, 0, len(per_bar) - 1)
                values = np.where(bars >= 0, np.asarray(per_bar, np.int8)[index], UNKNOWN_KEYSIG).astype(np.int8)
        chunks.append(values)
        offsets.append(offsets[-1] + len(bars))
    np.savez_compressed(out, keysig=np.concatenate(chunks), offsets=np.asarray(offsets, np.int64))


def windows(pieces, split: str, size: int, hop: int) -> list[tuple[int, int, int]]:
    """(piece, first step, end step): whole bars, at most `size` steps, starting every `hop` steps or so."""
    out = []
    for index, piece in enumerate(pieces):
        if piece['meta']['split'] != split:
            continue
        bar = piece['arrays']['bar']
        n = len(bar)
        starts = [0] + [t for t in range(1, n) if bar[t] != bar[t - 1]]
        last = -hop
        for i, a in enumerate(starts):
            if a - last < hop and a != 0:
                continue
            j = i
            while j + 1 < len(starts) and starts[j + 1] - a <= size:
                j += 1
            b = n if n - a <= size else (starts[j] if j > i else min(a + size, n))
            if b - a >= 16:
                out.append((index, a, b))
                last = a
            if b >= n:
                break
    return out


def batch(pieces, items, rng: np.random.Generator | None, texture_dropout: float = 0.):
    """Padded tensors for windows; random transposition in -6..5 when rng is given; the texture of a window is
    hidden with probability `texture_dropout` (so the model also learns melody-only harmonization)."""
    length = max(b - a for _, a, b in items)
    keys = ('pc', 'octave', 'onset', 'pos', 'level', 'meter', 'keysig', 'bass', 'known')
    x = {k: np.zeros((len(items), length), np.int64) for k in keys}
    x['texture'] = np.zeros((len(items), length, 24), np.float32)
    y = np.full((len(items), length), -100, np.int64)
    level = np.zeros((len(items), length), np.int64)
    padding = np.ones((len(items), length), bool)
    for row, (index, a, b) in enumerate(items):
        arrays = pieces[index]['arrays']
        shift = int(rng.integers(-6, 6)) if rng is not None else 0
        if rng is not None and texture_dropout and 'tex_count' in arrays and rng.random() < texture_dropout:
            arrays = {**arrays, 'tex_known': 0}
        for k, v in inputs(arrays, a, b, shift).items():
            x[k][row, :b - a] = v
        y[row, :b - a] = targets(arrays, a, b, shift)
        level[row, :b - a] = arrays['level'][a:b]
        padding[row, :b - a] = False
    return ({k: torch.as_tensor(v) for k, v in x.items()}, torch.as_tensor(y), torch.as_tensor(level),
            torch.as_tensor(padding))


def change_logp(pieces, split: str = 'train') -> list[float]:
    """log P(chord changes at a step | metric level), from the labels."""
    changes, counts = np.zeros(4), np.zeros(4)
    for piece in pieces:
        if piece['meta']['split'] != split:
            continue
        arrays = piece['arrays']
        y = targets(arrays, 0, len(arrays['bar']))
        level = np.asarray(arrays['level'])
        ok = (y[1:] >= 0) & (y[:-1] >= 0)
        for lv in range(4):
            sel = ok & (level[1:] == lv)
            counts[lv] += sel.sum()
            changes[lv] += (sel & (y[1:] != y[:-1])).sum()
    return [float(math.log(max(c, 1) / max(n, 1))) for c, n in zip(changes, counts)]


@torch.inference_mode()
def evaluate(model: Harmonizer, pieces, split: str, change: list[float] | None = None, penalty: float = 1.,
             texture: bool = True) -> dict:
    """Accuracy at every labelled step and at beats (downbeats and beats), argmax and (optionally) Viterbi."""
    model.eval()
    hit = {'step': [0, 0], 'beat': [0, 0], 'beatRoot': [0, 0], 'beatFamily': [0, 0]}
    if change is not None:
        hit.update({'viterbiBeat': [0, 0], 'viterbiStep': [0, 0]})
    for piece in pieces:
        if piece['meta']['split'] != split:
            continue
        arrays = piece['arrays']
        n = len(arrays['bar'])
        grid = {k: arrays[k] for k in ('bar', 'pos', 'meter', 'level', 'mel_pitch', 'mel_on', 'keysig', 'tex_count',
                                       'tex_onset', 'tex_bass', 'tex_known') if k in arrays}
        if not texture:
            grid['tex_known'] = 0
        logp = posteriors(model, grid)
        y = targets(arrays, 0, n)
        level = np.asarray(arrays['level'])
        ok = y >= 0
        beat = ok & (level <= 1)
        guess = logp.argmax(-1)
        hit['step'][0] += int((guess == y)[ok].sum())
        hit['step'][1] += int(ok.sum())
        hit['beat'][0] += int((guess == y)[beat].sum())
        hit['beat'][1] += int(beat.sum())
        hit['beatRoot'][0] += int((guess % 12 == y % 12)[beat].sum())
        hit['beatRoot'][1] += int(beat.sum())
        same_family = (guess % 12 == y % 12) & (FAMILY[guess // 12] == FAMILY[np.maximum(y, 0) // 12])
        hit['beatFamily'][0] += int(same_family[beat].sum())
        hit['beatFamily'][1] += int(beat.sum())
        if change is not None:
            path = viterbi(logp, level, np.asarray(change), penalty)
            hit['viterbiStep'][0] += int((path == y)[ok].sum())
            hit['viterbiStep'][1] += int(ok.sum())
            hit['viterbiBeat'][0] += int((path == y)[beat].sum())
            hit['viterbiBeat'][1] += int(beat.sum())
    return {k: round(a / max(b, 1), 4) for k, (a, b) in hit.items()} | {'steps': hit['step'][1]}


def train(args) -> None:
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    run = args.run_dir
    run.mkdir(parents=True, exist_ok=True)
    config = {**CONFIG, 'texture': bool(args.texture)}
    pieces = load_pieces(texture=args.texture)
    train_windows = windows(pieces, 'train', CONFIG['steps'], args.hop)
    model = Harmonizer(config)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    state = {'step': 0, 'best': -1., 'order': None, 'cursor': 0}
    checkpoint = run / 'checkpoint.pt'
    if args.resume and checkpoint.exists():
        saved = torch.load(checkpoint, map_location='cpu', weights_only=False)
        model.load_state_dict(saved['model'])
        optimizer.load_state_dict(saved['optimizer'])
        state = saved['state']
        rng = np.random.Generator(np.random.PCG64())
        rng.bit_generator.state = saved['rng']
    elif checkpoint.exists():
        raise SystemExit(f'{checkpoint} exists: pass --resume or use a new --run-dir')
    else:
        rng = np.random.Generator(np.random.PCG64(args.seed))
    change = change_logp(pieces)
    parameters = sum(p.numel() for p in model.parameters())
    log = (run / 'train.log').open('a')
    log.write(json.dumps({'event': 'start', 'step': state['step'], 'windows': len(train_windows),
                          'parameters': parameters, 'changeLogp': change, 'args': {k: str(v) for k, v in
                                                                                   vars(args).items()}}) + '\n')
    loss_fn = nn.CrossEntropyLoss(ignore_index=-100, label_smoothing=args.smoothing)
    started, recent = time.time(), []
    while state['step'] < args.steps:
        if state['order'] is None or state['cursor'] >= len(state['order']):
            state['order'] = rng.permutation(len(train_windows)).tolist()
            state['cursor'] = 0
        items = [train_windows[i] for i in state['order'][state['cursor']:state['cursor'] + args.batch]]
        state['cursor'] += args.batch
        warm = min(1., (state['step'] + 1) / args.warmup)
        cosine = .5 * (1 + math.cos(math.pi * min(1., state['step'] / args.steps)))
        for group in optimizer.param_groups:
            group['lr'] = args.lr * warm * (.05 + .95 * cosine)
        model.train()
        x, y, _, padding = batch(pieces, items, rng, args.texture_dropout if args.texture else 0.)
        loss = loss_fn(model(x, padding).reshape(-1, N_CLASSES), y.reshape(-1))
        optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1.)
        optimizer.step()
        state['step'] += 1
        recent.append(float(loss.detach()))
        if state['step'] % args.log_every == 0:
            log.write(json.dumps({'step': state['step'], 'loss': round(float(np.mean(recent)), 4),
                                  'lr': optimizer.param_groups[0]['lr'],
                                  'seconds': round(time.time() - started, 1)}) + '\n')
            log.flush()
            recent = []
        if state['step'] % args.eval_every == 0 or state['step'] == args.steps:
            metrics = evaluate(model, pieces, 'validation')
            if args.texture:
                metrics['melodyOnly'] = evaluate(model, pieces, 'validation', texture=False)
            better = metrics['beat'] > state['best']
            if better:
                state['best'] = metrics['beat']
                save(model, run / 'weights.pt', {'step': state['step'], 'validation': metrics,
                                                 'changeLogp': change, 'parameters': parameters})
            log.write(json.dumps({'step': state['step'], 'validation': metrics, 'best': better}) + '\n')
            log.flush()
        if state['step'] % args.checkpoint_every == 0 or state['step'] == args.steps:
            torch.save({'model': model.state_dict(), 'optimizer': optimizer.state_dict(), 'state': state,
                        'rng': rng.bit_generator.state}, run / 'checkpoint.tmp')
            (run / 'checkpoint.tmp').replace(checkpoint)
    log.write(json.dumps({'event': 'done', 'step': state['step'], 'bestValidationBeat': state['best']}) + '\n')
    log.close()


def tune_decoding(run: Path, threads: int = 2) -> dict:
    """Pick the Viterbi change penalty on the validation split and store it with the best weights."""
    torch.set_num_threads(threads)
    model, info = load(run / 'weights.pt')
    pieces = load_pieces(texture=bool(model.config.get('texture')))
    results = {}
    for penalty in (0., .25, .5, .75, 1.):
        results[penalty] = evaluate(model, pieces, 'validation', info['changeLogp'], penalty)
    best = max(results, key=lambda p: results[p]['viterbiBeat'])
    extra = {k: v for k, v in info.items() if k not in ('schema', 'config')}
    extra.update(viterbiPenalty=best, decodingValidation={str(p): r for p, r in results.items()})
    save(model, run / 'weights.pt', extra)
    return {'viterbiPenalty': best, 'validation': results[best]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--tune-decoding', action='store_true', help='after training: pick the Viterbi penalty')
    parser.add_argument('--steps', type=int, default=4000)
    parser.add_argument('--batch', type=int, default=16)
    parser.add_argument('--hop', type=int, default=64, help='window start spacing in steps (training windows)')
    parser.add_argument('--lr', type=float, default=1e-3)
    parser.add_argument('--warmup', type=int, default=200)
    parser.add_argument('--smoothing', type=float, default=.05)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--log-every', type=int, default=50)
    parser.add_argument('--eval-every', type=int, default=500)
    parser.add_argument('--checkpoint-every', type=int, default=100)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--texture', action='store_true', help='also read every note of the score (analysis model)')
    parser.add_argument('--texture-dropout', type=float, default=.3)
    args = parser.parse_args()
    if args.tune_decoding:
        print(json.dumps(tune_decoding(args.run_dir, args.threads)))
    else:
        train(args)


if __name__ == '__main__':
    main()
