#!/usr/bin/env python3
"""Model checks on real windows of a prepared corpus.

1. Causality: changing token j (any field, its time or pitch coordinate) never changes the
   predictions made before j, and does change later ones.
2. Transposition equivariance: with pitch='rotary' and register=False, shifting every pitch
   coordinate by k leaves all logits unchanged (the interval fields are unchanged by
   construction); with register=True or pitch='absolute' they change, as they should.
3. The data-side transposition gives the same loss for the equivariant model.
4. A few optimizer steps on one batch reduce the loss (the heads are wired to their targets).

  python training/orchestra/tests/test_model.py <prepared data folder>
"""
import copy, sys
from pathlib import Path
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import groups as G
from data import Corpus, collate
from model import OrchestraTransformer


def batch_of(c, n=4, L=192, seed=0, shift=0):
    rng = np.random.default_rng(seed)
    ws = []
    for i in range(n):
        pi = int(rng.integers(len(c)))
        ws.append(c.window(rng, L, piece=pi, start_bar=int(rng.integers(c.pieces[pi]['bars'])), shift=shift))
    return collate(ws)


def all_logits(model, b):
    with torch.no_grad():
        return torch.cat([v.flatten(2) for v in model.forward(b).values()], -1)


def main():
    torch.manual_seed(0)
    c = Corpus(Path(sys.argv[1]), 'train')
    b = batch_of(c)
    small = dict(d=128, heads=2, layers=2, ff=256, dropout=0.0)
    # 1. causality
    m = OrchestraTransformer(**small).eval()
    with torch.no_grad():
        h0 = m.hidden(b); out0 = m.forward(b)
    for j in (1, 7, 50, 120):
        b2 = copy.deepcopy(b)
        for f in ('pos', 'group', 'pitchf', 'pabs', 'dur', 'vel', 'meter', 'tempo', 'mask', 'type'):
            b2[f][:, j] = (b2[f][:, j] + 1) % 3
        b2['t'][:, j] += 0.37; b2['pi'][:, j] += 5
        with torch.no_grad():
            h1 = m.hidden(b2)
        assert torch.allclose(h1[:, :j], h0[:, :j], atol=1e-5), f'hidden states before {j} changed'
        assert not torch.allclose(h1[:, j:], h0[:, j:], atol=1e-5), f'token {j} has no effect'
    # inside one token, a field's head may only see the fields chosen before it
    order = {'note': ['pos', 'group', 'pitch', 'dur', 'vel'], 'bar': ['meter', 'tempo'] + [f'bit{g}' for g in range(G.N_GROUPS)]}
    source = {'pos': ['pos'], 'group': ['group'], 'pitch': ['pitchf', 'pabs'], 'dur': ['dur'], 'vel': ['vel'],
              'meter': ['meter'], 'tempo': ['tempo']}
    for j in (1, 33, 90):   # change one field of token j; position j-1 predicts token j
        for kind, fields in order.items():
            for n, f in enumerate(fields):
                if f.startswith('bit'):
                    continue
                b2 = copy.deepcopy(b)
                for col in source[f]:
                    b2[col][:, j] = (b2[col][:, j] + 1) % 3
                with torch.no_grad():
                    out1 = m.forward(b2)
                for earlier in ['type'] + fields[:n + 1]:
                    assert torch.allclose(out1[earlier][:, j - 1], out0[earlier][:, j - 1], atol=1e-5), f'{earlier} head sees {f}'
        b2 = copy.deepcopy(b); b2['mask'][:, j] ^= 0b100000                # flip the last group bit only
        with torch.no_grad():
            out1 = m.forward(b2)
        for earlier in ['type', 'meter', 'tempo'] + [f'bit{g}' for g in range(G.N_GROUPS)]:
            assert torch.allclose(out1[earlier][:, j - 1], out0[earlier][:, j - 1], atol=1e-5), f'{earlier} head sees the last bit'
    print('causality ok (across tokens and across fields of one token)')
    # 2. equivariance
    for cfg, expect in ((dict(pitch='rotary', register=False), True), (dict(pitch='rotary', register=True), False),
                        (dict(pitch='absolute'), False)):
        m = OrchestraTransformer(**small, **cfg).eval()
        base = all_logits(m, b)
        worst = 0.0
        for k in (-7, 1, 5, 12):
            b2 = copy.deepcopy(b); b2['pi'] = b2['pi'] + k
            pitched = (b2['type'] == G.NOTE) & (b2['pabs'] < 128)
            b2['pabs'] = torch.where(pitched, b2['pabs'] + k, b2['pabs'])
            worst = max(worst, float((all_logits(m, b2) - base).abs().max()))
        ok = worst < 2e-4
        assert ok == expect, (cfg, worst)
        print(f'{cfg}: max logit change under transposition {worst:.2e} ({"invariant" if ok else "changes"})')
    # 3. data-side transposition, equivariant model: same loss (windows without notes near the edges)
    m = OrchestraTransformer(**small, pitch='rotary', register=False).eval()
    rng = np.random.default_rng(3)
    pi = int(np.argmax([p['notes'] for p in c.pieces]))
    w0 = c.window(rng, 256, piece=pi, start_bar=0, shift=0)
    w1 = c.window(rng, 256, piece=pi, start_bar=0, shift=4)
    # the pipeline's transposed window equals the original with every coordinate +4, except that the
    # anchor (before the first pitched note) stays at ANCHOR and so the first interval differs
    L = int(w0['length']); pitched = (w0['type'][:L] == G.NOTE) & (w0['pitchf'][:L] < G.N_INTERVAL)
    f = int(np.argmax(pitched))
    assert (w1['pi'][f:L] == w0['pi'][f:L] + 4).all() and (w1['pi'][:f] == G.ANCHOR).all()
    same = np.ones(L, bool); same[f] = False
    assert (w1['pitchf'][:L][same] == w0['pitchf'][:L][same]).all() and w1['pitchf'][f] == w0['pitchf'][f] + 4
    w1['pi'][:f] = G.ANCHOR + 4; w1['pitchf'][f] = w0['pitchf'][f]   # move the anchor with the piece
    with torch.no_grad():
        l0, _ = m.loss(collate([w0])); l1, _ = m.loss(collate([w1]))
    assert abs(float(l0) - float(l1)) < 1e-4, (float(l0), float(l1))
    print(f'data-side transposition: loss {float(l0):.5f} vs {float(l1):.5f}')
    # 4. learning
    m = OrchestraTransformer(**small).train()
    opt = torch.optim.AdamW(m.parameters(), lr=3e-3)
    first = None
    for step in range(30):
        loss, parts = m.loss(b)
        opt.zero_grad(); loss.backward(); opt.step()
        first = first if first is not None else loss.item()
    assert loss.item() < 0.7 * first, (first, loss.item())
    print(f"overfit one batch: {first:.3f} -> {loss.item():.3f}")
    print('all model checks passed')


if __name__ == '__main__':
    main()
