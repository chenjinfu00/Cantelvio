#!/usr/bin/env python3
"""AIlegro note filler v1: the notes a transcription missed, read from the score around them.

audio_to_score.py turns a transcription into a score and keeps the notes that belong there, but a note the
transcription model never heard cannot be kept. This model reads the cleaned score at every onset and at every
point of the beat's grid (the notes starting and sounding there, the analysed chord, the place in the bar, and the
whole excerpt around it through a transformer) and gives, for every pitch, the probability that the original
score has a note starting there. Pitches the score lacks whose probability passes a threshold are added
(`added='filler'`), to the part that plays nearest to them.

Training data: the AIlegro score database (the Lieder train split, the string quartet movements outside the
evaluation and tuning sets, the orchestral scores) "performed" and "transcribed" by eval_audio_to_score.py's
simulation (normal and fast-passage errors, some with beat-tracker slips) and cleaned by audio_to_score.py with
AIlegro's harmonic analysis; the target is the original score. Pitches are moved to C major / A minor (the
estimated key). The threshold is chosen on the tuning set (Lieder validation songs and other quartet movements).

    .venv-training/bin/python training/scripts/note_filler_v1.py data --out training/data/note-filler-v1.npz
    .venv-training/bin/python training/scripts/note_filler_v1.py train --data training/data/note-filler-v1.npz \\
        --run-dir training/runs/note-filler-v1-20261004
    .venv-training/bin/python training/scripts/note_filler_v1.py tune --run-dir training/runs/note-filler-v1-20261004
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
import time
import zlib
from collections import Counter, defaultdict
from fractions import Fraction as F
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_to_score as a2s  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 'ailegro.note-filler/1'
DEFAULT_WEIGHTS = ROOT / 'runs/note-filler-v1-20261004/weights.pt'
LOW, HIGH = 21, 108                      # piano range: one output per pitch
PITCHES = HIGH - LOW + 1
MAX_TOKENS = 384                         # tokens per window (training crop and inference window)
BEATS_IN_BAR = 8                         # beat-in-bar one-hot size (later beats share the last slot)
TOKEN_FEATURES = 2 * PITCHES + 12 + 1 + 1 + BEATS_IN_BAR + a2s.DIVISIONS + 1 + 2
LOCAL_FEATURES = 17
MAJOR = (0, 2, 4, 5, 7, 9, 11)
SCALE = np.zeros(12, np.float32)         # C major plus A minor's raised sixth and seventh (F#, G#)
SCALE[list(MAJOR) + [6, 8]] = 1


# ====================================================================== the cleaned score as tokens
def key_shift(fifths: int) -> int:
    """Semitones that move the key's major tonic to C (-6..5)."""
    s = (-(fifths * 7)) % 12
    return s - 12 if s > 5 else s


def frame(notes, score: 'a2s.Score', chords: dict | None) -> dict | None:
    """Tokens (every onset of the live notes and every point of the beat's grid, in beats from the score's start)
    and what the model reads at each: note starts and sounding notes (pitches moved to the key of C), the analysed
    chord, the place in the bar and beat, the spacing; plus the token index one and two beats and a bar away."""
    live = [n for n in notes if not n.removed]
    if not live:
        return None
    bq = score.beat_quarters
    shift = key_shift(score.fifths)
    times = {n.on / bq for n in live}
    first = math.floor(min(times))
    last = math.ceil(max((n.on + n.dur) / bq for n in live))
    for k in range(first, last):
        s = score.subdivision.get(k, 1)
        times.update(k + F(j, s) for j in range(s))
    tok = sorted(times)
    index = {t: i for i, t in enumerate(tok)}
    t_float = np.array([float(t) for t in tok])
    T = len(tok)
    # notes: start token, end token (first token at or after the release), pitch index
    starts, ends, pitch = [], [], []
    for n in live:
        q = n.pitch + shift - LOW
        if not 0 <= q < PITCHES:
            continue
        a = index[n.on / bq]
        b = int(np.searchsorted(t_float, float((n.on + n.dur) / bq) - 1e-9))
        starts.append(a)
        ends.append(max(b, a + 1))
        pitch.append(q)
    # metre: beats from the bar's start, position in the beat
    bar_beats = score.beats_per_bar
    pickup_beats = score.pickup / bq
    beat_in_bar = np.zeros(T, np.int16)
    frac = np.zeros(T, np.int16)
    for i, t in enumerate(tok):
        b = t - pickup_beats if pickup_beats else t
        beat_in_bar[i] = min(int(math.floor(b)) % bar_beats if b >= 0 else int(math.floor(t)), BEATS_IN_BAR - 1)
        frac[i] = int(round(float(t - math.floor(t)) * a2s.DIVISIONS)) % a2s.DIVISIONS
    chord = np.zeros(T, np.int32)                 # 12-bit pitch-class mask (key of C)
    if chords:
        for i, t in enumerate(tok):
            tones = chords.get(int(t * bq * 4))
            if tones:
                chord[i] = sum(1 << ((pc + shift) % 12) for pc in tones)
    onset = np.zeros(T, np.uint8)
    onset[sorted(set(starts))] = 1

    def away(delta: F) -> np.ndarray:
        return np.array([index.get(t + delta, -1) for t in tok], np.int32)

    bar = F(bar_beats)
    return {'time': t_float.astype(np.float32), 'onset': onset, 'beat': beat_in_bar, 'frac': frac,
            'chord': chord, 'noteStart': np.array(starts, np.int32), 'noteEnd': np.array(ends, np.int32),
            'notePitch': np.array(pitch, np.int16),
            'away': np.stack([away(F(-1)), away(F(1)), away(F(-2)), away(F(2)), away(-bar), away(bar)]),
            'minor': int(score.mode == 'minor'), 'compound': int(score.compound), 'shift': shift,
            'times': tok}


