#!/usr/bin/env python3
"""Pipeline checks on a prepared test corpus (see make_test_midis.py).

1. Every window decodes back to exactly the stored notes of its bars (intervals, drums,
   positions, groups, durations, velocities), with and without transposition.
2. Bar masks list exactly the groups that have onsets in the bar.
3. Windows respect max_len; a window that reaches the end of a piece ends with EOS.
4. Preparation drops out-of-range pitches and synth effects, merges unisons within a group.

  python training/orchestra/tests/test_pipeline.py <prepared data folder> <midi folder>
"""
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import groups as G
from data import Corpus, decode
from prepare import parse


def stored_bars(c, p, b0, b1):
    """Notes of bars b0..b1-1 of piece p from the raw arrays: {bar: [(pos, group, pitch, drum, dur, vel)]}."""
    out = {}
    s, e = p['noteOffset'], p['noteOffset'] + p['notes']
    bar = np.asarray(c.notes['bar'][s:e])
    sel = np.flatnonzero((bar >= b0) & (bar < b1))
    for i in sel:
        j = s + i
        out.setdefault(int(bar[i]), []).append((int(c.notes['pos'][j]), int(c.notes['group'][j]), int(c.notes['pitch'][j]),
                                                 bool(c.notes['drum'][j]), int(c.notes['dur'][j]), int(c.notes['vel'][j])))
    return out


def main():
    data, midi = Path(sys.argv[1]), Path(sys.argv[2])
    c = Corpus(data, 'train')
    rng = np.random.default_rng(0)
    checked = cut = ended = 0
    for trial in range(300):
        pi = int(rng.integers(len(c)))
        p = c.pieces[pi]
        max_len = int(rng.choice([64, 256, 1024, 4096]))
        shift = int(rng.integers(-6, 6)) if trial % 2 else 0
        b0 = int(rng.integers(p['bars']))
        w = c.window(rng, max_len, piece=pi, start_bar=b0, shift=shift)
        L = int(w['length'])
        assert L <= max_len and (w['type'][L:] == G.PAD).all()
        bars = decode(w)
        ref = stored_bars(c, p, b0, b0 + len(bars))
        n_notes = 0
        for k, bar in enumerate(bars):
            want = ref.get(b0 + k, [])
            got = [(pos, g, pitch if drum else pitch - shift, drum, dur, vel) for pos, g, pitch, drum, dur, vel in bar['notes']]
            if k == len(bars) - 1 and len(got) < len(want):
                want = want[:len(got)]; cut += 1          # the last bar can be cut at max_len
            assert got == want, (pi, b0, k, got[:5], want[:5])
            groups = {g for _, g, *_ in ref.get(b0 + k, [])}
            assert bar['mask'] == sum(1 << g for g in groups), (bar['mask'], groups)
            n_notes += len(got)
        if w['type'][L - 1] == G.EOS:
            ended += 1
            assert b0 + len(bars) == p['bars']
        assert L == len(bars) + n_notes + int(w['type'][L - 1] == G.EOS)
        checked += 1
    # preparation details on the synthetic files
    (notes, bars), info = parse(midi / 'synthetic-000.mid')
    assert info['notes'] == len(notes['bar'])
    pitched = notes['drum'] == 0
    assert notes['pitch'][pitched].max() <= G.PITCH_HI and notes['pitch'][pitched].min() >= G.PITCH_LO
    key = np.stack([notes[k].astype(np.int64) for k in ('bar', 'pos', 'drum', 'pitch', 'group')], 1)
    assert len(np.unique(key, axis=0)) == len(key), 'duplicate notes in one group'
    merged = sum(parse(midi / f'synthetic-{i:03d}.mid')[1]['merged'] for i in range(8))
    assert merged > 0, 'unison doublings should be merged'
    print({'windows': checked, 'cutBars': cut, 'endedWithEOS': ended, 'mergedUnisons(8 files)': merged, 'ok': True})


if __name__ == '__main__':
    main()
