"""Four-pillar v3.1 streaming composer (versioned; the prepared v3 run stays untouched).

One backbone step per complete event: a note, a chord change or the end of a bar.
The event's attributes are then decided in a fixed order, each conditioned on the
earlier ones through a small residual attribute decoder:

    kind (note | chord | end) -> onset position -> chord: root -> quality
                                                -> note:  group -> voice -> pitch -> duration -> expression

Onsets are predicted as positions within the bar (exact fractions from the frozen
time vocabulary, never before the previous event), as REMI-style position tokens
do, rather than as time shifts; the inter-onset interval is still an input.

Pitch is key-relative everywhere. Every bar has a local key (tonic, mode); a
pitch is read and written as an index relative to that tonic (see
four_pillar_v31_tonal), and the sounding MIDI pitch is recovered exactly as
tonic_ref + index - offset. Chord roots are relative to the same tonic. Chord
changes are explicit events that precede the notes at their onset, as in the
joint R/H/B/M model (harmony before bass and melody).

Attention is rotary in event order, in musical time (quarters) and in beat and
bar phase, so "the same place one bar ago" is a built-in relation. A causal
bar planner (rotary over bar distance, streamed with a cache) reads up to 511
completed bar summaries (key-relative). Bar controls (meter, tempo, key,
modulation, style, requested groups and density) and the plan condition only
the attribute decoder, never the backbone, so a new plan or control never
invalidates cached keys/values.

Reference bar (form memory, like the motif memory of the joint melody model):
a bar may restate an earlier bar that is far outside the event window. In
training the reference is the most similar earlier bar (key-relative onsets
and pitches, Jaccard >= 0.5; 40% of score bars, often 1, 2, 4, 8, 16 or 100+
bars back); a pointer over the planner's bar states learns to choose it, and
the attribute decoder reads the reference note aligned with each decision
(its next onset, and the group, pitch and duration of the note at the same
onset and rank) as inputs and as learned copy biases. At generation the
pointer chooses (or the caller names a bar, or none).
"""
from __future__ import annotations

import math

import torch
from torch import nn
from torch.nn import functional as F

from four_pillar_codec import DYNAMICS, WEDGES
from four_pillar_v31_tonal import REL_OFFSET, REL_PITCHES

CONFIG = dict(width=192, heads=6, layers=4, window=512, planner_layers=3, history_bars=512,
              voices=64, time_classes=384, attr_hidden=384, summary_dim=78)

KIND_NOTE, KIND_CHORD, KIND_END, KIND_START = 0, 1, 2, 3
PREDICTED_KINDS = 3
UNKNOWN_GROUP = 6
PITCH_UNPITCHED = REL_PITCHES          # relative pitch classes 0..138, 139 = unpitched
PITCH_CLASSES = REL_PITCHES + 1
PITCH_NONE = REL_PITCHES + 1           # input only: no pitch
ABS_UNPITCHED, ABS_NONE = 128, 129     # absolute codes inside StreamState
DEGREE_NONE, REGISTER_NONE, KEY_NONE, MODULATION_NONE = 24, 11, 24, 24
INTERVAL_NONE, INTERVAL_UNPITCHED = 49, 50
CHORD_ROOT_NONE, CHORD_QUALITY_NONE, CHORD_DEGREE_NONE = 12, 40, 12
VELOCITY_UNKNOWN = 16
LEVELS = 5
CONTINUOUS_EVENT, CONTINUOUS_ONSET, CONTINUOUS_BAR = 16, 8, 4
SLOT_FEATURES, VOICE_FEATURES, HARMONY_FEATURES = 6, 4, 25
DENSITY_BUCKETS, REGISTER_BUCKETS = 8, 8
KEY_CHANGES = 24
REF_COUNT_NONE, REF_GROUP_NONE = 5, 7     # reference notes left at the current onset 0..4+ / group 0..6
REF_POINTER = 64                          # pointer query/key size
# distance (bars) -> bucket: 1, 2, 3, 4, 5-7, 8, 9-15, 16, 17-31, 32, 33-63, 64, 65+
REF_BUCKET = torch.tensor([0] + [min(12, b) for b in (
    [0, 1, 2, 3] + [4] * 3 + [5] + [6] * 7 + [7] + [8] * 15 + [9] + [10] * 31 + [11] + [12] * 447)])
REF_BUCKETS = 13
SOURCES = ('symphony-classical', 'symphony-contemporary', 'curated-midi', 'Lieder', 'classical-scores')
SOURCE_NONE = len(SOURCES)            # style unspecified
OBJECTIVE_WEIGHTS = {'kind': 1., 'onset': 1., 'chord_root': 1., 'chord_quality': 1., 'group': 1., 'voice': 1.,
                     'pitch': 1., 'duration': 1., 'velocity': .5, 'dynamic': .25, 'accent': .25, 'wedge': .25,
                     'drum': .25, 'bar_key': .25, 'bar_pcs': .25, 'bar_groups': .25, 'bar_density': .25,
                     'bar_register': .25, 'bar_ref': .25}
