"""Windowing and token encoding for the Cantelvio Compose joint (R/H/B/M) Transformer.

Generation order (fixed): every sixteenth-note step t, streams in the order
R (accompaniment rhythm) -> H (harmony) -> B (bass) -> M (melody).
No stream is generated ahead of the others.

Per window (whole bars, <= T steps) everything is expressed relative to the
window's reference key (the most common AugmentedNet local key); the local key
per step stays a control input.
"""
import json
from pathlib import Path
import numpy as np

STREAMS = ['R', 'H', 'B', 'M']
T_MAX = 128
N_QUAL = 40
N_PITCHES = {'B': 48, 'M': 36}  # bass (lowest skyline of the left hand) spans more than a voice
N_PITCH = 36
PAD, UNK = 0, 1
# R: REST 2, HOLD 3, ONE_ONSET 4, MULTI_ONSET 5
R_VOCAB = 6
# H: HOLD 2, chord 3 + quality*12 + root (relative to reference tonic)
H_HOLD, H_VOCAB = 2, 3 + N_QUAL * 12
# B / M: REST 2, HOLD 3, ONSET 4 + pitch above the window base (bass 0..47, melody 0..35)
REST, HOLD, ONSET0 = 2, 3, 4
VOCAB = {'R': R_VOCAB, 'H': H_VOCAB, 'B': ONSET0 + N_PITCHES['B'], 'M': ONSET0 + N_PITCHES['M']}
N_METER, N_POS, N_LEVEL, N_PHRASE, N_LKEY, N_STYLE, N_SINCE = 14, 24, 4, 8, 25, 7, 18
STYLE_IDS = {'pop': 0, 'jazz': 1, 'blues': 2, 'classical': 3, 'ambient': 4, 'exploratory': 5}
BEAT_OF_METER = {0: 4, 1: 4, 2: 4, 3: 8, 4: 2, 5: 6, 6: 6, 7: 6, 8: 12, 9: 8, 10: 2, 11: 4, 12: 2, 13: 4}


def load_corpus(npz_path):
    with np.load(npz_path) as d:  # decompress every array once; pieces are views into them
        arrays = {k: d[k] for k in d.files}
    meta = json.loads(Path(npz_path).with_suffix('.json').read_text())
    kept = [r for r in meta['records'] if r.get('reject') is None]
    off = arrays.pop('offsets')
    assert len(kept) == len(off) - 1, (len(kept), len(off))
    pieces = []
    for i, r in enumerate(kept):
        a, b = int(off[i]), int(off[i + 1])
        pieces.append({'meta': r, 'arrays': {k: v[a:b] for k, v in arrays.items()}})
    return pieces


def piece_windows(piece, T=T_MAX, hop=None):
    """(start, end) step ranges of whole bars, supported metre and known harmony."""
    A = piece['arrays']; N = len(A['bar'])
    hop = hop or T // 2
    ok = (A['meter'] >= 0) & (A['bar'] >= 0) & (A['ch_root'] >= 0)
    starts = [0] + [t for t in range(1, N) if A['bar'][t] != A['bar'][t - 1]]
    bounds = starts + [N]
    windows, i = [], 0
    while i < len(starts):
        a = bounds[i]; j = i
        while j + 1 < len(bounds) and bounds[j + 1] - a <= T:
            j += 1
        b = bounds[j] if j > i else min(a + T, bounds[i + 1])
        if b - a >= 16 and ok[a:b].all():
            windows.append((a, b))
        elif not ok[a:b].all():  # skip past the unsupported region
            pass
        # advance roughly half a window, on a barline
        target = a + hop; k = i + 1
        while k < len(starts) and bounds[k] < target:
            k += 1
        i = max(k, i + 1)
    return windows