def rolls(f: dict, a: int, b: int) -> tuple[np.ndarray, np.ndarray]:
    """Start and sounding rolls [tokens, pitches] of tokens a..b."""
    n = b - a
    start = np.zeros((n, PITCHES), np.float32)
    sound = np.zeros((n, PITCHES), np.float32)
    for s, e, q in zip(f['noteStart'], f['noteEnd'], f['notePitch']):
        if e <= a or s >= b:
            continue
        if a <= s < b:
            start[s - a, q] = 1
        lo, hi = max(s + 1, a), min(e, b)
        if lo < hi:
            sound[lo - a:hi - a, q] = 1
    return start, sound


def features(f: dict, a: int, b: int) -> tuple[np.ndarray, np.ndarray]:
    """Token features [n, TOKEN_FEATURES] and local features [n, PITCHES, LOCAL_FEATURES] of tokens a..b."""
    n = b - a
    start, sound = rolls(f, a, b)
    chord = ((f['chord'][a:b, None] >> np.arange(12)) & 1).astype(np.float32)          # [n, 12]
    beat = np.zeros((n, BEATS_IN_BAR), np.float32)
    beat[np.arange(n), f['beat'][a:b]] = 1
    frac = np.zeros((n, a2s.DIVISIONS), np.float32)
    frac[np.arange(n), f['frac'][a:b]] = 1
    t = f['time']
    dt_prev = np.diff(t[a:b], prepend=t[a - 1] if a > 0 else t[a] - 1)
    dt_next = np.diff(t[a:b], append=t[b] if b < len(t) else t[b - 1] + 1)
    spacing = np.log2(np.clip(np.stack([dt_prev, dt_next], 1), 1 / 32, 8)) / 5
    tokens = np.concatenate([start, sound, chord, np.full((n, 1), f['minor'], np.float32),
                             np.full((n, 1), f['compound'], np.float32), beat, frac,
                             f['onset'][a:b, None].astype(np.float32), spacing.astype(np.float32)], 1)
    # local evidence per pitch
    loc = np.zeros((n, PITCHES, LOCAL_FEATURES), np.float32)
    loc[..., 0] = start
    loc[..., 1] = sound
    loc[1:, :, 2] = start[:-1]
    loc[:-1, :, 3] = start[1:]
    for j in range(6):                                                  # a beat, two beats, a bar away
        idx = f['away'][j, a:b] - a
        ok = (idx >= 0) & (idx < n)
        loc[ok, :, 4 + j] = start[idx[ok]]
    octave = np.zeros_like(start)
    octave[:, 12:] = np.maximum(octave[:, 12:], start[:, :-12])
    octave[:, :-12] = np.maximum(octave[:, :-12], start[:, 12:])
    loc[..., 10] = octave
    pc = (np.arange(PITCHES) + LOW) % 12
    loc[..., 11] = chord[:, pc]
    loc[..., 12] = SCALE[pc][None, :]
    has = start.any(1)
    pos = np.arange(PITCHES)
    dist = np.full((n, PITCHES), 12., np.float32)
    lo_p = np.full(n, PITCHES, np.int64)
    hi_p = np.full(n, -1, np.int64)
    for i in np.nonzero(has)[0]:
        ps = np.nonzero(start[i])[0]
        dist[i] = np.min(np.abs(pos[:, None] - ps[None, :]), 1)
        lo_p[i], hi_p[i] = ps.min(), ps.max()
    loc[..., 13] = np.minimum(dist, 12) / 12
    loc[..., 14] = (pos[None, :] >= lo_p[:, None]) & (pos[None, :] <= hi_p[:, None])
    loc[..., 15] = start.sum(1, keepdims=True) / 6
    near = np.zeros_like(start)
    for d in (1, 2):
        near[:, d:] = np.maximum(near[:, d:], start[:, :-d])
        near[:, :-d] = np.maximum(near[:, :-d], start[:, d:])
    loc[..., 16] = near
    return tokens.astype(np.float32), loc


