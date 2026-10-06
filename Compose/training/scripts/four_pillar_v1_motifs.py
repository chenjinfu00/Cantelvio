"""Online motif memory from completed bars only; no target/future score access."""
from __future__ import annotations

from dataclasses import dataclass

import torch

from four_pillar_codec import BAR, END_BAR, END_ONSET, ONSET, PITCH_BASE


@dataclass(frozen=True)
class MotifEntry:
    tokens: tuple[int, ...]
    signature: tuple[int, ...]
    repeats: int
    last_bar: int


class PastMotifBank:
    def __init__(self, *, capacity: int = 8, max_tokens: int = 192):
        if not 1 <= capacity <= 8 or max_tokens < 16:
            raise ValueError('motif bank supports one to eight complete fragments')
        self.capacity = capacity
        self.max_tokens = max_tokens
        self.entries: list[MotifEntry] = []
        self.next_bar = 0

    def add_committed_bar(self, bar_index: int, tokens: tuple[int, ...]):
        if bar_index != self.next_bar or not tokens or tokens[0] != BAR or tokens[-1] != END_BAR:
            raise ValueError('motif memory accepts only the next completed bar')
        self.next_bar += 1
        pitches = [token - PITCH_BASE for token in tokens
                   if PITCH_BASE <= token < PITCH_BASE + 128]
        if not pitches:
            return
        first = pitches[0]
        intervals = tuple((pitch - first) % 12 for pitch in pitches[:8])
        signature = (tokens.count(ONSET),) + intervals
        stop = max((i + 1 for i, token in enumerate(tokens[:self.max_tokens])
                    if token in (END_ONSET, END_BAR)), default=0)
        if not stop:
            raise ValueError('motif context would cut a simultaneous onset')
        fragment = tokens[:stop]
        for index, entry in enumerate(self.entries):
            if entry.signature == signature:
                self.entries[index] = MotifEntry(fragment, signature,
                                                 entry.repeats + 1, bar_index)
                return
        self.entries.append(MotifEntry(fragment, signature, 1, bar_index))
        if len(self.entries) > self.capacity:
            victim = min(range(len(self.entries)),
                         key=lambda i: (self.entries[i].repeats, self.entries[i].last_bar))
            self.entries.pop(victim)

    def tensors(self, *, device: torch.device | None = None) -> tuple[torch.Tensor, torch.Tensor]:
        length = max((len(entry.tokens) for entry in self.entries), default=0)
        tokens = torch.zeros(1, len(self.entries), length, dtype=torch.long, device=device)
        known = torch.zeros_like(tokens, dtype=torch.bool)
        for i, entry in enumerate(self.entries):
            n = len(entry.tokens)
            tokens[0, i, :n] = torch.tensor(entry.tokens, dtype=torch.long, device=device)
            known[0, i, :n] = True
        return tokens, known
