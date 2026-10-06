"""Two-scale *technical trial* composer, separate from the deployed runtime.

The form planner sees completed bars only. The event decoder writes the exact
score-wire sequence autoregressively, including independent voices and group/
role choices before pitch. This does not yet implement the complete v1 spec:
notably the old joint-model prior and constrained score-length sampling remain
separate integration gates. Never export these trial weights to the webpage.
"""
from __future__ import annotations

import math

import torch
from torch import nn

from four_pillar_codec import (GROUP_BASE, GROUPS, PAD, PITCH_BASE, ROLE_BASE,
                               ROLES, VOCAB_SIZE)

SUMMARY_DIM = 20  # pitch-class histogram, six groups, density, mean register
PLAN_BARS = 4


class FourPillarTrial(nn.Module):
    def __init__(self, *, width: int = 192, heads: int = 6,
                 planner_layers: int = 4, decoder_layers: int = 6,
                 history_bars: int = 32, context: int = 256,
                 vocab_size: int = VOCAB_SIZE):
        super().__init__()
        if width % heads or min(planner_layers, decoder_layers, history_bars, context) < 1:
            raise ValueError('invalid trial model configuration')
        if vocab_size < VOCAB_SIZE:
            raise ValueError('event vocabulary cannot omit the exact-time score tokens')
        self.config = dict(width=width, heads=heads, planner_layers=planner_layers,
                           decoder_layers=decoder_layers, history_bars=history_bars,
                           context=context, vocab_size=vocab_size)
        self.summary_input = nn.Linear(SUMMARY_DIM, width)
        self.bar_position = nn.Embedding(history_bars, width)
        plan_layer = nn.TransformerEncoderLayer(width, heads, width * 4, dropout=0.1,
                                                batch_first=True, norm_first=True)
        self.planner = nn.TransformerEncoder(plan_layer, planner_layers,
                                             enable_nested_tensor=False)
        self.plan_projection = nn.Linear(width, PLAN_BARS * width)
        self.summary_head = nn.Linear(width, SUMMARY_DIM)
        self.motif_query = nn.Linear(width, width)
        self.no_motif = nn.Linear(width, 1)
        self.token = nn.Embedding(vocab_size, width)
        self.token_position = nn.Embedding(context + 1, width)
        self.material_sentinel = nn.Parameter(torch.zeros(1, 1, width))
        material_layer = nn.TransformerEncoderLayer(width, heads, width * 2, dropout=0.1,
                                                    batch_first=True, norm_first=True)
        self.material_encoder = nn.TransformerEncoder(material_layer, 2,
                                                       enable_nested_tensor=False)
        decoder_layer = nn.TransformerDecoderLayer(width, heads, width * 4, dropout=0.1,
                                                   batch_first=True, norm_first=True)
        self.decoder = nn.TransformerDecoder(decoder_layer, decoder_layers)
        self.logits = nn.Linear(width, vocab_size)

    def forward(self, *, history: torch.Tensor, history_known: torch.Tensor,
                decoder_input: torch.Tensor, material: torch.Tensor,
                material_known: torch.Tensor, allowed_groups: torch.Tensor | None = None,
                planner_context: torch.Tensor | None = None,
                extra_memory: torch.Tensor | None = None,
                extra_memory_known: torch.Tensor | None = None,
                allowed_roles: torch.Tensor | None = None,
                allowed_pitches: torch.Tensor | None = None,
                locked_tokens: torch.Tensor | None = None,
                locked_mask: torch.Tensor | None = None,
                token_additions: torch.Tensor | None = None) -> dict:
        """No future target summary enters the planner or decoder memory.

        history [B,H,20] is completed bars only; material is user-supplied
        future material or a training subset explicitly selected as supplied.
        decoder_input is teacher-forced prefix only (target shifted right).
        """
        B, H, F = history.shape
        B2, L = decoder_input.shape
        if B != B2 or F != SUMMARY_DIM or H != self.config['history_bars']:
            raise ValueError('history must be [batch, history_bars, 20]')
        if history_known.shape != (B, H) or history_known.dtype != torch.bool:
            raise ValueError('history mask must be boolean [batch, history_bars]')
        if L < 1 or L > self.config['context'] or material.shape[0] != B:
            raise ValueError('invalid event/material shape')
        if material_known.shape != material.shape or material_known.dtype != torch.bool:
            raise ValueError('material known mask mismatch')
        if not history_known.any(dim=1).all():
            raise ValueError('each sample requires a completed bar')
        if (decoder_input < 0).any() or (decoder_input >= self.config['vocab_size']).any():
            raise ValueError('event token outside vocabulary')
        if material.numel() and ((material[material_known] < 0).any() or
                                 (material[material_known] >= self.config['vocab_size']).any()):
            raise ValueError('known material token outside vocabulary')

        bar_pos = torch.arange(H, device=history.device)
        bar_x = self.summary_input(history) + self.bar_position(bar_pos)[None]
        causal_bars = torch.triu(torch.ones(H, H, device=history.device, dtype=torch.bool), diagonal=1)
        bar_hidden = self.planner(bar_x, mask=causal_bars,
                                  src_key_padding_mask=~history_known)
        last_idx = history_known.long().sum(1) - 1
        last = bar_hidden[torch.arange(B, device=history.device), last_idx]
        if planner_context is not None:
            if planner_context.shape != last.shape:
                raise ValueError('planner context must be [batch,width]')
            last = last + planner_context
        plan = self.plan_projection(last).view(B, PLAN_BARS, -1)
        predicted_summary = self.summary_head(plan)
        motif_logits = torch.cat((self.no_motif(plan[:, 0]),
                                  torch.einsum('bd,bhd->bh', self.motif_query(plan[:, 0]), bar_hidden)
                                  / math.sqrt(plan.shape[-1])), dim=-1)
        motif_logits[:, 1:] = motif_logits[:, 1:].masked_fill(~history_known,
                                                               torch.finfo(motif_logits.dtype).min)

        material = material.masked_fill(~material_known, PAD)
        M = material.shape[1]
        sentinel = self.material_sentinel.expand(B, -1, -1)
        if M:
            if M > self.config['context']:
                raise ValueError('material exceeds context')
            mat_pos = torch.arange(1, M + 1, device=history.device)
            mat_x = self.token(material) * material_known[..., None]
            mat_x = mat_x + self.token_position(mat_pos)[None] * material_known[..., None]
            mat_in = torch.cat((sentinel, mat_x), dim=1)
            mat_pad = torch.cat((torch.zeros(B, 1, dtype=torch.bool, device=history.device),
                                 ~material_known), dim=1)
            mat_hidden = self.material_encoder(mat_in, src_key_padding_mask=mat_pad)
            memory = torch.cat((plan, mat_hidden), dim=1)
            memory_pad = torch.cat((torch.zeros(B, PLAN_BARS, dtype=torch.bool,
                                               device=history.device), mat_pad), dim=1)
        else:
            memory = torch.cat((plan, sentinel), dim=1)
            memory_pad = None
        if extra_memory is not None:
            if (extra_memory.ndim != 3 or extra_memory.shape[0] != B
                    or extra_memory.shape[2] != self.config['width']
                    or extra_memory_known is None
                    or extra_memory_known.shape != extra_memory.shape[:2]
                    or extra_memory_known.dtype != torch.bool):
                raise ValueError('extra memory and known mask mismatch')
            if memory_pad is None:
                memory_pad = torch.zeros(memory.shape[:2], dtype=torch.bool,
                                         device=memory.device)
            memory = torch.cat((memory, extra_memory.masked_fill(
                ~extra_memory_known[..., None], 0)), dim=1)
            memory_pad = torch.cat((memory_pad, ~extra_memory_known), dim=1)

        tok_pos = torch.arange(L, device=history.device)
        target_x = self.token(decoder_input) + self.token_position(tok_pos)[None]
        if token_additions is not None:
            if token_additions.shape != target_x.shape:
                raise ValueError('causal token additions must be [batch,tokens,width]')
            target_x = target_x + token_additions
        causal_tokens = torch.triu(torch.ones(L, L, device=history.device, dtype=torch.bool), diagonal=1)
        decoded = self.decoder(target_x, memory, tgt_mask=causal_tokens,
                               memory_key_padding_mask=memory_pad)
        token_logits = self.logits(decoded)
        if allowed_groups is not None:
            if allowed_groups.shape != (B, len(GROUPS)) or allowed_groups.dtype != torch.bool:
                raise ValueError('allowed_groups must be boolean [batch,six]')
            for group_id in range(len(GROUPS)):
                token_logits[:, :, GROUP_BASE + group_id] = token_logits[:, :, GROUP_BASE + group_id].masked_fill(
                    ~allowed_groups[:, group_id, None], torch.finfo(token_logits.dtype).min)
        if allowed_roles is not None:
            if allowed_roles.shape != (B, len(ROLES)) or allowed_roles.dtype != torch.bool:
                raise ValueError('allowed_roles must be boolean [batch,roles]')
            token_logits[..., ROLE_BASE:ROLE_BASE + len(ROLES)] = token_logits[
                ..., ROLE_BASE:ROLE_BASE + len(ROLES)].masked_fill(
                    ~allowed_roles[:, None], torch.finfo(token_logits.dtype).min)
        if allowed_pitches is not None:
            if (allowed_pitches.shape not in ((B, 128), (B, L, 128))
                    or allowed_pitches.dtype != torch.bool):
                raise ValueError('allowed_pitches must be boolean [batch,128] or [batch,tokens,128]')
            pitch_mask = allowed_pitches[:, None] if allowed_pitches.ndim == 2 else allowed_pitches
            token_logits[..., PITCH_BASE:PITCH_BASE + 128] = token_logits[
                ..., PITCH_BASE:PITCH_BASE + 128].masked_fill(
                    ~pitch_mask, torch.finfo(token_logits.dtype).min)
        if locked_mask is not None or locked_tokens is not None:
            if (locked_mask is None or locked_tokens is None
                    or locked_mask.shape != (B, L) or locked_tokens.shape != (B, L)
                    or locked_mask.dtype != torch.bool or locked_tokens.dtype != torch.long):
                raise ValueError('hard-locked event tokens require matching mask and IDs')
            chosen = locked_tokens[locked_mask]
            if chosen.numel() and ((chosen < 0).any() or (chosen >= self.config['vocab_size']).any()):
                raise ValueError('hard-locked event token outside vocabulary')
            if chosen.numel() and (token_logits[locked_mask].gather(1, chosen[:, None])
                                   <= torch.finfo(token_logits.dtype).min).any():
                raise ValueError('hard-locked event conflicts with a hard mask')
            locked_logits = torch.full_like(token_logits, torch.finfo(token_logits.dtype).min)
            locked_logits.scatter_(2, locked_tokens.clamp(0, self.config['vocab_size'] - 1)[..., None], 0)
            token_logits = torch.where(locked_mask[..., None], locked_logits, token_logits)
        return {'tokens': token_logits, 'plan': plan, 'summaries': predicted_summary,
                'motif': motif_logits, 'event_hidden': decoded}