def encode_window(piece, a, b, T=T_MAX):
    """Token and feature arrays for one window; None if it cannot be encoded."""
    A = piece['arrays']; meta = piece['meta']; n = b - a
    sl = slice(a, b)
    kt, km = A['key_tonic'][sl].astype(int), A['key_mode'][sl].astype(int)
    pairs, counts = np.unique(np.stack([kt, km], 1), axis=0, return_counts=True)
    ref_tonic, ref_mode = (int(x) for x in pairs[np.argmax(counts)])
    out = {k: np.zeros(T, np.int16) for k in ('R', 'H', 'B', 'M', 'pos', 'meter', 'level', 'phrase', 'lkey', 'beatphase',
                                                'chord', 'since', 'change', 'barlen', 'beatlen')}
    out['valid'] = np.zeros(T, bool); out['valid'][:n] = True
    # Metre / position controls.
    pos, meter, level, bar = A['pos'][sl], A['meter'][sl], A['level'][sl], A['bar'][sl]
    first_bar_len = int((A['bar'] == A['bar'][0]).sum())
    pickup = 1 if first_bar_len < int(A['barlen'][0]) else 0
    out['pos'][:n] = np.clip(pos, 0, N_POS - 1); out['meter'][:n] = meter; out['level'][:n] = level
    out['phrase'][:n] = (bar.astype(int) - pickup) % N_PHRASE
    beat = np.array([BEAT_OF_METER.get(int(m), 4) for m in meter])
    out['beatphase'][:n] = pos % beat
    out['barlen'][:n] = np.maximum(A['barlen'][sl], 1); out['beatlen'][:n] = beat
    out['barlen'][n:] = 16; out['beatlen'][n:] = 4
    lk = np.where(kt >= 0, ((kt - ref_tonic) % 12) * 2 + km, N_LKEY - 1)
    out['lkey'][:n] = lk
    # Rhythm.
    out['R'][:n] = 2 + A['rhythm'][sl]
    # Harmony: chord token at window start and at every change, HOLD otherwise.
    root = (A['ch_root'][sl].astype(int) - ref_tonic) % 12; q = A['ch_q'][sl].astype(int)
    chord = q * 12 + root
    change = A['ch_change'][sl].astype(bool).copy(); change[0] = True
    out['H'][:n] = np.where(change, 3 + chord, H_HOLD)
    out['chord'][:n] = chord; out['change'][:n] = change
    since = np.zeros(n, np.int16); c = 0
    for t in range(n):
        c = 0 if change[t] else c + 1
        since[t] = min(c, N_SINCE - 1)
    out['since'][:n] = since
    # Bass and melody.
    bases = {}
    for s, pk, ok in (('B', 'bass_pitch', 'bass_on'), ('M', 'mel_pitch', 'mel_on')):
        p = A[pk][sl].astype(int); on = A[ok][sl].astype(bool)
        if (p == -2).any():  # stream unknown in this phrase
            out[s][:n] = UNK; bases[s] = None; continue
        sounding = p >= 0
        if not sounding.any():
            out[s][:n] = REST; bases[s] = None; continue
        lo, hi = p[sounding].min(), p[sounding].max()
        base = ref_tonic + 12 * int(np.floor((lo - ref_tonic) / 12))
        if hi - base >= N_PITCHES[s]:
            out[s][:n] = UNK; bases[s] = None; continue
        tok = np.full(n, REST, np.int16)
        for t in range(n):
            if p[t] < 0:
                continue
            new = on[t] or t == 0 or p[t - 1] != p[t]
            tok[t] = ONSET0 + (p[t] - base) if new else HOLD
        out[s][:n] = tok; bases[s] = int(base)
    out['domain'] = 1 if meta.get('type') is None else 0
    out['style'] = STYLE_IDS.get(meta.get('style', 'classical'), 3)
    out['refmode'] = ref_mode
    out['info'] = {'scoreId': meta['scoreId'], 'split': meta['split'], 'start': int(a), 'end': int(b), 'refTonic': ref_tonic,
                   'refMode': ref_mode, 'bassBase': bases.get('B'), 'melodyBase': bases.get('M')}
    return out


def build_windows(pieces, split, T=T_MAX, min_cover=0.6):
    rows = []
    for p in pieces:
        m = p['meta']
        if m['split'] != split:
            continue
        if m.get('chordToneCoverage') is not None and m['chordToneCoverage'] < min_cover:
            continue
        for a, b in piece_windows(p, T):
            w = encode_window(p, a, b, T)
            if w is not None:
                rows.append(w)
    return rows


def collate(rows):
    import torch
    keys = ('R', 'H', 'B', 'M', 'pos', 'meter', 'level', 'phrase', 'lkey', 'beatphase', 'chord', 'since', 'change', 'barlen', 'beatlen')
    batch = {k: torch.as_tensor(np.stack([r[k] for r in rows]).astype(np.int64)) for k in keys}
    batch['valid'] = torch.as_tensor(np.stack([r['valid'] for r in rows]))
    for k in ('domain', 'style', 'refmode'):
        batch[k] = torch.as_tensor([r[k] for r in rows])
    return batch


def chord_features_from_H(H):
    """chord / since / change arrays derived from harmony tokens (numpy or torch, last axis = time).

    Used for generation and tests; mirrors encode_window.
    """
    import torch
    H = torch.as_tensor(H)
    chord = torch.zeros_like(H); since = torch.zeros_like(H); change = torch.zeros_like(H, dtype=torch.bool)
    cur = torch.zeros(H.shape[:-1], dtype=H.dtype); run = torch.zeros(H.shape[:-1], dtype=H.dtype)
    for t in range(H.shape[-1]):
        is_chord = H[..., t] >= 3
        cur = torch.where(is_chord, H[..., t] - 3, cur)
        run = torch.where(is_chord, torch.zeros_like(run), run + 1)
        chord[..., t] = cur; since[..., t] = run.clamp(max=N_SINCE - 1); change[..., t] = is_chord
    return chord, since, change