# ====================================================================== the model
def _torch():
    import torch
    from torch import nn
    return torch, nn


def build_model(config: dict):
    torch, nn = _torch()

    class NoteFiller(nn.Module):
        """Transformer over the tokens; per pitch, a logit from the token's context plus a small network over the
        pitch's local evidence (repeats a beat or a bar away, the chord, the neighbours at the same onset)."""

        def __init__(self, d: int = 128, layers: int = 4, heads: int = 4, ff: int = 256, dropout: float = .1,
                     context: int = 32, hidden: int = 64):
            super().__init__()
            self.config = {'d': d, 'layers': layers, 'heads': heads, 'ff': ff, 'dropout': dropout,
                           'context': context, 'hidden': hidden}
            self.inp = nn.Linear(TOKEN_FEATURES, d)
            layer = nn.TransformerEncoderLayer(d, heads, ff, dropout, batch_first=True, norm_first=True)
            self.enc = nn.TransformerEncoder(layer, layers, enable_nested_tensor=False)
            self.norm = nn.LayerNorm(d)
            self.glob = nn.Linear(d, PITCHES)
            self.ctx = nn.Linear(d, context)
            self.local = nn.Sequential(nn.Linear(context + 12 + 1 + LOCAL_FEATURES, hidden), nn.GELU(),
                                       nn.Linear(hidden, hidden), nn.GELU(), nn.Linear(hidden, 1))
            pitch = torch.arange(PITCHES)
            pc = torch.nn.functional.one_hot((pitch + LOW) % 12, 12).float()
            height = ((pitch + LOW - 60) / 24.).float()[:, None]
            self.register_buffer('pitch_features', torch.cat([pc, height], 1), persistent=False)

        def positions(self, n: int, d: int):
            pos = torch.arange(n, dtype=torch.float32)[:, None]
            i = torch.arange(0, d, 2, dtype=torch.float32)[None, :]
            angle = pos / (10000 ** (i / d))
            out = torch.zeros(n, d)
            out[:, 0::2], out[:, 1::2] = torch.sin(angle), torch.cos(angle)
            return out

        def forward(self, tokens, local, mask):
            """tokens [B, T, TOKEN_FEATURES], local [B, T, P, LOCAL_FEATURES], mask [B, T] (True = padding)."""
            B, T, _ = tokens.shape
            h = self.inp(tokens) + self.positions(T, self.inp.out_features).to(tokens.device)[None]
            h = self.norm(self.enc(h, src_key_padding_mask=mask))
            ctx = self.ctx(h)[:, :, None, :].expand(B, T, PITCHES, -1)
            pf = self.pitch_features[None, None].expand(B, T, -1, -1)
            loc = self.local(torch.cat([ctx, pf, local], -1)).squeeze(-1)
            return self.glob(h) + loc

    return NoteFiller(**config)


def save(model, path: Path, extra: dict) -> None:
    torch, _ = _torch()
    torch.save({'schema': SCHEMA, 'config': model.config, 'state': model.state_dict(), **extra}, path)


def load(path: Path | str | None = None):
    """(model, info) or None when torch or the weights are missing."""
    path = Path(path) if path else DEFAULT_WEIGHTS
    try:
        torch, _ = _torch()
    except ImportError:
        return None
    if not path.exists():
        return None
    data = torch.load(path, map_location='cpu', weights_only=False)
    if data.get('schema') != SCHEMA:
        raise ValueError(f'{path} is not a {SCHEMA} model')
    model = build_model(data['config'])
    model.load_state_dict(data['state'])
    model.eval()
    return model, {k: v for k, v in data.items() if k not in ('state', 'config')}


