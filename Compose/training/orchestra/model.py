"""AIlegro orchestral model: a generic decoder-only Transformer over BAR / NOTE tokens.

Pitch enters in one of two ways (config 'pitch'):
  'rotary'   (12-TET translation symmetry) - no absolute pitch embedding. Each token has a
             pitch coordinate pi; in every attention head a subspace of queries and keys is
             rotated by angles w*pi with w = 2*pi*k/12 (k = 1..6, the pitch-class harmonics)
             and a few slow frequencies (2*pi/24, /48, /96 for octave distances), so attention
             scores depend only on intervals. Values are rotated by the key's pitch and the
             output rotated back by the query's pitch ('value_rotary'), so what a head reads is
             also relative. The pitch head predicts the interval to the previous coordinate.
             With register=False the model is exactly transposition-equivariant (see
             tests/test_model.py); register=True adds a coarse absolute register (half-octave
             bins), because instrument ranges and timbre do depend on absolute pitch.
  'absolute' (baseline) - an embedding per absolute pitch and an absolute pitch head.
Time uses rotary angles from each token's onset in quarter notes (periods 1/2 to 256 quarters).

Output: at position i the model predicts token i+1 field by field, each head conditioned on
the fields already chosen: type; for a BAR meter -> tempo -> the six group bits in order
(so fixed groups condition the rest); for a NOTE position -> group -> pitch -> duration -> velocity.
"""
import math
import torch
from torch import nn
from torch.nn import functional as F
import groups as G

TIME_PERIODS = [0.5, 1, 2, 4, 8, 16, 64, 256]                         # quarters
PITCH_FREQS = [2 * math.pi * k / 12 for k in range(1, 7)] + [2 * math.pi / p for p in (24, 48, 96)]
N_REGISTER = 16                                                     # half-octave bins of pi


def rotate(x, cos, sin, lo, n):
    """Rotate dims [lo, lo+n) and [lo+n, lo+2n) of x (…, L, dh) as n complex pairs by angles (cos, sin)."""
    a, b = x[..., lo:lo + n], x[..., lo + n:lo + 2 * n]
    return torch.cat([x[..., :lo], a * cos - b * sin, a * sin + b * cos, x[..., lo + 2 * n:]], -1)


class Attention(nn.Module):
    def __init__(self, d, heads, dropout, n_time, n_pitch, value_rotary):
        super().__init__()
        self.h, self.dh = heads, d // heads
        assert 2 * (n_time + n_pitch) <= self.dh, 'head dimension too small for the rotary subspaces'
        self.qkv, self.o = nn.Linear(d, 3 * d), nn.Linear(d, d)
        self.n_time, self.n_pitch, self.value_rotary, self.dropout = n_time, n_pitch, value_rotary, dropout

    def forward(self, x, rot):
        B, L, _ = x.shape
        q, k, v = self.qkv(x).view(B, L, 3, self.h, self.dh).permute(2, 0, 3, 1, 4)
        ct, st, cp, sp = rot
        nt, np_ = self.n_time, self.n_pitch
        q, k = rotate(q, ct, st, 0, nt), rotate(k, ct, st, 0, nt)
        if np_:
            q, k = rotate(q, cp, sp, 2 * nt, np_), rotate(k, cp, sp, 2 * nt, np_)
            if self.value_rotary:
                v = rotate(v, cp, sp, 2 * nt, np_)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True, dropout_p=self.dropout if self.training else 0.0)
        if np_ and self.value_rotary:
            y = rotate(y, cp, -sp, 2 * nt, np_)          # back into the query's pitch frame
        return self.o(y.transpose(1, 2).reshape(B, L, -1))


class Block(nn.Module):
    def __init__(self, d, heads, ff, dropout, n_time, n_pitch, value_rotary):
        super().__init__()
        self.ln1, self.ln2 = nn.LayerNorm(d), nn.LayerNorm(d)
        self.att = Attention(d, heads, dropout, n_time, n_pitch, value_rotary)
        self.ff = nn.Sequential(nn.Linear(d, ff), nn.GELU(), nn.Linear(ff, d))
        self.drop = nn.Dropout(dropout)

    def forward(self, x, rot):
        x = x + self.drop(self.att(self.ln1(x), rot))
        return x + self.drop(self.ff(self.ln2(x)))


