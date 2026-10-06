"""AIlegro joint Transformer prototype: rhythm (R), harmony (H), bass (B), melody (M).

StructuredJoint - four stream sub-networks trained end to end. Every layer has
    per-stream Q/K/V/O and FFN weights (the "bass layer", "rhythm transformer",
    ...), one attention over all streams, and musical structure built in:
      * fixed generation order per sixteenth step: R -> H -> B -> M
      * metrical controls (position in bar, metre, metrical level, phrase bar)
      * metrical rotary encoding: time, beat phase and bar phase
      * current-chord features and chord-relative pitch heads for B and M
FlatJoint - a generic decoder over the interleaved token sequence
    (R0 H0 B0 M0 R1 ...), same control inputs and attention visibility, one set of
    weights and learned absolute positions, no structural priors; the baseline.

Causality: the state that predicts token (s, t+1) may depend only on tokens that
precede it in the generation order. With the streams interleaved time-major
(R0 H0 B0 M0 R1 ...), a plain causal mask gives exactly that visibility; the newest
earlier token of every other stream (the same step for lower-ranked streams, e.g.
the new chord for the bass) is injected into the input directly.
"""
import math
import torch
from torch import nn
from torch.nn import functional as F
from joint_data import (STREAMS, VOCAB, T_MAX, N_METER, N_POS, N_LEVEL, N_PHRASE, N_LKEY, N_STYLE, N_SINCE,
                        N_QUAL, PAD, UNK, ONSET0, N_PITCHES)

RANK = {s: i for i, s in enumerate(STREAMS)}


class Controls(nn.Module):
    """Global and per-step control inputs shared by both models."""
    def __init__(self, d, structural):
        super().__init__()
        self.structural = structural
        self.domain, self.style, self.refmode = nn.Embedding(2, d), nn.Embedding(N_STYLE, d), nn.Embedding(2, d)
        self.meter, self.lkey = nn.Embedding(N_METER, d), nn.Embedding(N_LKEY, d)
        if structural:
            self.pos, self.level, self.phrase = nn.Embedding(N_POS, d), nn.Embedding(N_LEVEL, d), nn.Embedding(N_PHRASE, d)

    def forward(self, b, shift):
        """Step controls of the *target* step (t+1) when shift=1."""
        def nxt(x):
            return torch.cat([x[:, shift:], x[:, -1:].expand(-1, shift)], 1) if shift else x
        g = (self.domain(b['domain']) + self.style(b['style']) + self.refmode(b['refmode']))[:, None]
        step = self.meter(nxt(b['meter'])) + self.lkey(nxt(b['lkey']))
        if self.structural:
            step = step + self.pos(nxt(b['pos'])) + self.level(nxt(b['level'])) + self.phrase(nxt(b['phrase']))
        return g + step


def metrical_angles(step, pos, barlen, beatphase, beatlen):
    """Rotary angles [B,T,8]: 4 time frequencies, 2 beat-phase and 2 bar-phase harmonics.

    Dot products between rotated queries and keys then depend on the time difference
    and on the difference in beat / bar phase, so "same place in the previous bar"
    is a built-in similarity, for any metre.
    """
    two_pi = 2 * math.pi
    t = step.float()[..., None] * torch.tensor([two_pi / p for p in (4, 16, 64, 256)], device=step.device)
    beat = two_pi * (beatphase.float() / beatlen.float())[..., None] * torch.tensor([1.0, 2.0], device=step.device)
    bar = two_pi * (pos.float() / barlen.float())[..., None] * torch.tensor([1.0, 2.0], device=step.device)
    return torch.cat([t, beat, bar], -1)


def rotate(x, cos, sin):
    """x [B,H,N,dh]; rotate the first 16 dims of each head in 8 pairs."""
    r = cos.shape[-1] * 2
    x1, x2 = x[..., :r:2], x[..., 1:r:2]
    y1, y2 = x1 * cos - x2 * sin, x1 * sin + x2 * cos
    return torch.cat([torch.stack([y1, y2], -1).flatten(-2), x[..., r:]], -1)


class StreamLayer(nn.Module):
    """One layer: per-stream Q/K/V/O and FFN, one causal attention over the interleaved streams."""
    def __init__(self, d, heads, ff, T, dropout):
        super().__init__()
        S = len(STREAMS)
        self.h, self.dh, self.dropout = heads, d // heads, dropout
        L = lambda a, b: nn.ModuleList([nn.Linear(a, b) for _ in range(S)])
        self.ln1 = nn.ModuleList([nn.LayerNorm(d) for _ in range(S)]); self.ln2 = nn.ModuleList([nn.LayerNorm(d) for _ in range(S)])
        self.q, self.k, self.v, self.o = L(d, d), L(d, d), L(d, d), L(d, d)
        self.ff1, self.ff2 = L(d, ff), L(ff, d)

    def forward(self, h, rq, rk):
        # h: [B, T, S, d] (time-major interleaving: index t*S + s). Causal attention over this
        # order is exactly the generation order R -> H -> B -> M per step.
        B, T, S, d = h.shape
        z = [self.ln1[s](h[:, :, s]) for s in range(S)]
        def heads(proj):
            return torch.stack([proj[s](z[s]) for s in range(S)], 2).reshape(B, T * S, self.h, self.dh).transpose(1, 2)
        q, k, v = heads(self.q), heads(self.k), heads(self.v)
        q, k = rotate(q, *rq), rotate(k, *rk)
        a = F.scaled_dot_product_attention(q, k, v, is_causal=True).transpose(1, 2).reshape(B, T, S, d)
        out = []
        for s in range(S):
            x = h[:, :, s] + F.dropout(self.o[s](a[:, :, s]), self.dropout, self.training)
            x = x + F.dropout(self.ff2[s](F.gelu(self.ff1[s](self.ln2[s](x)), approximate='tanh')), self.dropout, self.training)
            out.append(x)
        return torch.stack(out, 2)