def predict(model, f: dict, window: int = MAX_TOKENS, hop: int = 256) -> np.ndarray:
    """Probability [tokens, pitches] of a note starting, in overlapping windows (each token from the window
    where it is furthest from an edge)."""
    torch, _ = _torch()
    T = len(f['time'])
    out = np.zeros((T, PITCHES), np.float32)
    best = np.full(T, -1.)
    starts = list(range(0, max(T - window, 0) + 1, hop))
    if starts[-1] + window < T:
        starts.append(T - window)
    with torch.no_grad():
        for a in starts:
            b = min(a + window, T)
            tok, loc = features(f, a, b)
            logits = model(torch.from_numpy(tok)[None], torch.from_numpy(loc)[None],
                           torch.zeros(1, b - a, dtype=torch.bool))[0]
            p = torch.sigmoid(logits).numpy()
            margin = np.minimum(np.arange(b - a), (b - a - 1) - np.arange(b - a))   # tokens from the nearer edge
            if a == 0:
                margin = np.maximum(margin, (b - a - 1) - np.arange(b - a))
            if b == T:
                margin = np.maximum(margin, np.arange(b - a))
            take = margin > best[a:b]
            out[a:b][take] = p[take]
            best[a:b][take] = margin[take]
    return out


# ====================================================================== adding the notes
class Filler:
    """audio_to_score's `filler`: adds the pitches whose probability passes the threshold and that the score lacks
    at that time; each goes to the part with the nearest note starting there (or sounding, or starting just before
    or after), lasts like that note (or until the part's next onset), and a single line (a voice, a wind) takes no
    second note at one time."""

    def __init__(self, model, info: dict, threshold: float | None = None):
        self.model, self.info = model, info
        self.threshold = threshold if threshold is not None else float(info.get('threshold', .5))

    def __call__(self, notes, score, chords, seconds) -> Counter:
        f = frame(notes, score, chords)
        if f is None:
            return Counter()
        prob = predict(self.model, f)
        start, _ = rolls(f, 0, len(f['time']))
        live = [n for n in notes if not n.removed]
        bq = score.beat_quarters
        by_time = defaultdict(list)
        for n in live:
            by_time[n.on / bq].append(n)
        times = f['times']
        added = []
        for i, q in zip(*np.nonzero((prob >= self.threshold) & (start == 0))):
            t = times[i]
            pitch = int(q) + LOW - f['shift']
            on = t * bq
            near = by_time.get(t) or [n for n in live if n.on < on < n.on + n.dur]
            if not near:
                around = [times[j] for j in (i - 1, i + 1) if 0 <= j < len(times) and by_time.get(times[j])]
                near = [n for u in around for n in by_time[u]]
            near = [n for n in near if a2s.POLYPHONY.get(score.parts[n.part].instrument) != 1
                    or not any(m.part == n.part and m.on == on for m in live + added)]
            if not near:
                continue
            ref = min(near, key=lambda n: abs(n.pitch - pitch))
            if ref.on == on:
                dur = ref.dur
            else:
                later = sorted({n.on for n in live if n.part == ref.part and n.on > on})
                dur = (later[0] - on) if later else bq
            start_s = float(seconds(float(on)))
            note = a2s.Note(start_s, max(float(seconds(float(on + dur))), start_s + .05), pitch, ref.instrument,
                            on=on, dur=dur, part=ref.part, added='filler')
            added.append(note)
        notes.extend(added)
        return Counter({'filler': len(added)})


def load_filler(path: str | None = None, threshold: float | None = None) -> Filler | None:
    """The note filler, or None when torch or the weights are missing (path 'none': no filler)."""
    if path == 'none':
        return None
    found = load(path)
    return Filler(*found, threshold=threshold) if found else None