CATEGORICAL = ('kind', 'onset', 'chord_root', 'chord_quality', 'group', 'voice', 'pitch', 'duration', 'velocity',
               'dynamic', 'accent', 'wedge', 'drum')
# Rotary pairs in priority order (head pairs beyond the list stay unrotated for content-only matching):
# event index / period, musical time (quarters) / period, beat phase x harmonic, bar phase x harmonic.
ROPE_SOURCES = (('index', 4.), ('time', 1.), ('beat', 1.), ('bar', 1.), ('index', 16.), ('time', 4.), ('beat', 2.),
                ('bar', 2.), ('index', 64.), ('time', 16.), ('index', 256.), ('time', 64.))
_DEGREE = (torch.arange(REL_PITCHES) - REL_OFFSET) % 12
PLANNER_PERIODS = (2., 4., 8., 16., 32., 64., 128., 256.)   # bars; remaining head pairs are content-only


def rope_tables(dim: int, index, time, beat, bar, device, dtype) -> tuple[torch.Tensor, torch.Tensor]:
    """Cosines and sines [..., dim/2] for event index, musical time and phases (tensors of equal shape).

    Phases use float64 on CPU so hours-long generation sessions stay exact (MPS lacks float64)."""
    phase_dtype = torch.float64 if torch.device(device).type == 'cpu' else torch.float32
    values = {name: torch.as_tensor(v).to(device=device, dtype=phase_dtype)
              for name, v in (('index', index), ('time', time), ('beat', beat), ('bar', bar))}
    pairs = dim // 2
    columns = []
    for kind, value in ROPE_SOURCES[:pairs]:
        scale = 2 * math.pi / value if kind in ('index', 'time') else 2 * math.pi * value
        columns.append(values[kind] * scale)
    angles = torch.stack(columns, -1)
    if pairs > len(columns):
        angles = torch.cat((angles, angles.new_zeros(*angles.shape[:-1], pairs - len(columns))), -1)
    return angles.cos().to(dtype), angles.sin().to(dtype)


def planner_rope(dim: int, index, device, dtype) -> tuple[torch.Tensor, torch.Tensor]:
    """Rotary tables over bar indices for the planner: attention depends on how many bars apart two bars are."""
    phase_dtype = torch.float64 if torch.device(device).type == 'cpu' else torch.float32
    index = torch.as_tensor(index).to(device=device, dtype=phase_dtype)
    pairs = dim // 2
    angles = torch.stack([index * (2 * math.pi / period) for period in PLANNER_PERIODS[:pairs]], -1)
    if pairs > angles.shape[-1]:
        angles = torch.cat((angles, angles.new_zeros(*angles.shape[:-1], pairs - angles.shape[-1])), -1)
    return angles.cos().to(dtype), angles.sin().to(dtype)


def apply_rope(x: torch.Tensor, rope: tuple[torch.Tensor, torch.Tensor]) -> torch.Tensor:
    cosine, sine = rope
    even, odd = x[..., ::2], x[..., 1::2]
    return torch.stack((even * cosine - odd * sine, even * sine + odd * cosine), -1).flatten(-2)


