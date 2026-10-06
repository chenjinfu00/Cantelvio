#!/usr/bin/env python3
"""Train and export the tiny causal harmony Transformer used by the deck.

The corpus below is an original, synthetic teaching corpus.  It encodes short
tonal phrase grammars rather than transcriptions or data from recordings.

Requires Python 3.11+ and PyTorch.  Example:
  python scripts/train-harmony-transformer.py \
    --output public/karaoke/tiny-transformer.js
"""

from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F


VOCAB = [
    "C", "F", "G", "Am", "Dm", "Dm7", "G7", "Cmaj7", "Cmaj9", "C7",
    "Cm", "Cm7", "Cm9", "Cdim7", "A♭", "Em", "B♭", "Fmaj7", "Fm",
    "Fm7", "G9", "Am7", "Em7", "B♭7", "E♭", "D♭/F", "Bø7", "Bdim7",
    "C♯dim7", "F♯dim7", "A7", "D7", "E7",
]
TOKEN_TO_ID = {token: index for index, token in enumerate(VOCAB)}
CONTEXT = 8
D_MODEL = 24
HEADS = 2
D_FF = 48
SEED = 73421


# Each phrase was authored for this demo.  Families cover diatonic motion,
# applied dominants, modal mixture, minor, jazz extensions, diminished passing
# chords and Neapolitan predominant motion.
PHRASE_FAMILIES = [
    [["C", "F", "G", "C"], ["C", "Am", "F", "G", "C"], ["C", "Em", "F", "G", "C"]],
    [["C", "Am", "Dm", "G", "C"], ["C", "Em", "Am", "Dm", "G7", "C"], ["F", "G", "Em", "Am", "Dm", "G", "C"]],
    [["F", "G", "A♭", "B♭", "C"], ["C", "A♭", "B♭", "C"], ["Cm", "A♭", "B♭", "Cm"]],
    [["C", "C7", "F", "Fm", "C"], ["C", "F", "Fm", "C"], ["Cmaj7", "C7", "Fmaj7", "Fm7", "C"]],
    [["C", "E7", "Am", "Dm", "G7", "C"], ["Am", "E7", "Am", "A7", "Dm", "G", "C"], ["C", "A7", "Dm", "D7", "G", "C"]],
    [["C", "D7", "G", "G7", "C"], ["G", "D7", "G", "C", "D7", "G"], ["Dm", "D7", "G", "G7", "C"]],
    [["C", "D♭/F", "G7", "C"], ["Cm", "D♭/F", "G", "Cm"], ["Fm", "D♭/F", "G7", "Cm"]],
    [["C", "Bdim7", "C"], ["Cm", "Bø7", "Cm"], ["Dm", "Bø7", "C"], ["G", "Bdim7", "C"]],
    [["C", "C♯dim7", "Dm", "G7", "C"], ["G", "F♯dim7", "G", "C"], ["C", "Cdim7", "C"], ["C", "Cdim7", "Am", "F", "G", "C"]],
    [["Cmaj7", "Am7", "Dm7", "G7", "Cmaj7"], ["Cmaj9", "Am7", "Dm7", "G9", "Cmaj9"], ["Em7", "A7", "Dm7", "G9", "Cmaj7"]],
    [["Cmaj7", "Em7", "Am7", "Dm7", "G7", "Cmaj7"], ["Fmaj7", "Em7", "Am7", "Dm7", "G9", "Cmaj9"]],
    [["Cm", "Fm", "G7", "Cm"], ["Cm7", "Fm7", "B♭7", "E♭", "G7", "Cm"], ["Cm9", "Fm7", "B♭7", "E♭", "D♭/F", "G7", "Cm9"]],
]