# ====================================================================== training data
def piece_sets(db) -> dict[str, list[str]]:
    """Score ids by use. Evaluation (eval_audio_to_score.py, seed 1): 30 Lieder of the test split and 10 quartet
    movements; tuning (the run work and this model's threshold): 40 Lieder of the validation split and 16 other
    quartet movements; training: the Lieder train split, the remaining quartet movements, the orchestral scores."""
    import harmonizer_v1 as hz
    pieces = hz.load_pieces()
    by_split = defaultdict(list)
    for p in pieces:
        by_split[p['meta']['split']].append(p['meta']['scoreId'])
    quartets = [sid for sid, in db.execute("SELECT score_id FROM scores WHERE source='classical-scores' "
                                            "AND score_id LIKE '%StringQuartets%' ORDER BY score_id")]
    rng = np.random.default_rng(1)
    test = list(by_split['test'])
    rng.shuffle(test)
    rng.shuffle(quartets)
    held = quartets[:10]
    validation = list(by_split['validation'])
    r2 = np.random.default_rng(2)
    r2.shuffle(validation)
    others = [q for q in quartets if q not in set(held)]
    r2.shuffle(others)
    orchestra = [sid for sid, in db.execute("SELECT score_id FROM scores WHERE source='classical-scores' "
                                             "AND score_id NOT LIKE '%StringQuartets%' ORDER BY score_id")]
    return {'evalLieder': test[:30], 'evalQuartets': held, 'tuningLieder': validation[:40],
            'tuningQuartets': others[:16], 'trainLieder': sorted(by_split['train']),
            'trainQuartets': sorted(others[16:]), 'orchestra': orchestra}


def tuning_cases(db, fast: bool) -> list[dict]:
    """The tuning set (40 Lieder validation songs, 16 quartet movements), simulated as in the run work."""
    import eval_audio_to_score as ev
    sets = piece_sets(db)
    out = []
    for name, ids in (('lieder', sets['tuningLieder']), ('quartets', sets['tuningQuartets'])):
        for sid in ids:
            se = ev.load_score(db, sid)
            if len(se.measures) < 8:
                continue
            prng = np.random.default_rng(zlib.crc32(f'{sid}:2:{"fast" if fast else False}'.encode()))
            doc, truth, durations, meter = ev.simulate(se, 24, prng, fast_errors=fast)
            out.append({'name': name, 'sid': sid, 'doc': doc, 'truth': truth, 'durations': durations,
                        'meter': meter, 'runs': ev.run_truth(se, 24)})
    return out


class Recorder:
    """A `filler` that adds nothing and keeps the frame of the cleaned score with its targets."""

    def __init__(self, truth: set):
        self.truth, self.frame = truth, None

    def __call__(self, notes, score, chords, seconds) -> Counter:
        f = frame(notes, score, chords)
        if f is None or score.downbeat is None:
            return Counter()
        anchor = score.downbeat / score.beat_quarters
        index = {t: i for i, t in enumerate(f['times'])}
        pos, missed = [], 0
        for b, p in self.truth:
            i = index.get(b + anchor)
            q = p + f['shift'] - LOW
            if i is None or not 0 <= q < PITCHES:
                missed += 1
                continue
            pos.append((i, q))
        f['target'] = np.array(sorted(pos), np.int32).reshape(-1, 2)
        f['unreachable'] = missed
        self.frame = f
        return Counter()


def _make(job) -> dict | None:
    import eval_audio_to_score as ev
    name, sid, start, cond, seed = job
    global _DB, _MODEL
    if '_DB' not in globals():
        import torch
        torch.set_num_threads(1)
        _DB = sqlite3.connect(f'file:{ev.SCORES}?mode=ro', uri=True)
        _MODEL = a2s.load_chords_model(None)
    se = ev.load_score(_DB, sid)
    if len(se.measures) < start + 8:
        return None
    rng = np.random.default_rng(seed)
    try:
        doc, truth, _, _ = ev.simulate(se, 24, rng, hard_beats=cond == 'hard', fast_errors=cond == 'fast',
                                       start=start)
        rec = Recorder(truth)
        a2s.transcription_to_score(doc, chords_model=_MODEL, filler=rec)
    except (ValueError, StopIteration, IndexError, ZeroDivisionError):
        return None
    f = rec.frame
    if f is None:
        return None
    f.pop('times')
    f.update(name=name, sid=sid, start=start, cond=cond, truth=len(truth))
    return f