def head(d, hidden, n):
    return nn.Sequential(nn.LayerNorm(d), nn.Linear(d, hidden), nn.GELU(), nn.Linear(hidden, n))


class OrchestraTransformer(nn.Module):
    def __init__(self, d=256, heads=4, layers=6, ff=1024, dropout=0.1, pitch="rotary", register=True,
                 value_rotary=True, n_time=len(TIME_PERIODS), head_hidden=None):
        super().__init__()
        self.config = dict(d=d, heads=heads, layers=layers, ff=ff, dropout=dropout, pitch=pitch, register=register,
                           value_rotary=value_rotary, n_time=n_time, head_hidden=head_hidden)
        self.rotary_pitch = pitch == 'rotary'
        self.register = register and self.rotary_pitch
        n_pitch = len(PITCH_FREQS) if self.rotary_pitch else 0
        self.register_buffer('w_time', torch.tensor([2 * math.pi / p for p in TIME_PERIODS[:n_time]]), persistent=False)
        self.register_buffer('w_pitch', torch.tensor(PITCH_FREQS[:n_pitch] or [0.0]), persistent=False)
        n_pf = G.N_PITCHF if self.rotary_pitch else 128 + G.N_DRUM
        E = lambda n: nn.Embedding(n, d)
        # input embeddings
        self.e_type, self.e_meter, self.e_tempo, self.e_prog = E(G.N_TYPE), E(G.N_METER), E(G.N_TEMPO), E(G.N_PROG)
        self.e_bits = nn.Parameter(torch.randn(G.N_GROUPS, 2, d) * 0.02)
        self.e_pos, self.e_group, self.e_pitch, self.e_dur, self.e_vel = E(G.MAX_BAR), E(G.N_GROUPS), E(n_pf), E(G.N_DUR), E(G.N_VEL)
        self.e_register = E(N_REGISTER) if self.register else None
        self.drop = nn.Dropout(dropout)
        self.blocks = nn.ModuleList([Block(d, heads, ff, dropout, n_time, n_pitch, value_rotary) for _ in range(layers)])
        self.ln = nn.LayerNorm(d)
        # output heads and the embeddings that condition later fields on earlier ones
        hh = head_hidden or d
        self.h_type = head(d, hh, G.N_TYPE)
        self.c_type, self.c_prog = E(G.N_TYPE), E(G.N_PROG)
        self.h_meter, self.c_meter = head(d, hh, G.N_METER), E(G.N_METER)
        self.h_tempo, self.c_tempo = head(d, hh, G.N_TEMPO), E(G.N_TEMPO)
        self.h_bits = nn.ModuleList([head(d, hh, 2) for _ in range(G.N_GROUPS)])
        self.c_bits = nn.Parameter(torch.randn(G.N_GROUPS, 2, d) * 0.02)
        self.h_pos, self.c_pos = head(d, hh, G.MAX_BAR), E(G.MAX_BAR)
        self.h_group, self.c_group = head(d, hh, G.N_GROUPS), E(G.N_GROUPS)
        self.h_pitch, self.c_pitch = head(d, hh, n_pf), E(n_pf)
        self.h_dur, self.c_dur = head(d, hh, G.N_DUR), E(G.N_DUR)
        self.h_vel = head(d, hh, G.N_VEL)
        self.apply(self._init)

    @staticmethod
    def _init(m):
        if isinstance(m, (nn.Linear, nn.Embedding)):
            nn.init.normal_(m.weight, 0, 0.02)
            if isinstance(m, nn.Linear) and m.bias is not None:
                nn.init.zeros_(m.bias)

    def pitch_field(self, b):
        return b['pitchf'] if self.rotary_pitch else b['pabs']

    def embed(self, b):
        ty = b['type']
        is_bar = (ty == G.BAR).unsqueeze(-1).float(); is_note = (ty == G.NOTE).unsqueeze(-1).float()
        bits = (b['mask'].unsqueeze(-1) >> torch.arange(G.N_GROUPS, device=ty.device)) & 1          # B, L, 6
        e_bits = self.e_bits[torch.arange(G.N_GROUPS, device=ty.device), bits].sum(-2)
        x = self.e_type(ty)
        x = x + is_bar * (self.e_meter(b['meter']) + self.e_tempo(b['tempo']) + self.e_prog(b['prog']) + e_bits)
        x = x + is_note * (self.e_pos(b['pos']) + self.e_group(b['group']) + self.e_pitch(self.pitch_field(b))
                           + self.e_dur(b['dur']) + self.e_vel(b['vel']))
        if self.register:
            x = x + self.e_register(((b['pi'] - G.PITCH_LO).clamp(0, 95) // 6).clamp(0, N_REGISTER - 1))
        return x

    def rotation(self, b):
        at = b['t'].unsqueeze(-1) * self.w_time                              # B, L, nt
        ap = b['pi'].float().unsqueeze(-1) * self.w_pitch                    # B, L, np
        return at.cos().unsqueeze(1), at.sin().unsqueeze(1), ap.cos().unsqueeze(1), ap.sin().unsqueeze(1)

    def hidden(self, b):
        x = self.drop(self.embed(b))
        rot = self.rotation(b)
        for blk in self.blocks:
            x = blk(x, rot)
        return self.ln(x)

    # ------------------------------------------------------------------ training
    def forward(self, b):
        """Teacher-forced logits for the token after each position: dict field -> (B, L-1, V)."""
        h = self.hidden(b)[:, :-1]
        nxt = {k: v[:, 1:] for k, v in b.items() if torch.is_tensor(v) and v.dim() == 2}
        out = {'type': self.h_type(h)}
        hb = h + self.c_type.weight[G.BAR] + self.c_prog(b['next_prog'][:, :-1])
        out['meter'] = self.h_meter(hb); hb = hb + self.c_meter(nxt['meter'])
        out['tempo'] = self.h_tempo(hb); hb = hb + self.c_tempo(nxt['tempo'])
        bits = (nxt['mask'].unsqueeze(-1) >> torch.arange(G.N_GROUPS, device=h.device)) & 1
        for g in range(G.N_GROUPS):
            out[f'bit{g}'] = self.h_bits[g](hb); hb = hb + self.c_bits[g][bits[..., g]]
        hn = h + self.c_type.weight[G.NOTE]
        out['pos'] = self.h_pos(hn); hn = hn + self.c_pos(nxt['pos'])
        out['group'] = self.h_group(hn); hn = hn + self.c_group(nxt['group'])
        out['pitch'] = self.h_pitch(hn); hn = hn + self.c_pitch(self.pitch_field(nxt))
        out['dur'] = self.h_dur(hn); hn = hn + self.c_dur(nxt['dur'])
        out['vel'] = self.h_vel(hn)
        return out

    def loss(self, b):
        """Mean negative log-likelihood per predicted token (all its fields), and per-field means."""
        out = self.forward(b)
        ty = b['type'][:, 1:]
        valid = ty != G.PAD
        bar, note = ty == G.BAR, ty == G.NOTE
        nxt = {k: v[:, 1:] for k, v in b.items() if torch.is_tensor(v) and v.dim() == 2}
        bits = (nxt['mask'].unsqueeze(-1) >> torch.arange(G.N_GROUPS, device=ty.device)) & 1
        targets = {'type': (ty, valid), 'meter': (nxt['meter'], bar), 'tempo': (nxt['tempo'], bar),
                   'pos': (nxt['pos'], note), 'group': (nxt['group'], note), 'pitch': (self.pitch_field(nxt), note),
                   'dur': (nxt['dur'], note), 'vel': (nxt['vel'], note)}
        targets.update({f'bit{g}': (bits[..., g], bar) for g in range(G.N_GROUPS)})
        total, parts, n_tok = 0.0, {}, valid.sum().clamp(min=1)
        for name, (tgt, m) in targets.items():
            ce = F.cross_entropy(out[name].flatten(0, 1), tgt.flatten(), reduction='none').view_as(tgt) * m
            total = total + ce.sum()
            parts[name] = (ce.sum() / m.sum().clamp(min=1)).detach(), int(m.sum())
        return total / n_tok, parts


def count_parameters(model):
    return sum(p.numel() for p in model.parameters())
