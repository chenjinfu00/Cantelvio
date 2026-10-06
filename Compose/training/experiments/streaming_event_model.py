"""Untrained architecture experiment. Not a v2 checkpoint loader or runtime.
Persistent relative-position backbone; changing plans condition only event heads.
One backbone step per complete event; group is sampled before conditional attributes.
"""
import math
import torch
from torch import nn
from torch.nn import functional as F

class Attention(nn.Module):
    def __init__(self, width, heads, window):
        super().__init__()
        self.heads, self.dim, self.window = heads, width // heads, window
        assert self.dim % 2 == 0
        self.qkv = nn.Linear(width, 3 * width)
        self.out = nn.Linear(width, width)

    def rotate(self, x, positions):
        phase = positions[:, None] * torch.exp(torch.arange(0, self.dim, 2, device=x.device) * (-math.log(10000) / self.dim))
        cosine, sine = phase.cos()[None, None], phase.sin()[None, None]
        even, odd = x[..., ::2], x[..., 1::2]
        return torch.stack((even * cosine - odd * sine, even * sine + odd * cosine), -1).flatten(-2)

    def forward(self, x, positions, cache=None):
        batch, length, width = x.shape
        q, k, v = self.qkv(x).reshape(batch, length, 3, self.heads, self.dim).permute(2, 0, 3, 1, 4).unbind(0)
        q, k = self.rotate(q, positions), self.rotate(k, positions)
        key_positions = positions
        if cache is not None:
            k = torch.cat((cache[0], k), 2)
            v = torch.cat((cache[1], v), 2)
            key_positions = torch.cat((cache[2], positions))
        distance = positions[:, None] - key_positions[None, :]
        allowed = (distance >= 0) & (distance < self.window)
        output = F.scaled_dot_product_attention(q, k, v, attn_mask=allowed)
        new_cache = (k[:, :, -self.window:].detach(), v[:, :, -self.window:].detach(), key_positions[-self.window:])
        return self.out(output.transpose(1, 2).reshape(batch, length, width)), new_cache

class Block(nn.Module):
    def __init__(self, width, heads, window):
        super().__init__()
        self.norm = nn.LayerNorm(width)
        self.attention = Attention(width, heads, window)
        self.ffnorm = nn.LayerNorm(width)
        self.ff = nn.Sequential(nn.Linear(width, 4 * width), nn.GELU(), nn.Linear(4 * width, width))

    def forward(self, x, positions, cache):
        update, cache = self.attention(self.norm(x), positions, cache)
        x = x + update
        return x + self.ff(self.ffnorm(x)), cache

class StreamingEventModel(nn.Module):
    def __init__(self, event_features=32, width=96, heads=4, layers=3, window=128, time_classes=65):
        super().__init__()
        self.input = nn.Linear(event_features, width)
        self.blocks = nn.ModuleList(Block(width, heads, window) for _ in range(layers))
        self.norm = nn.LayerNorm(width)
        self.plan = nn.Linear(width, width)
        self.group = nn.Linear(width, 6)
        self.group_embedding = nn.Embedding(6, width)
        self.attributes = nn.ModuleDict({name: nn.Linear(width, size) for name, size in
            [('pitch', 128), ('duration', time_classes), ('onset_delta', time_classes),
             ('velocity', 128), ('drum_identity', 128), ('event_kind', 3)]})

    def backbone(self, events, positions=None, caches=None):
        if positions is None:
            start = 0 if caches is None else int(caches[0][2][-1]) + 1
            positions = torch.arange(start, start + events.shape[1], device=events.device)
        x = self.input(events)
        updated = []
        for index, block in enumerate(self.blocks):
            x, cache = block(x, positions, None if caches is None else caches[index])
            updated.append(cache)
        return self.norm(x), updated

    def heads(self, hidden, plan, group_ids=None):
        # A new plan can change future predictions, never past backbone K/V.
        conditioned = hidden + self.plan(plan)
        result = {'group': self.group(conditioned)}
        if group_ids is not None:
            conditioned = conditioned + self.group_embedding(group_ids)
            result.update({name: head(conditioned) for name, head in self.attributes.items()})
        return result