def make_data(out: Path, workers: int = 2, limit: int | None = None) -> None:
    import multiprocessing as mp

    import eval_audio_to_score as ev
    db = sqlite3.connect(f'file:{ev.SCORES}?mode=ro', uri=True)
    sets = piece_sets(db)
    pieces = [('lieder', s) for s in sets['trainLieder']] + [('quartets', s) for s in sets['trainQuartets']] + \
        [('orchestra', s) for s in sets['orchestra']]
    jobs = []
    rng = np.random.default_rng(7)
    for name, sid in pieces:
        bars = int(db.execute('SELECT bars FROM scores WHERE score_id=?', (sid,)).fetchone()[0] or 0)
        starts = {'lieder': (0, 24), 'quartets': (0, 24, 48), 'orchestra': (0, 24)}[name]
        conds = ('normal', 'fast') if name != 'orchestra' else ('normal',)
        for start in starts:
            if start and bars < start + 16:
                continue
            for cond in conds:
                if cond == 'normal' and rng.random() < .2:
                    cond = 'hard'
                jobs.append((name, sid, start, cond, int(rng.integers(1 << 31))))
    if limit:
        jobs = jobs[:limit]
    print(len(pieces), 'pieces', len(jobs), 'excerpts', flush=True)
    t0 = time.time()
    frames = []
    with mp.get_context('fork').Pool(workers) as pool:
        for k, f in enumerate(pool.imap(_make, jobs, chunksize=4)):
            if f is not None:
                frames.append(f)
            if (k + 1) % 200 == 0:
                print(k + 1, 'done', len(frames), 'kept', round(time.time() - t0), 's', flush=True)
    save_frames(frames, out)
    print('saved', len(frames), 'frames to', out, round(time.time() - t0), 's')


ARRAYS = ('time', 'onset', 'beat', 'frac', 'chord', 'noteStart', 'noteEnd', 'notePitch', 'target')


def save_frames(frames: list[dict], out: Path) -> None:
    data = {}
    for key in ARRAYS:
        parts = [f[key] for f in frames]
        data[key] = np.concatenate(parts) if parts else np.zeros(0)
        data[key + 'Len'] = np.array([len(p) for p in parts], np.int64)
    data['away'] = np.concatenate([f['away'] for f in frames], 1)
    meta = [{k: f[k] for k in ('name', 'sid', 'start', 'cond', 'truth', 'unreachable', 'minor', 'compound',
                               'shift')} for f in frames]
    data['meta'] = np.array(json.dumps(meta))
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, **data)


def load_frames(path: Path) -> list[dict]:
    with np.load(path) as data:                     # each access of an npz member decompresses it: read once
        arrays = {k: data[k] for k in data.files}
    meta = json.loads(str(arrays['meta']))
    offsets = {k: np.concatenate([[0], np.cumsum(arrays[k + 'Len'])]) for k in ARRAYS}
    frames = []
    away = arrays['away']
    for i, m in enumerate(meta):
        f = dict(m)
        for k in ARRAYS:
            f[k] = arrays[k][offsets[k][i]:offsets[k][i + 1]]
        a, b = offsets['time'][i], offsets['time'][i + 1]
        f['away'] = away[:, a:b]
        f['target'] = f['target'].reshape(-1, 2)
        frames.append(f)
    return frames


# ====================================================================== training
def batch(frames: list[dict], items: list[tuple[int, int]], window: int = MAX_TOKENS):
    torch, _ = _torch()
    tok_list, loc_list, tgt_list = [], [], []
    for k, a in items:
        f = frames[k]
        b = min(a + window, len(f['time']))
        tok, loc = features(f, a, b)
        tgt = np.zeros((b - a, PITCHES), np.float32)
        t = f['target']
        sel = (t[:, 0] >= a) & (t[:, 0] < b)
        tgt[t[sel, 0] - a, t[sel, 1]] = 1
        tok_list.append(tok)
        loc_list.append(loc)
        tgt_list.append(tgt)
    n = max(len(t) for t in tok_list)
    B = len(items)
    tok = np.zeros((B, n, TOKEN_FEATURES), np.float32)
    loc = np.zeros((B, n, PITCHES, LOCAL_FEATURES), np.float32)
    tgt = np.zeros((B, n, PITCHES), np.float32)
    mask = np.ones((B, n), bool)
    for i, (a, b, c) in enumerate(zip(tok_list, loc_list, tgt_list)):
        tok[i, :len(a)], loc[i, :len(a)], tgt[i, :len(a)], mask[i, :len(a)] = a, b, c, False
    return (torch.from_numpy(tok), torch.from_numpy(loc), torch.from_numpy(tgt), torch.from_numpy(mask))