class Attention(nn.Module):
    def __init__(self, width: int, heads: int):
        super().__init__()
        if width % heads or (width // heads) % 2:
            raise ValueError('width must split into even head dimensions')
        self.heads, self.dim = heads, width // heads
        self.qkv = nn.Linear(width, 3 * width)
        self.out = nn.Linear(width, width)

    def forward(self, x: torch.Tensor, rope: tuple) -> torch.Tensor:
        """Full causal pass over a training window; rope tables [B, T, dim/2]."""
        b, t, w = x.shape
        q, k, v = self.qkv(x).reshape(b, t, 3, self.heads, self.dim).permute(2, 0, 3, 1, 4).unbind(0)
        tables = (rope[0][:, None], rope[1][:, None])
        q, k = apply_rope(q, tables), apply_rope(k, tables)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        return self.out(y.transpose(1, 2).reshape(b, t, w))

    def step(self, x: torch.Tensor, rope: tuple, cache: dict) -> torch.Tensor:
        """One event with a ring-buffer cache of at most `window` past events (rope: its tables [1, dim/2])."""
        q, k, v = self.qkv(x).reshape(1, 1, 3, self.heads, self.dim).permute(2, 0, 3, 1, 4).unbind(0)
        q, k = apply_rope(q, rope), apply_rope(k, rope)
        slot = cache['count'] % cache['k'].shape[2]
        cache['k'][:, :, slot] = k[:, :, 0]
        cache['v'][:, :, slot] = v[:, :, 0]
        cache['count'] += 1
        used = min(cache['count'], cache['k'].shape[2])
        y = F.scaled_dot_product_attention(q, cache['k'][:, :, :used], cache['v'][:, :, :used])
        return self.out(y.transpose(1, 2).reshape(1, 1, -1))


class Block(nn.Module):
    """Pre-norm transformer block (rotary self-attention, GELU feed-forward)."""

    def __init__(self, width: int, heads: int):
        super().__init__()
        self.norm = nn.LayerNorm(width)
        self.attention = Attention(width, heads)
        self.ffnorm = nn.LayerNorm(width)
        self.ff = nn.Sequential(nn.Linear(width, 4 * width), nn.GELU(), nn.Linear(4 * width, width))

    def forward(self, x, rope):
        x = x + self.attention(self.norm(x), rope)
        return x + self.ff(self.ffnorm(x))

    def step(self, x, rope, cache):
        x = x + self.attention.step(self.norm(x), rope, cache)
        return x + self.ff(self.ffnorm(x))


class Residual(nn.Module):
    """Pre-norm feed-forward update; the output layer starts at zero."""

    def __init__(self, width: int, hidden: int):
        super().__init__()
        self.norm = nn.LayerNorm(width)
        self.up = nn.Linear(width, hidden)
        self.down = nn.Linear(hidden, width)
        nn.init.zeros_(self.down.weight)
        nn.init.zeros_(self.down.bias)

    def forward(self, x):
        return x + self.down(F.gelu(self.up(self.norm(x))))


class Head(nn.Module):
    def __init__(self, width: int, size: int):
        super().__init__()
        self.norm = nn.LayerNorm(width)
        self.linear = nn.Linear(width, size)

    def forward(self, x):
        return self.linear(self.norm(x))


def circulant(kernel: torch.Tensor) -> torch.Tensor:
    """12x12 matrix M with M[i, j] = kernel[(j - i) mod 12] (pitch-class correlation)."""
    index = (torch.arange(12)[None, :] - torch.arange(12)[:, None]) % 12
    return kernel[index.to(kernel.device)]


class FourPillarV31(nn.Module):
    def __init__(self, config: dict | None = None):
        super().__init__()
        c = dict(CONFIG if config is None else config)
        self.config = c
        w, v, k = c['width'], c['voices'], c['time_classes']
        # Committed-event inputs: categorical embeddings plus a few phases.
        self.kind_in = nn.Embedding(4, w)
        self.group_in = nn.Embedding(7, w)
        self.pitch_in = nn.Embedding(PITCH_NONE + 1, w)     # key-relative pitch, unpitched, none
        self.degree_in = nn.Embedding(DEGREE_NONE + 1, w)   # scale degree x mode, none
        self.register_in = nn.Embedding(REGISTER_NONE + 1, w)  # sounding octave (instrument range), none
        self.drum_in = nn.Embedding(129, w)
        self.voice_in = nn.Embedding(v + 1, w)
        self.interval_in = nn.Embedding(51, w)
        self.delta_in = nn.Embedding(k + 1, w)        # inter-onset interval (input only)
        self.position_in = nn.Embedding(k + 1, w)     # onset position within the bar
        self.duration_in = nn.Embedding(k + 1, w)
        self.velocity_in = nn.Embedding(17, w)
        self.dynamic_in = nn.Embedding(len(DYNAMICS) + 1, w)
        self.accent_in = nn.Embedding(3, w)
        self.wedge_in = nn.Embedding(len(WEDGES) + 1, w)
        self.beat_in = nn.Embedding(17, w)
        self.level_in = nn.Embedding(LEVELS, w)
        self.key_in = nn.Embedding(KEY_NONE + 1, w)
        self.chord_root_in = nn.Embedding(CHORD_ROOT_NONE + 1, w)
        self.chord_quality_in = nn.Embedding(CHORD_QUALITY_NONE + 1, w)
        self.chord_degree_in = nn.Embedding(CHORD_DEGREE_NONE + 1, w)   # a note's interval above the chord root
        self.continuous_in = nn.Linear(CONTINUOUS_EVENT, w)
        self.input_norm = nn.LayerNorm(w)
        self.blocks = nn.ModuleList(Block(w, c['heads']) for _ in range(c['layers']))
        self.norm = nn.LayerNorm(w)
        # Causal bar planner over completed bar summaries (rotary over bar distance; streams with a cache).
        self.summary_input = nn.Linear(c['summary_dim'], w)
        self.planner = nn.ModuleList(Block(w, c['heads']) for _ in range(c['planner_layers']))
        self.plan_empty = nn.Parameter(torch.zeros(w))
        self.plan_norm = nn.LayerNorm(w)
        # Bar controls known when a bar is generated.
        self.meter_num_in = nn.Embedding(17, w)
        self.meter_den_in = nn.Embedding(6, w)
        self.groups_ctrl = nn.Linear(7, w)
        self.density_ctrl = nn.Embedding(DENSITY_BUCKETS + 1, w)
        self.bar_continuous = nn.Linear(CONTINUOUS_BAR, w)
        self.modulation_in = nn.Embedding(MODULATION_NONE + 1, w)
        self.source_in = nn.Embedding(SOURCE_NONE + 1, w)      # corpus style (like the joint model's style input)
        # Bar-level objectives: next key from the plan; content of the bar from plan + its modulation.
        self.bar_key = nn.Linear(w, KEY_CHANGES)
        self.bar_pcs = nn.Linear(w, 12)
        self.bar_groups = nn.Linear(w, 6)
        self.bar_density = nn.Linear(w, DENSITY_BUCKETS)
        self.bar_register = nn.Linear(w, REGISTER_BUCKETS)
        # Reference bar: pointer over earlier bars' planner states (or none) and aligned decoder inputs.
        self.ref_query = nn.Linear(w, REF_POINTER)
        self.ref_key = nn.Linear(w, REF_POINTER)
        self.ref_none = nn.Linear(w, 1)
        self.ref_distance = nn.Parameter(torch.zeros(REF_BUCKETS))
        self.ref_next_in = nn.Embedding(k + 1, w)            # next reference onset after the current position
        self.ref_remain_in = nn.Embedding(REF_COUNT_NONE + 1, w)
        self.ref_group_in = nn.Embedding(REF_GROUP_NONE + 1, w)
        self.ref_pitch_in = nn.Embedding(PITCH_NONE + 1, w)   # key-relative, read in the current key
        self.ref_duration_in = nn.Embedding(k + 1, w)
        self.ref_pcs = nn.Linear(12, w)                       # degrees the reference sounds at this onset
        self.copy = nn.Parameter(torch.zeros(4))              # copy biases: next onset, stay, group, duration
        self.copy_pitch = nn.Parameter(torch.zeros(7))        # pitch copy bias per group
        # Attribute decoder.
        hidden = c['attr_hidden']
        self.steps = nn.ModuleDict({name: Residual(w, hidden) for name in
                                    ('kind', 'onset', 'chord_root', 'group', 'voice', 'pitch', 'duration')})
        self.onset_continuous = nn.Linear(CONTINUOUS_ONSET, w)
        self.voice_state = nn.Linear(VOICE_FEATURES, w)
        self.harmony_state = nn.Linear(HARMONY_FEATURES, w)
        self.heads = nn.ModuleDict({
            'kind': Head(w, PREDICTED_KINDS), 'onset': Head(w, k), 'chord_root': Head(w, 12),
            'chord_quality': Head(w, CHORD_QUALITY_NONE), 'group': Head(w, 6), 'voice': Head(w, v),
            'pitch': Head(w, PITCH_CLASSES), 'degree': Head(w, 12), 'register': Head(w, 11), 'chord_rel': Head(w, 12),
            'duration': Head(w, k),
            'velocity': Head(w, 128), 'dynamic': Head(w, len(DYNAMICS) + 1), 'accent': Head(w, 3),
            'wedge': Head(w, len(WEDGES) + 1), 'drum': Head(w, 128)})
        self.slot_bias = nn.Sequential(nn.Linear(SLOT_FEATURES, 32), nn.GELU(), nn.Linear(32, 1))
        # Pitch priors (relative to the key; start neutral).
        self.interval_bias = nn.Parameter(torch.zeros(7, 50))    # group x (-24..24 semitones, 49 = farther)
        self.sounding_kernel = nn.Parameter(torch.zeros(12))
        self.bass_kernel = nn.Parameter(torch.zeros(12))
        self.chord_kernel = nn.Parameter(torch.zeros(12))
        self.scale_bias = nn.Parameter(torch.zeros(2, 12))       # mode x scale degree
        self._initialize()

    def _initialize(self):
        """Small GPT-style initialization; residual outputs and priors start at zero."""
        for module in self.modules():
            if isinstance(module, (nn.Linear, nn.Embedding)):
                nn.init.normal_(module.weight, std=.02)
                if isinstance(module, nn.Linear) and module.bias is not None:
                    nn.init.zeros_(module.bias)
        for step in self.steps.values():
            nn.init.zeros_(step.down.weight)
            nn.init.zeros_(step.down.bias)

    # ------------------------------------------------------------------ inputs and backbone
    def embed_events(self, e: dict) -> torch.Tensor:
        x = (self.kind_in(e['in_kind']) + self.group_in(e['in_group']) + self.pitch_in(e['in_pitch'])
             + self.degree_in(e['in_degree']) + self.register_in(e['in_register']) + self.drum_in(e['in_drum'])
             + self.voice_in(e['in_voice']) + self.interval_in(e['in_interval']) + self.delta_in(e['in_delta'])
             + self.position_in(e['in_position'])
             + self.duration_in(e['in_duration']) + self.velocity_in(e['in_velocity'])
             + self.dynamic_in(e['in_dynamic']) + self.accent_in(e['in_accent']) + self.wedge_in(e['in_wedge'])
             + self.beat_in(e['in_beat']) + self.level_in(e['in_level']) + self.key_in(e['in_key'])
             + self.chord_root_in(e['in_chord_root']) + self.chord_quality_in(e['in_chord_quality'])
             + self.chord_degree_in(e['in_chord_degree']) + self.continuous_in(e['in_cont']))
        return self.input_norm(x)

    def rope(self, e: dict, device, dtype) -> tuple:
        b, t = e['in_kind'].shape
        index = torch.arange(t, device=device).expand(b, t)
        return rope_tables(self.config['width'] // self.config['heads'], index, e['rope_time'], e['rope_beat'],
                           e['rope_bar'], device, dtype)

    def backbone(self, x: torch.Tensor, rope: tuple) -> torch.Tensor:
        if x.shape[1] > self.config['window']:
            raise ValueError('training window longer than the attention window')
        for block in self.blocks:
            x = block(x, rope)
        return self.norm(x)

    def new_cache(self) -> list[dict]:
        c = self.config
        shape = (1, c['heads'], c['window'], c['width'] // c['heads'])
        param = next(self.parameters())
        return [{'k': torch.zeros(shape, dtype=param.dtype), 'v': torch.zeros(shape, dtype=param.dtype), 'count': 0}
                for _ in self.blocks]

    def event_rope(self, index: int, time: float, beat: float, bar: float, device='cpu', dtype=torch.float32):
        return rope_tables(self.config['width'] // self.config['heads'], torch.tensor([index]),
                           torch.tensor([time], dtype=torch.float64), torch.tensor([beat], dtype=torch.float64),
                           torch.tensor([bar], dtype=torch.float64), device, dtype)

    def backbone_step(self, x: torch.Tensor, rope: tuple, cache: list[dict]) -> torch.Tensor:
        """Reference streaming step (the sampler uses an equivalent fused path)."""
        for block, layer_cache in zip(self.blocks, cache):
            x = block.step(x, rope, layer_cache)
        return self.norm(x)

    # ------------------------------------------------------------------ planner
    def plan_bars(self, history: torch.Tensor) -> torch.Tensor:
        """history [B, H, summary] of completed bars (right-padded). Output j = plan for the bar after j."""
        b, n = history.shape[:2]
        if n == 0:
            return history.new_zeros(b, 0, self.config['width'])
        if n > self.config['history_bars']:
            raise ValueError('history exceeds the planner limit')
        rope = planner_rope(self.config['width'] // self.config['heads'], torch.arange(n, device=history.device),
                            history.device, history.dtype)
        rope = (rope[0].expand(b, -1, -1), rope[1].expand(b, -1, -1))
        h = self.summary_input(history)
        for block in self.planner:
            h = block(h, rope)
        return self.plan_norm(h)

    def new_planner_cache(self) -> list[dict]:
        """Ring buffer of the last history_bars - 1 completed bars (the training history length)."""
        c = self.config
        shape = (1, c['heads'], c['history_bars'] - 1, c['width'] // c['heads'])
        param = next(self.parameters())
        return [{'k': torch.zeros(shape, dtype=param.dtype), 'v': torch.zeros(shape, dtype=param.dtype), 'count': 0}
                for _ in self.planner]

    def planner_step(self, summary: torch.Tensor, bar_index: int, cache: list[dict]) -> torch.Tensor:
        """Add one completed bar [1, 1, summary]; returns the plan for the next bar [1, 1, w]."""
        rope = planner_rope(self.config['width'] // self.config['heads'], torch.tensor([bar_index]), summary.device,
                            summary.dtype)
        h = self.summary_input(summary)
        for block, layer_cache in zip(self.planner, cache):
            h = block.step(h, rope, layer_cache)
        return self.plan_norm(h)

    def gather_plans(self, plans: torch.Tensor, index: torch.Tensor) -> torch.Tensor:
        """index [B, N]: planner output row, or -1 for a bar with no completed history."""
        empty = self.plan_norm(self.plan_empty)[None, None].expand(index.shape[0], index.shape[1], -1)
        if plans.shape[1] == 0:
            return empty
        safe = index.clamp_min(0)
        gathered = torch.gather(plans, 1, safe[..., None].expand(-1, -1, plans.shape[-1]))
        return torch.where(index[..., None] >= 0, gathered, empty)

    def bar_condition(self, plan: torch.Tensor, b: dict) -> torch.Tensor:
        return (plan + self.meter_num_in(b['ctrl_meter_num']) + self.meter_den_in(b['ctrl_meter_den'])
                + self.groups_ctrl(b['ctrl_groups']) + self.density_ctrl(b['ctrl_density'])
                + self.bar_continuous(b['ctrl_cont']) + self.key_in(b['ctrl_key'])
                + self.modulation_in(b['ctrl_modulation']) + self.source_in(b['ctrl_source']))

    def key_logits(self, plan: torch.Tensor) -> torch.Tensor:
        """Key of the next bar relative to the current tonic, (tonic step) + 12 * mode."""
        return self.bar_key(plan)

    def bar_outputs(self, plan: torch.Tensor, modulation: torch.Tensor) -> dict:
        shaped = plan + self.modulation_in(modulation)
        return {'bar_key': self.key_logits(plan), 'bar_pcs': self.bar_pcs(shaped), 'bar_groups': self.bar_groups(shaped),
                'bar_density': self.bar_density(shaped), 'bar_register': self.bar_register(shaped)}

    def ref_logits(self, query: torch.Tensor, keys: torch.Tensor, distance: torch.Tensor) -> torch.Tensor:
        """Pointer [..., 1 + H]: column 0 = no reference, column 1 + h = earlier bar h. query [B, N, w] (plan of the
        new bar), keys [B, H, w] (planner states of earlier bars), distance [B, N, H] bars back (< 1 = unavailable)."""
        scores = self.ref_query(query) @ self.ref_key(keys).transpose(-1, -2) / math.sqrt(REF_POINTER)
        bucket = REF_BUCKET.to(distance.device)[distance.clamp(1, len(REF_BUCKET) - 1)]
        scores = (scores + self.ref_distance[bucket]).masked_fill(distance < 1, torch.finfo(scores.dtype).min)
        return torch.cat((self.ref_none(query), scores), -1)

    def lookahead(self, ref_next, ref_remain):
        """Reference inputs before the kind/onset decisions."""
        return self.ref_next_in(ref_next) + self.ref_remain_in(ref_remain)

    @staticmethod
    def _copy(logits, index, weight):
        """Add `weight` to the logit of class `index` where index < number of classes (else nothing)."""
        size = logits.shape[-1]
        hot = F.one_hot(index.clamp(max=size - 1), size).to(logits.dtype) * (index < size)[..., None].to(logits.dtype)
        return logits + hot * weight

    # ------------------------------------------------------------------ attribute decoder
    def kind_logits(self, z):
        return self.heads['kind'](z)

    def after_kind(self, z, kind):
        return self.steps['kind'](z + self.kind_in(kind))

    def onset_logits(self, z, low=None, high=None, ref_next=None, ref_here=None):
        """Onset positions; with [low, high) given, positions before the previous event (or at it, for a chord)
        and at or after the bar end are excluded, as in generation. ref_next/ref_here: copy biases toward the
        reference's next onset and toward staying at the current onset while the reference has notes left there."""
        logits = self.heads['onset'](z)
        if ref_next is not None:
            logits = self._copy(self._copy(logits, ref_next, self.copy[0]), ref_here, self.copy[1])
        if low is None:
            return logits
        index = torch.arange(logits.shape[-1], device=logits.device)
        allowed = (index >= low[..., None]) & (index < high[..., None])
        return logits.masked_fill(~allowed, torch.finfo(logits.dtype).min)

    def after_onset(self, z, position, beat, level, onset_cont, ref_group, ref_pitch, ref_duration, ref_pcs):
        """ref_*: the reference note aligned with this event (same onset, same rank among its notes) and the
        degrees the reference sounds at this onset."""
        return self.steps['onset'](z + self.position_in(position) + self.beat_in(beat) + self.level_in(level)
                                   + self.onset_continuous(onset_cont) + self.ref_group_in(ref_group)
                                   + self.ref_pitch_in(ref_pitch) + self.ref_duration_in(ref_duration)
                                   + self.ref_pcs(ref_pcs))

    def chord_root_logits(self, z):
        return self.heads['chord_root'](z)

    def after_chord_root(self, z, root):
        return self.steps['chord_root'](z + self.chord_root_in(root))

    def chord_quality_logits(self, z):
        return self.heads['chord_quality'](z)

    def group_logits(self, z, ref_group):
        return self._copy(self.heads['group'](z), ref_group, self.copy[2])

    def after_group(self, z, group):
        return self.steps['group'](z + self.group_in(group))

    def voice_logits(self, z, slot_features):
        """slot_features [..., V, 6]: exists, new, group match, recencies, sounding."""
        logits = self.heads['voice'](z) + self.slot_bias(slot_features).squeeze(-1)
        allowed = ((slot_features[..., 0] > .5) & (slot_features[..., 2] > .5)) | (slot_features[..., 1] > .5)
        return logits.masked_fill(~allowed, torch.finfo(logits.dtype).min)

    def after_voice(self, z, voice, last_relative, previous_interval, voice_features, harmony_features, chord_root,
                    chord_quality):
        """previous_interval: the interval by which this voice reached its last note (melodic momentum)."""
        return self.steps['voice'](z + self.voice_in(voice) + self.pitch_in(last_relative)
                                   + self.interval_in(previous_interval) + self.voice_state(voice_features)
                                   + self.harmony_state(harmony_features) + self.chord_root_in(chord_root)
                                   + self.chord_quality_in(chord_quality))

    def pitch_logits(self, z, tonic_ref, last_pitch, sounding, bass, chord_tones, chord_root, mode, group, ref_pitch):
        """Key-relative pitch logits [..., 140]: full head + scale-degree head + sounding-octave head + priors
        (interval from the voice, sounding/bass/chord pitch classes, chord-relative, mode scale). Classes that
        would sound outside MIDI 0..127 are excluded. tonic_ref/last_pitch (absolute)/bass/chord_root/mode/group: [...] integer
        tensors; sounding/chord_tones: [..., 12] key-relative pitch-class vectors; ref_pitch: the aligned reference
        pitch (copy bias per group; PITCH_NONE for none)."""
        logits = self._copy(self.heads['pitch'](z), ref_pitch, self.copy_pitch[group][..., None])
        index = torch.arange(REL_PITCHES, device=z.device)
        degree = _DEGREE.to(z.device)
        absolute = tonic_ref[..., None] + index - REL_OFFSET
        valid = (absolute >= 0) & (absolute <= 127)
        has_last = last_pitch < 128
        step = absolute - last_pitch.clamp(max=127)[..., None]
        interval_index = torch.where(step.abs() <= 24, step + 24, torch.full_like(step, 49))
        interval = torch.where(has_last[..., None], self.interval_bias[group[..., None], interval_index],
                               torch.zeros((), device=z.device))
        bass_hot = F.one_hot(bass.clamp(max=11), 12).to(z.dtype) * (bass < 12)[..., None].to(z.dtype)
        pitch_class = (sounding @ circulant(self.sounding_kernel) + bass_hot @ circulant(self.bass_kernel)
                       + chord_tones @ circulant(self.chord_kernel))
        relative = self.heads['chord_rel'](z)                      # [..., 12] over intervals above the chord root
        gather = (torch.arange(12, device=z.device) - chord_root.clamp(max=11)[..., None]) % 12
        chord_term = torch.gather(relative, -1, gather) * (chord_root < 12)[..., None].to(z.dtype)
        # Factorized terms: scale degree in the key (all octaves) and sounding octave (instrument range).
        per_degree = pitch_class + chord_term + self.scale_bias[mode] + self.heads['degree'](z)
        octave = absolute.clamp(0, 127) // 12
        register = torch.gather(self.heads['register'](z), -1, octave)
        pitched = logits[..., :REL_PITCHES] + interval + per_degree[..., degree] + register
        pitched = pitched.masked_fill(~valid, torch.finfo(pitched.dtype).min)
        return torch.cat((pitched, logits[..., REL_PITCHES:]), -1)

    def after_pitch(self, z, pitch, interval):
        return self.steps['pitch'](z + self.pitch_in(pitch) + self.interval_in(interval))

    def duration_logits(self, z, ref_duration):
        return self._copy(self.heads['duration'](z), ref_duration, self.copy[3])

    def after_duration(self, z, duration):
        return self.steps['duration'](z + self.duration_in(duration))

    def expression_logits(self, z):
        return {name: self.heads[name](z) for name in ('velocity', 'dynamic', 'accent', 'wedge', 'drum')}

    # ------------------------------------------------------------------ training
    def forward(self, batch: dict) -> dict:
        """Logits [B, T, C] per attribute. Chord heads are computed on chord rows and note heads on note rows
        only (other rows hold zeros and carry no targets)."""
        x = self.embed_events(batch)
        hidden = self.backbone(x, self.rope(batch, x.device, x.dtype))
        plans = self.plan_bars(batch['history'])
        bar_plan = self.gather_plans(plans, batch['bar_plan_index'])            # [B, NB, w]
        bar_cond = self.bar_condition(bar_plan, batch)
        event_cond = torch.gather(bar_cond, 1, batch['bar_of_event'][..., None].expand(-1, -1, bar_cond.shape[-1]))
        z = hidden + event_cond + self.lookahead(batch['rf_next'], batch['rf_remain'])
        out = {'kind': self.kind_logits(z)}
        z = self.after_kind(z, batch['tg_kind'].clamp(max=KIND_CHORD))
        out['onset'] = self.onset_logits(z, batch['at_onset_lo'], batch['at_onset_hi'], batch['rf_next'], batch['rf_here'])
        z = self.after_onset(z, batch['tg_onset'].clamp_min(0), batch['at_beat'], batch['at_level'], batch['at_cont'],
                             batch['rf_group'], batch['rf_pitch'], batch['rf_duration'], batch['rf_pcs'])
        kind = batch['tg_kind']

        def dense(rows, values):
            full = values.new_zeros(*rows.shape, *values.shape[1:])
            full[rows] = values
            return full

        chords = kind == KIND_CHORD
        zc = z[chords]
        out['chord_root'] = dense(chords, self.chord_root_logits(zc))
        out['chord_quality'] = dense(chords, self.chord_quality_logits(self.after_chord_root(zc, batch['tg_chord_root'][chords])))
        notes = kind == KIND_NOTE
        n = {name: batch[name][notes] for name in (
            'tg_group_in', 'slot_feat', 'tg_voice', 'vs_last_rel', 'vs_prev_interval', 'vs_feat', 'harm_feat', 'chord_root',
            'chord_quality', 'tonic_ref', 'vs_last_abs', 'harm_pcs', 'bass_rel', 'chord_tones', 'mode', 'tg_pitch',
            'tg_interval', 'tg_duration', 'rf_group', 'rf_pitch', 'rf_duration')}
        zn = z[notes]
        out['group'] = dense(notes, self.group_logits(zn, n['rf_group']))
        zn = self.after_group(zn, n['tg_group_in'])
        out['voice'] = dense(notes, self.voice_logits(zn, n['slot_feat']))
        zn = self.after_voice(zn, n['tg_voice'].clamp_min(0), n['vs_last_rel'], n['vs_prev_interval'], n['vs_feat'],
                              n['harm_feat'], n['chord_root'], n['chord_quality'])
        out['pitch'] = dense(notes, self.pitch_logits(zn, n['tonic_ref'], n['vs_last_abs'], n['harm_pcs'], n['bass_rel'],
                                                      n['chord_tones'], n['chord_root'], n['mode'], n['tg_group_in'],
                                                      n['rf_pitch']))
        zn = self.after_pitch(zn, n['tg_pitch'], n['tg_interval'])
        out['duration'] = dense(notes, self.duration_logits(zn, n['rf_duration']))
        zn = self.after_duration(zn, n['tg_duration'].clamp_min(0))
        out.update({name: dense(notes, value) for name, value in self.expression_logits(zn).items()})
        out.update(self.bar_outputs(bar_plan, batch['ctrl_modulation']))
        candidates = torch.arange(plans.shape[1], device=plans.device)
        out['bar_ref'] = self.ref_logits(bar_plan, plans, batch['bar_plan_index'][..., None] + 1 - candidates)
        return out

    def loss(self, batch: dict, weights: dict | None = None):
        weights = OBJECTIVE_WEIGHTS if weights is None else weights
        out = self(batch)
        report, total = {}, 0.
        for name in CATEGORICAL + ('bar_key', 'bar_density', 'bar_register', 'bar_ref'):
            known = batch['kn_' + name]
            target = batch['bt_' + name] if name.startswith('bar_') else batch['tg_' + name]
            count = int(known.sum())
            value = F.cross_entropy(out[name][known].float(), target[known]) if count else out[name].sum() * 0.
            report[name] = {'loss': float(value.detach()), 'known': count}
            total = total + weights[name] * value
        known = batch['kn_bar_pcs']
        count = int(known.sum())
        pcs = (-(batch['bt_bar_pcs'][known] * F.log_softmax(out['bar_pcs'][known].float(), -1)).sum(-1).mean()
               if count else out['bar_pcs'].sum() * 0.)
        report['bar_pcs'] = {'loss': float(pcs.detach()), 'known': count}
        total = total + weights['bar_pcs'] * pcs
        known = batch['kn_bar_groups']
        count = int(known.sum())
        groups = (F.binary_cross_entropy_with_logits(out['bar_groups'][known].float(), batch['bt_bar_groups'][known])
                  if count else out['bar_groups'].sum() * 0.)
        report['bar_groups'] = {'loss': float(groups.detach()), 'known': count}
        total = total + weights['bar_groups'] * groups
        if not torch.isfinite(total):
            raise FloatingPointError('nonfinite v3.1 objective')
        return total, report