def build_corpus() -> list[list[str]]:
    """Build the authored phrases and a few longer cadential joins.

    Cadential arrivals are not duplicated as padding: doing that would turn
    phrase boundaries into artificial tonic self-transitions.
    """
    phrases: list[list[str]] = []
    continuations = {
        "C": (["F", "G", "C"], ["Am", "Dm", "G7", "C"]),
        "Cm": (["Fm", "G7", "Cm"], ["A♭", "D♭/F", "G7", "Cm"]),
        "Cm9": (["Fm7", "B♭7", "E♭", "G7", "Cm9"], ["D♭/F", "G7", "Cm9"]),
        "Cmaj7": (["Am7", "Dm7", "G9", "Cmaj7"], ["Em7", "A7", "Dm7", "G7", "Cmaj7"]),
        "Cmaj9": (["Am7", "Dm7", "G9", "Cmaj9"], ["Em7", "A7", "Dm7", "G9", "Cmaj9"]),
        "G": (["C", "F", "G"], ["Em", "Am", "D7", "G"]),
    }
    for family in PHRASE_FAMILIES:
        for phrase in family:
            phrases.append(phrase)
            first, second = continuations[phrase[-1]]
            phrases.append([*phrase, *first])
            phrases.append([*phrase, *second])
    # Cadential joins let the model encounter longer context without copying any
    # external composition.
    for left, right in zip(PHRASE_FAMILIES[::2], PHRASE_FAMILIES[1::2]):
        a, b = left[0], right[0]
        phrases.append([*a[:-1], *b[: min(5, len(b))]])
    return phrases


def examples(phrases: list[list[str]]) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    rows: list[list[int]] = []
    lengths: list[int] = []
    targets: list[int] = []
    for phrase in phrases:
        ids = [TOKEN_TO_ID[token] for token in phrase]
        for end in range(1, len(ids)):
            prefix = ids[max(0, end - CONTEXT):end]
            rows.append(prefix + [0] * (CONTEXT - len(prefix)))
            lengths.append(len(prefix))
            targets.append(ids[end])
    return (
        torch.tensor(rows, dtype=torch.long),
        torch.tensor(lengths, dtype=torch.long),
        torch.tensor(targets, dtype=torch.long),
    )