def split_frames(frames: list[dict], share: float = .05) -> tuple[list[int], list[int]]:
    """Validation pieces (by score id): about `share` of them."""
    held = [i for i, f in enumerate(frames) if zlib.crc32(f['sid'].encode()) % 1000 < share * 1000]
    held_set = set(held)
    return [i for i in range(len(frames)) if i not in held_set], held


def evaluate_frames(model, frames: list[dict], ids: list[int]) -> dict:
    """On the missing notes (pitches the cleaned score lacks at a token): average precision, and the added notes
    and their precision at a few thresholds; loss over everything."""
    scores, labels, loss, count = [], [], 0., 0
    for k in ids:
        f = frames[k]
        prob = predict(model, f)
        start, _ = rolls(f, 0, len(f['time']))
        tgt = np.zeros_like(prob)
        t = f['target']
        tgt[t[:, 0], t[:, 1]] = 1
        p = np.clip(prob, 1e-6, 1 - 1e-6)
        loss += float(-(tgt * np.log(p) + (1 - tgt) * np.log(1 - p)).sum())
        count += p.size
        absent = start == 0
        scores.append(prob[absent])
        labels.append(tgt[absent])
    s, y = np.concatenate(scores), np.concatenate(labels)
    order = np.argsort(-s)
    hits = np.cumsum(y[order])
    precision = hits / np.arange(1, len(s) + 1)
    ap = float((precision * y[order]).sum() / max(y.sum(), 1))
    out = {'loss': loss / max(count, 1), 'missing': int(y.sum()), 'ap': round(ap, 4)}
    for th in (.3, .4, .5, .6, .7):
        sel = s >= th
        out[f'add@{th}'] = int(sel.sum())
        out[f'precision@{th}'] = round(float(y[sel].mean()) if sel.any() else 0., 4)
    return out


def train(args) -> None:
    torch, nn = _torch()
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    frames = load_frames(args.data)
    train_ids, held = split_frames(frames)
    print(len(frames), 'frames:', len(train_ids), 'train,', len(held), 'validation', flush=True)
    run = args.run_dir
    run.mkdir(parents=True, exist_ok=True)
    model = build_model({'d': args.d, 'layers': args.layers, 'heads': args.heads, 'ff': 2 * args.d,
                         'dropout': args.dropout})
    params = sum(p.numel() for p in model.parameters())
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=.01)
    state = {'step': 0, 'best': None, 'log': []}
    checkpoint = run / 'checkpoint.pt'
    if args.resume and checkpoint.exists():
        saved = torch.load(checkpoint, map_location='cpu', weights_only=False)
        model.load_state_dict(saved['model'])
        optimizer.load_state_dict(saved['optimizer'])
        state = saved['state']
        print('resumed at step', state['step'], flush=True)
    rng = np.random.default_rng(args.seed + state['step'])
    lengths = np.array([len(frames[i]['time']) for i in train_ids])
    weights = lengths / lengths.sum()
    loss_fn = nn.BCEWithLogitsLoss(reduction='none')
    t0 = time.time()
    running = []
    while state['step'] < args.steps:
        step = state['step']
        lr = args.lr * min(1., (step + 1) / args.warmup) * .5 * (1 + math.cos(math.pi * step / args.steps))
        for g in optimizer.param_groups:
            g['lr'] = lr
        items = []
        for k in rng.choice(len(train_ids), size=args.batch, p=weights):
            i = train_ids[k]
            T = len(frames[i]['time'])
            items.append((i, int(rng.integers(0, max(T - MAX_TOKENS, 0) + 1))))
        tok, loc, tgt, mask = batch(frames, items)
        model.train()
        logits = model(tok, loc, mask)
        raw = loss_fn(logits, tgt)
        weight = (~mask)[:, :, None].float() * (1 + (args.missing_weight - 1) * tgt * (1 - loc[..., 0]))
        loss = (raw * weight).sum() / weight.sum()
        optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1.)
        optimizer.step()
        running.append(loss.item())
        state['step'] += 1
        if state['step'] % args.log_every == 0:
            print(f'step {state["step"]} loss {np.mean(running):.5f} lr {lr:.2e} {time.time() - t0:.0f}s', flush=True)
            state['log'].append({'step': state['step'], 'loss': float(np.mean(running))})
            running = []
        if state['step'] % args.eval_every == 0 or state['step'] == args.steps:
            model.eval()
            metrics = evaluate_frames(model, frames, held)
            print('validation', state['step'], json.dumps(metrics), flush=True)
            state['log'][-1:] = [dict(state['log'][-1], validation=metrics)] if state['log'] else []
            if state['best'] is None or metrics['ap'] > state['best']['ap']:
                state['best'] = dict(metrics, step=state['step'])
                save(model, run / 'weights.pt', {'step': state['step'], 'validation': metrics, 'parameters': params,
                                                 'data': str(args.data), 'frames': len(frames)})
        if state['step'] % args.checkpoint_every == 0:
            torch.save({'model': model.state_dict(), 'optimizer': optimizer.state_dict(), 'state': state},
                       checkpoint)
    (run / 'log.json').write_text(json.dumps(state, indent=1))
    print('best', json.dumps(state['best']))


