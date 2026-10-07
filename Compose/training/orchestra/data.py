"""Training windows for the Cantelvio Compose orchestral model (reads the arrays written by prepare.py).

A window starts at a bar of a piece and contains, in order, for every bar:
  BAR token  (meter, tempo, position of the bar in the piece, which groups play in it)
  NOTE token for every note of the bar (onset position, group, pitch, duration, velocity)
until max_len tokens; EOS follows the last bar of the piece. Notes of one onset come
unpitched percussion first, then pitched notes from low to high.

Pitch is relative. Each token carries a pitch coordinate pi: its own pitch for a pitched
note, otherwise the last pitched note before it (ANCHOR before the first one). A pitched
note's pitch field is its interval to the previous token's coordinate, so every input
the model sees about pitch is either an interval or (optionally) a coarse register.
Transposition augmentation shifts all pitched notes of a window by the same amount.
"""
import json
from pathlib import Path
import numpy as np
import groups as G
from prepare import NOTE_FIELDS, BAR_FIELDS

FIELDS = ('type', 'meter', 'tempo', 'prog', 'mask', 'pos', 'group', 'pitchf', 'pabs', 'dur', 'vel', 'pi', 'next_prog')


class Corpus:
    def __init__(self, data_dir, split):
        d = Path(data_dir)
        self.pieces = [p for p in json.loads((d / 'pieces.json').read_text()) if p['split'] == split]
        mm = lambda name, dt: np.memmap(d / name, dtype=dt, mode='r') if (d / name).stat().st_size else np.zeros(0, dt)
        self.notes = {k: mm(f'notes.{k}.bin', v) for k, v in NOTE_FIELDS.items()}
        self.bars = {k: mm(f'bars.{k}.bin', v) for k, v in BAR_FIELDS.items()}
        sizes = np.array([p['notes'] + p['bars'] for p in self.pieces], float)
        self.weights = sizes / sizes.sum() if len(sizes) else sizes
        self.tokens = int(sizes.sum())

    def __len__(self):
        return len(self.pieces)

    def window(self, rng, max_len, transpose=(-6, 5), piece=None, start_bar=None, shift=None):
        """One window as a dict of int arrays of length max_len (PAD after the end), plus float 't'."""
        p = self.pieces[piece if piece is not None else rng.choice(len(self.pieces), p=self.weights)]
        nb, bo, no = p['bars'], p['barOffset'], p['noteOffset']
        b0 = int(start_bar if start_bar is not None else rng.integers(0, nb))
        first = np.asarray(self.bars['first'][bo + b0: bo + nb], np.int64)
        per_bar = np.diff(np.append(first, p['notes'])) + 1                 # BAR token + its notes
        cum = np.cumsum(per_bar)
        n_full = int(np.searchsorted(cum, max_len, side='right'))            # bars that fit completely
        used = int(cum[n_full - 1]) if n_full else 0
        n_bars = n_full + 1 if n_full < len(per_bar) and used < max_len else n_full   # the next bar may be cut
        eos = n_full == len(per_bar) and used < max_len
        bt = {k: np.asarray(self.bars[k][bo + b0: bo + b0 + n_bars]) for k in BAR_FIELDS}
        n0 = no + int(first[0])
        n1 = no + (int(first[n_bars]) if n_bars < len(first) else p['notes'])
        k = min(n1 - n0, max_len - n_bars - int(eos))                        # notes that fit
        nt = {f: np.asarray(self.notes[f][n0:n0 + k]) for f in NOTE_FIELDS}
        bar_of_note = nt['bar'].astype(np.int64) - b0
        L = n_bars + k + int(eos)
        # token index of each BAR token and each note: bar b's notes follow its BAR token
        bar_tok = np.arange(n_bars) + np.concatenate([[0], np.cumsum(per_bar[:n_bars] - 1)[:-1]])
        note_tok = np.arange(k) + bar_of_note + 1
        out = {f: np.zeros(max_len, np.int64) for f in FIELDS}
        t = np.zeros(max_len, np.float32)
        out['type'][bar_tok] = G.BAR; out['type'][note_tok] = G.NOTE
        if eos:
            out['type'][L - 1] = G.EOS
        # bars
        out['meter'][bar_tok] = bt['meter']; out['tempo'][bar_tok] = bt['tempo']
        out['prog'][bar_tok] = (G.N_PROG * (b0 + np.arange(n_bars))) // nb
        all_groups = np.asarray(self.notes['group'][n0:n1]).astype(np.int64)  # the mask covers the whole bar
        all_bars = np.asarray(self.notes['bar'][n0:n1]).astype(np.int64) - b0
        bits = np.zeros(n_bars, np.int64)
        np.bitwise_or.at(bits, all_bars, 1 << all_groups)
        out['mask'][bar_tok] = bits
        origin = bt['start'][0]
        t[bar_tok] = (bt['start'] - origin) / G.GRID
        # notes
        for f in ('pos', 'group', 'dur', 'vel'):
            out[f][note_tok] = nt[f]
        t[note_tok] = (bt['start'][bar_of_note] - origin + nt['pos']) / G.GRID
        if eos:
            t[L - 1] = (bt['start'][-1] - origin + bt['len'][-1]) / G.GRID
        drum = nt['drum'].astype(bool); pitch = nt['pitch'].astype(np.int64)
        if shift is None:   # transposition augmentation, kept inside the piano range
            pp = pitch[~drum]
            lo, hi = (max(transpose[0], G.PITCH_LO - pp.min()), min(transpose[1], G.PITCH_HI - pp.max())) if (transpose and len(pp)) else (0, 0)
            shift = int(rng.integers(lo, hi + 1)) if hi >= lo else 0
        pitch = np.where(drum, pitch, pitch + shift)
        # pitch coordinate: last pitched note at or before each token (ANCHOR before the first)
        coord = np.full(L, -1, np.int64)
        coord[note_tok[~drum]] = pitch[~drum]
        idx = np.where(coord >= 0, np.arange(L), -1)
        np.maximum.accumulate(idx, out=idx)
        pi = np.where(idx >= 0, coord[np.maximum(idx, 0)], G.ANCHOR)
        prev = np.concatenate([[G.ANCHOR], pi[:-1]])
        interval = np.clip(pitch - prev[note_tok], -G.MAX_INTERVAL, G.MAX_INTERVAL)
        out['pitchf'][note_tok] = np.where(drum, G.N_INTERVAL + pitch, interval + G.MAX_INTERVAL)
        out['pabs'][note_tok] = np.where(drum, 128 + pitch, pitch)
        out['pi'][:L] = pi
        # position in the piece of the bar after the current one (the BAR head is conditioned on it)
        is_bar = np.zeros(L, bool); is_bar[bar_tok] = True
        bar_of_tok = np.cumsum(is_bar) - 1
        out['next_prog'][:L] = np.minimum(G.N_PROG - 1, (G.N_PROG * (b0 + bar_of_tok + 1)) // nb)
        out['t'] = t
        out['length'] = L
        out['shift'] = shift
        return out


def collate(windows):
    import torch
    batch = {f: torch.as_tensor(np.stack([w[f] for w in windows])) for f in FIELDS}
    batch['t'] = torch.as_tensor(np.stack([w['t'] for w in windows]))
    batch['length'] = torch.as_tensor([w['length'] for w in windows])
    return batch


def decode(w):
    """Window arrays -> list of bars [{'start','meter','tempo','mask','notes':[(pos, group, pitch or None, drum, dur, vel)]}]."""
    out, pi_prev = [], G.ANCHOR
    for i in range(int(w['length'])):
        ty = int(w['type'][i])
        if ty == G.BAR:
            out.append({'t': float(w['t'][i]), 'meter': int(w['meter'][i]), 'tempo': int(w['tempo'][i]),
                        'mask': int(w['mask'][i]), 'notes': []})
        elif ty == G.NOTE:
            pf = int(w['pitchf'][i])
            if pf >= G.N_INTERVAL:
                note = (int(w['pos'][i]), int(w['group'][i]), pf - G.N_INTERVAL, True, int(w['dur'][i]), int(w['vel'][i]))
            else:
                pitch = pi_prev + pf - G.MAX_INTERVAL
                note = (int(w['pos'][i]), int(w['group'][i]), pitch, False, int(w['dur'][i]), int(w['vel'][i]))
            out[-1]['notes'].append(note)
        pi_prev = int(w['pi'][i])
    return out