class StructuredJoint(nn.Module):
    def __init__(self, d=96, heads=6, layers=4, ff=256, T=T_MAX, dropout=0.1):
        super().__init__()
        S = len(STREAMS); self.T, self.d = T, d
        assert d // heads >= 16, 'metrical rotary encoding needs head width >= 16'
        self.config = dict(kind='structured', d=d, heads=heads, layers=layers, ff=ff, T=T, dropout=dropout)
        self.tok = nn.ModuleList([nn.Embedding(VOCAB[s], d) for s in STREAMS])
        self.front = nn.ModuleList([nn.Embedding(VOCAB[s] + 1, d) for s in STREAMS])  # +1: none (beyond window)
        self.stream = nn.Parameter(torch.randn(S, d) * 0.02)
        self.controls = Controls(d, structural=True)
        self.chord_root, self.chord_q = nn.Embedding(13, d), nn.Embedding(N_QUAL + 1, d)
        self.since, self.change = nn.Embedding(N_SINCE, d), nn.Embedding(2, d)
        self.layers = nn.ModuleList([StreamLayer(d, heads, ff, T, dropout) for _ in range(layers)])
        self.ln_f = nn.ModuleList([nn.LayerNorm(d) for _ in range(S)])
        self.head = nn.ModuleList([nn.Linear(d, VOCAB[s]) for s in STREAMS])
        self.rel_head = nn.ModuleDict({s: nn.Linear(d, 12) for s in ('B', 'M')})

    def chord_inputs(self, b):
        """Chord features: R/H see the chord active at t, B/M the chord at t+1 (H precedes them)."""
        chord, since, change = b['chord'], b['since'], b['change']
        cur = self.chord_root(chord % 12) + self.chord_q(chord // 12) + self.since(since)
        new = self.chord_root(_next(chord) % 12) + self.chord_q(_next(chord) // 12) + self.since(_next(since)) + self.change(_next(change).long())
        return {'R': cur, 'H': cur, 'B': new, 'M': new}

    def forward(self, b, extra_step=None, return_features=False):
        S, T = len(STREAMS), self.T
        ctrl = self.controls(b, shift=1)
        chord = self.chord_inputs(b)
        xs = []
        for s, name in enumerate(STREAMS):
            x = self.tok[s](b[name]) + self.stream[s] + ctrl + chord[name]
            if extra_step is not None:
                # Optional information from completed step t only.  A sidecar can
                # predict step t+1 without exposing future expressive events.
                x = x + extra_step
            for u, uname in enumerate(STREAMS):
                if u == s:
                    continue
                tokens = b[uname]
                none = torch.full_like(tokens[:, :1], VOCAB[uname])
                # lower-ranked streams: their token at t+1 is already generated; higher-ranked: token at t
                front = torch.cat([tokens[:, 1:], none], 1) if u < s else tokens
                x = x + self.front[u](front)
            xs.append(x)
        h = torch.stack(xs, 2)                                                        # [B,T,S,d]
        B = h.shape[0]
        step = torch.arange(T, device=h.device)[None].expand(B, T)
        ang_k = metrical_angles(step, b['pos'], b['barlen'], b['beatphase'], b['beatlen'])
        ang_q = metrical_angles(step + 1, _next(b['pos']), _next(b['barlen']), _next(b['beatphase']), _next(b['beatlen']))
        # one angle per step, shared by the S streams of that step: [B,1,T*S,8]
        expand = lambda a: a.repeat_interleave(S, dim=1)[:, None]
        rq = (expand(torch.cos(ang_q)), expand(torch.sin(ang_q)))
        rk = (expand(torch.cos(ang_k)), expand(torch.sin(ang_k)))
        for layer in self.layers:
            h = layer(h, rq, rk)
        logits = {}
        nxt_root = _next(b['chord']) % 12
        for s, name in enumerate(STREAMS):
            z = self.ln_f[s](h[:, :, s])
            lg = self.head[s](z)
            if name in self.rel_head:
                rel = self.rel_head[name](z)                                         # [B,T,12]
                interval = (torch.arange(N_PITCHES[name], device=z.device)[None, None] - nxt_root[..., None]) % 12
                lg = torch.cat([lg[..., :ONSET0], lg[..., ONSET0:] + torch.gather(rel, 2, interval)], -1)
            logits[name] = lg
        return (logits, h) if return_features else logits


def _next(x):
    """Value at the target step t+1 (the last position repeats; it predicts nothing)."""
    return torch.cat([x[:, 1:], x[:, -1:]], 1)


class FlatBlock(nn.Module):
    """Pre-LN decoder block, same arithmetic as the structured layers but one set of weights."""
    def __init__(self, d, heads, ff, dropout):
        super().__init__()
        self.h, self.dh, self.dropout = heads, d // heads, dropout
        self.ln1, self.ln2 = nn.LayerNorm(d), nn.LayerNorm(d)
        self.qkv, self.o = nn.Linear(d, 3 * d), nn.Linear(d, d)
        self.ff1, self.ff2 = nn.Linear(d, ff), nn.Linear(ff, d)

    def forward(self, x):
        B, N, d = x.shape
        q, k, v = self.qkv(self.ln1(x)).reshape(B, N, 3, self.h, self.dh).permute(2, 0, 3, 1, 4)
        a = F.scaled_dot_product_attention(q, k, v, is_causal=True).transpose(1, 2).reshape(B, N, d)
        x = x + F.dropout(self.o(a), self.dropout, self.training)
        return x + F.dropout(self.ff2(F.gelu(self.ff1(self.ln2(x)), approximate='tanh')), self.dropout, self.training)


class FlatJoint(nn.Module):
    """Generic causal decoder over R0 H0 B0 M0 R1 H1 ... with the same control inputs.

    controls='full' (default): metre, position in bar, metrical level, phrase bar, local key,
    domain, style - exactly the information the structured model receives as input.
    controls='basic': metre, local key and global controls only (the first ablation run).
    No stream-specific weights, chord features, metrical rotary encoding or chord-relative
    heads: the network has to discover that structure by itself.
    """
    def __init__(self, d=96, heads=6, layers=4, ff=256, T=T_MAX, dropout=0.1, controls='full'):
        super().__init__()
        S = len(STREAMS); self.T, self.d = T, d
        self.config = dict(kind='flat', d=d, heads=heads, layers=layers, ff=ff, T=T, dropout=dropout, controls=controls)
        self.tok = nn.ModuleList([nn.Embedding(VOCAB[s], d) for s in STREAMS])
        self.stream = nn.Embedding(S, d); self.next_stream = nn.Embedding(S, d)
        self.position = nn.Embedding(S * T, d)
        self.controls = Controls(d, structural=(controls == 'full'))
        self.blocks = nn.ModuleList([FlatBlock(d, heads, ff, dropout) for _ in range(layers)])
        self.ln_f = nn.LayerNorm(d)
        self.head = nn.ModuleList([nn.Linear(d, VOCAB[s]) for s in STREAMS])

    def forward(self, b):
        S, T = len(STREAMS), self.T
        B = b['R'].shape[0]
        # controls of the step being predicted next: step t for R..B positions, t+1 after M
        ctrl_now, ctrl_next = self.controls(b, shift=0), self.controls(b, shift=1)
        ctrl = torch.stack([ctrl_now] * (S - 1) + [ctrl_next], 2)                   # [B,T,S,d]
        x = torch.stack([self.tok[s](b[n]) for s, n in enumerate(STREAMS)], 2)       # [B,T,S,d]
        x = x + self.stream.weight[None, None] + ctrl
        x = x.reshape(B, T * S, self.d)
        nxt = (torch.arange(T * S, device=x.device) + 1) % S
        x = x + self.position.weight[None] + self.next_stream(nxt)[None]
        for blk in self.blocks:
            x = blk(x)
        h = self.ln_f(x).reshape(B, T, S, self.d)                                    # flat index i predicts token i+1
        logits = {}
        for s, name in enumerate(STREAMS):
            if s == 0:
                src = h[:, :, S - 1]                                                 # t*S + S-1 -> (R, t+1)
            else:
                src = torch.cat([h[:, 1:, s - 1], h[:, -1:, s - 1]], 1)             # (t+1)*S + s-1 -> (s, t+1)
            logits[name] = self.head[s](src)
        return logits


def targets(b):
    """Target for position t is the stream token at t+1 (last position has none)."""
    out = {}
    for name in STREAMS:
        y = torch.cat([b[name][:, 1:], torch.full_like(b[name][:, :1], PAD)], 1)
        valid = torch.cat([b['valid'][:, 1:], torch.zeros_like(b['valid'][:, :1])], 1)
        y = y.masked_fill(~valid | (y == UNK), PAD)
        out[name] = y
    return out


WEIGHTS = {'R': 0.5, 'H': 1.0, 'B': 1.0, 'M': 1.0}


def loss_and_metrics(model, b):
    logits = model(b); ys = targets(b); total = 0.0; metrics = {}
    for name in STREAMS:
        lg, y = logits[name], ys[name]
        mask = y != PAD
        n = int(mask.sum())
        if n == 0:
            continue
        ce = F.cross_entropy(lg[mask], y[mask])
        total = total + WEIGHTS[name] * ce
        metrics[name] = (float(ce.detach()), n)
    return total, metrics


def count_parameters(model):
    return sum(p.numel() for p in model.parameters())
