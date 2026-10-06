#!/usr/bin/env python3
"""Causality (information-leak) test for the joint R/H/B/M models.

The logits that predict token (s, t+1) may depend only on tokens that come
earlier in the generation order (step-major, streams R -> H -> B -> M).
For random windows (sparse harmony, padded tails) and perturbations of every kind
(including chord <-> HOLD flips, which move the derived chord features), every
prediction whose target is at or before the perturbed token must be bit-identical.
Positive checks confirm that the newest earlier tokens really reach the prediction
(e.g. the bass at t+1 responds to the chord at t+1), and a deliberately leaky
variant must fail.
"""
import random, sys
from pathlib import Path
import torch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from joint_data import STREAMS, VOCAB, N_LEVEL, N_PHRASE, N_LKEY, PAD, chord_features_from_H  # noqa: E402
from joint_model import StructuredJoint, FlatJoint, _next  # noqa: E402

T, B = 24, 3
torch.manual_seed(7); random.seed(7)
torch.set_default_dtype(torch.float64)


def random_batch():
    b = {}
    for s in STREAMS:
        b[s] = torch.randint(2, VOCAB[s], (B, T))
    # sparse harmony: mostly HOLD (2), chord tokens (>= 3) at ~25% of steps and at t = 0
    chords = torch.randint(3, VOCAB['H'], (B, T))
    b['H'] = torch.where(torch.rand(B, T) < 0.25, chords, torch.full((B, T), 2)); b['H'][:, 0] = chords[:, 0]
    b['pos'] = torch.arange(T).repeat(B, 1) % 16; b['meter'] = torch.full((B, T), 2)
    b['level'] = torch.randint(0, N_LEVEL, (B, T)); b['phrase'] = (torch.arange(T) // 16).repeat(B, 1) % N_PHRASE
    b['lkey'] = torch.randint(0, N_LKEY, (B, T)); b['beatphase'] = b['pos'] % 4
    b['barlen'] = torch.full((B, T), 16); b['beatlen'] = torch.full((B, T), 4)
    b['valid'] = torch.ones(B, T, dtype=torch.bool)
    b['valid'][2, T - 5:] = False                       # a padded window
    for s in STREAMS:
        b[s][2, T - 5:] = PAD
    b['domain'] = torch.tensor([0, 1, 1]); b['style'] = torch.tensor([3, 1, 0]); b['refmode'] = torch.tensor([0, 1, 0])
    return refresh(b)


def refresh(b):
    chord, since, change = chord_features_from_H(b['H'])
    b['chord'], b['since'], b['change'] = chord, since, change
    return b


def perturbed(b, u, i, tau):
    pb = {k: (v.clone() if torch.is_tensor(v) else v) for k, v in b.items()}
    old = int(pb[u][i, tau])
    if u == 'H':
        choices = [2] + list(range(3, VOCAB['H'])) if old >= 3 else list(range(3, VOCAB['H']))  # chord<->HOLD flips
    else:
        choices = list(range(2, VOCAB[u]))
    new = old
    while new == old:
        new = random.choice(choices)
    pb[u][i, tau] = new
    return refresh(pb)


def key(s, t):
    return (t, STREAMS.index(s))


def check(model, trials=60):
    model.eval()
    b = random_batch()
    with torch.no_grad():
        base = model(b)
    responded = 0
    for trial in range(trials):
        u = STREAMS[trial % 4]; i = random.randrange(B)
        limit = T - 5 if i == 2 else T
        tau = random.randrange(1, limit)
        pb = perturbed(b, u, i, tau)
        with torch.no_grad():
            out = model(pb)
        for s in STREAMS:
            for t in range(T - 1):  # position t predicts (s, t+1)
                same = torch.equal(out[s][i, t], base[s][i, t])
                if key(s, t + 1) <= key(u, tau):
                    assert same, f'{type(model).__name__}: prediction of ({s},{t + 1}) changed after perturbing ({u},{tau})'
                elif not same:
                    responded += 1
    assert responded > 0, 'perturbations never influenced later predictions (test not sensitive)'
    return responded


def check_reaches(model):
    """The newest earlier tokens must reach the prediction (positive checks)."""
    model.eval(); b = random_batch(); t = 10
    cases = [('H', t + 1, 'B', t), ('B', t + 1, 'M', t), ('R', t + 1, 'H', t), ('M', t, 'R', t)]
    for u, tau, s, pos in cases:  # perturb (u, tau), expect the prediction at position pos of stream s to move
        with torch.no_grad():
            a, c = model(b)[s][0, pos], model(perturbed(b, u, 0, tau))[s][0, pos]
        assert not torch.equal(a, c), f'{type(model).__name__}: ({s},{pos + 1}) ignores ({u},{tau})'


class LeakyStructured(StructuredJoint):
    """Deliberately wrong: rhythm and harmony read the chord features of step t+1."""
    def chord_inputs(self, b):
        feats = super().chord_inputs(b)
        feats['R'] = feats['H'] = self.chord_root(_next(b['chord']) % 12) + self.since(_next(b['since'])) + self.change(_next(b['change']).long())
        return feats


if __name__ == '__main__':
    for Model in (StructuredJoint, FlatJoint):
        m = Model(d=32, heads=2, layers=2, ff=64, T=T, dropout=0.0)
        n = check(m); check_reaches(m)
        print(f'{Model.__name__}: no leak in 60 perturbations (all streams/steps checked); {n} later predictions responded; positive checks pass')
    try:
        check(LeakyStructured(d=32, heads=2, layers=2, ff=64, T=T, dropout=0.0))
        raise SystemExit('FAIL: the deliberately leaky variant was not detected')
    except AssertionError as e:
        print('leaky variant detected as expected:', str(e)[:80])
    print('ok')