class TinyHarmonyTransformer(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.token_embedding = nn.Embedding(len(VOCAB), D_MODEL)
        self.position_embedding = nn.Parameter(torch.empty(CONTEXT, D_MODEL))
        self.ln1 = nn.LayerNorm(D_MODEL)
        self.q = nn.Linear(D_MODEL, D_MODEL)
        self.k = nn.Linear(D_MODEL, D_MODEL)
        self.v = nn.Linear(D_MODEL, D_MODEL)
        self.o = nn.Linear(D_MODEL, D_MODEL)
        self.ln2 = nn.LayerNorm(D_MODEL)
        self.ff1 = nn.Linear(D_MODEL, D_FF)
        self.ff2 = nn.Linear(D_FF, D_MODEL)
        self.ln_final = nn.LayerNorm(D_MODEL)
        self.output = nn.Linear(D_MODEL, len(VOCAB))
        nn.init.normal_(self.position_embedding, std=0.02)

    def forward(self, tokens: torch.Tensor, lengths: torch.Tensor, return_attention: bool = False):
        batch, time = tokens.shape
        x = self.token_embedding(tokens) + self.position_embedding[:time]
        z = self.ln1(x)
        head_dim = D_MODEL // HEADS
        q = self.q(z).view(batch, time, HEADS, head_dim).transpose(1, 2)
        k = self.k(z).view(batch, time, HEADS, head_dim).transpose(1, 2)
        v = self.v(z).view(batch, time, HEADS, head_dim).transpose(1, 2)
        scores = q @ k.transpose(-2, -1) / math.sqrt(head_dim)
        causal = torch.triu(torch.ones(time, time, dtype=torch.bool, device=tokens.device), diagonal=1)
        valid_keys = torch.arange(time, device=tokens.device)[None, :] < lengths[:, None]
        scores = scores.masked_fill(causal[None, None], float("-inf"))
        scores = scores.masked_fill(~valid_keys[:, None, None, :], float("-inf"))
        attention = torch.softmax(scores, dim=-1)
        attended = attention @ v
        attended = attended.transpose(1, 2).contiguous().view(batch, time, D_MODEL)
        x = x + self.o(attended)
        x = x + self.ff2(F.gelu(self.ff1(self.ln2(x)), approximate="tanh"))
        x = self.ln_final(x)
        last = x[torch.arange(batch), lengths - 1]
        logits = self.output(last)
        return (logits, attention) if return_attention else logits


def split_corpus(phrases: list[list[str]]) -> tuple[list[list[str]], list[list[str]]]:
    # Every ninth deterministic variation is held out; related grammar remains
    # in training, while exact sequences do not.
    validation = [phrase for i, phrase in enumerate(phrases) if i % 9 == 8]
    training = [phrase for i, phrase in enumerate(phrases) if i % 9 != 8]
    return training, validation


def perplexity(model: nn.Module, phrases: list[list[str]]) -> float:
    x, lengths, y = examples(phrases)
    with torch.no_grad():
        loss = F.cross_entropy(model(x, lengths), y)
    return float(torch.exp(loss))


def serial(tensor: torch.Tensor, digits: int = 9):
    array = tensor.detach().cpu().numpy()
    if array.ndim == 0:
        return round(float(array), digits)
    return [serial(torch.as_tensor(item), digits) for item in array]


def export_weights(model: TinyHarmonyTransformer, metadata: dict, output: Path) -> None:
    probe_tokens = ["F", "G", "Em", "Am", "Dm", "G"]
    probe = torch.tensor([[TOKEN_TO_ID[token] for token in probe_tokens]], dtype=torch.long)
    lengths = torch.tensor([len(probe_tokens)])
    with torch.no_grad():
        logits, attention = model(probe, lengths, return_attention=True)

    weights = {
        "format": 1,
        "architecture": {"contextLength": CONTEXT, "dModel": D_MODEL, "heads": HEADS, "dHead": D_MODEL // HEADS, "dFF": D_FF, "activation": "gelu-tanh", "layerNormEpsilon": 1e-5},
        "training": metadata,
        "tokenEmbedding": serial(model.token_embedding.weight),
        "positionEmbedding": serial(model.position_embedding),
        "ln1": {"weight": serial(model.ln1.weight), "bias": serial(model.ln1.bias)},
        "q": {"weight": serial(model.q.weight), "bias": serial(model.q.bias)},
        "k": {"weight": serial(model.k.weight), "bias": serial(model.k.bias)},
        "v": {"weight": serial(model.v.weight), "bias": serial(model.v.bias)},
        "o": {"weight": serial(model.o.weight), "bias": serial(model.o.bias)},
        "ln2": {"weight": serial(model.ln2.weight), "bias": serial(model.ln2.bias)},
        "ff1": {"weight": serial(model.ff1.weight), "bias": serial(model.ff1.bias)},
        "ff2": {"weight": serial(model.ff2.weight), "bias": serial(model.ff2.bias)},
        "lnFinal": {"weight": serial(model.ln_final.weight), "bias": serial(model.ln_final.bias)},
        "output": {"weight": serial(model.output.weight), "bias": serial(model.output.bias)},
        "parityProbe": {"tokens": probe_tokens, "logits": serial(logits[0]), "attention": serial(attention[0])},
    }
    payload = json.dumps(weights, ensure_ascii=False, separators=(",", ":"))
    source = (
        "// Generated by scripts/train-harmony-transformer.py. Do not hand-edit.\n"
        "// Original synthetic teaching corpus; no recording or copyrighted dataset was used.\n"
        f"export const TINY_TRANSFORMER_WEIGHTS = Object.freeze({payload});\n"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(source, encoding="utf-8")


def train(epochs: int, learning_rate: float) -> tuple[TinyHarmonyTransformer, dict]:
    random.seed(SEED)
    torch.manual_seed(SEED)
    torch.set_num_threads(1)
    phrases = build_corpus()
    training, validation = split_corpus(phrases)
    x, lengths, y = examples(training)
    model = TinyHarmonyTransformer()
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=0.01)
    start_loss = float(F.cross_entropy(model(x, lengths), y).detach())
    for _ in range(epochs):
        optimizer.zero_grad(set_to_none=True)
        loss = F.cross_entropy(model(x, lengths), y)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
    model.eval()
    train_ppl = perplexity(model, training)
    validation_ppl = perplexity(model, validation)
    metadata = {
        "trained": True,
        "seed": SEED,
        "epochs": epochs,
        "optimizer": "AdamW",
        "learningRate": learning_rate,
        "phraseCount": len(phrases),
        "trainingPhraseCount": len(training),
        "validationPhraseCount": len(validation),
        "trainingExampleCount": len(y),
        "parameterCount": sum(parameter.numel() for parameter in model.parameters()),
        "initialCrossEntropy": round(start_loss, 6),
        "trainingPerplexity": round(train_ppl, 6),
        "validationPerplexity": round(validation_ppl, 6),
        "corpus": "original synthetic tonal teaching phrases (no recordings or external compositions)",
    }
    return model, metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("public/karaoke/tiny-transformer.js"))
    parser.add_argument("--epochs", type=int, default=350)
    parser.add_argument("--learning-rate", type=float, default=0.006)
    args = parser.parse_args()
    model, metadata = train(args.epochs, args.learning_rate)
    export_weights(model, metadata, args.output)
    print(json.dumps(metadata, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