# ====================================================================== threshold
def tune(run: Path, thresholds=(.4, .5, .6, .7, .8)) -> dict:
    """Pick the threshold on the tuning set (normal and fast-passage errors): best summed note F1."""
    import eval_audio_to_score as ev
    db = sqlite3.connect(f'file:{ev.SCORES}?mode=ro', uri=True)
    found = load(run / 'weights.pt')
    if found is None:
        raise SystemExit('no weights')
    model, info = found
    chords = a2s.load_chords_model(None)
    cases = tuning_cases(db, False) + tuning_cases(db, True)
    results = {}
    for th in (None,) + tuple(thresholds):
        filler = Filler(model, info, th) if th is not None else None
        rows = defaultdict(list)
        added = Counter()
        for c in cases:
            score = a2s.transcription_to_score(c['doc'], chords_model=chords, filler=filler)
            rows[c['name']].append(ev.compare(score, c['truth'], c['durations'], c['runs']) | {'metre': True})
            anchor, bq = score.downbeat, score.beat_quarters
            for n in score.notes:
                if n.added == 'filler' and not n.removed:
                    added['right' if ((n.on - anchor) / bq, n.pitch) in c['truth'] else 'wrong'] += 1
        summary = {name: ev.summarize(r) for name, r in rows.items()}
        results[str(th)] = {'f1': {k: v['f1'] for k, v in summary.items()},
                            'precision': {k: v['precision'] for k, v in summary.items()},
                            'recall': {k: v['recall'] for k, v in summary.items()}, 'added': dict(added)}
        print(th, json.dumps(results[str(th)]), flush=True)
    best = max((th for th in thresholds), key=lambda th: sum(results[str(th)]['f1'].values()))
    data = __import__('torch').load(run / 'weights.pt', map_location='cpu', weights_only=False)
    data['threshold'] = best
    data['tuning'] = results
    __import__('torch').save(data, run / 'weights.pt')
    (run / 'tuning.json').write_text(json.dumps({'threshold': best, 'results': results}, indent=1))
    print('threshold', best)
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('data', help='simulate, clean and frame the training pieces')
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--workers', type=int, default=2)
    p.add_argument('--limit', type=int)
    p = sub.add_parser('train')
    p.add_argument('--data', type=Path, required=True)
    p.add_argument('--run-dir', type=Path, required=True)
    p.add_argument('--steps', type=int, default=4000)
    p.add_argument('--batch', type=int, default=8)
    p.add_argument('--lr', type=float, default=1e-3)
    p.add_argument('--warmup', type=int, default=200)
    p.add_argument('--d', type=int, default=128)
    p.add_argument('--layers', type=int, default=4)
    p.add_argument('--heads', type=int, default=4)
    p.add_argument('--dropout', type=float, default=.1)
    p.add_argument('--missing-weight', type=float, default=2.,
                   help='loss weight of the notes the cleaned score lacks (the ones to find)')
    p.add_argument('--seed', type=int, default=1)
    p.add_argument('--threads', type=int, default=2)
    p.add_argument('--log-every', type=int, default=50)
    p.add_argument('--eval-every', type=int, default=500)
    p.add_argument('--checkpoint-every', type=int, default=100)
    p.add_argument('--resume', action='store_true')
    p = sub.add_parser('tune', help='choose the threshold on the tuning set')
    p.add_argument('--run-dir', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'data':
        make_data(args.out, args.workers, args.limit)
    elif args.command == 'train':
        train(args)
    else:
        tune(args.run_dir)


if __name__ == '__main__':
    main()
