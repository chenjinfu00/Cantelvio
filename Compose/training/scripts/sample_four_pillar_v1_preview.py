#!/usr/bin/env python3
"""Private, score-scaffolded listening preview of the four-pillar v1 pilot.

Only completed validation-score bars are read as a prompt. The next two bars
reuse that *past* bar's onset/duration scaffold; pitch and voice pointers come
from the pilot checkpoint. This is deliberately not unconstrained generation.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from fractions import Fraction
from pathlib import Path

import numpy as np
import torch

from four_pillar_codec import (ACCENT_BASE, BAR, BYTE_BASE, DYNAMIC_BASE,
                               DYNAMICS, END_BAR, END_ONSET, GRACE_NO,
                               GROUP_BASE, GROUPS, NONE, NOTE, ONSET, PITCH_BASE,
                               ROLE_BASE, ROLES, WEDGE_BASE, _fraction, _uint)
from four_pillar_trial_model import SUMMARY_DIM
from four_pillar_v1_alignment import past_window_before_bar
from four_pillar_v1_codec import VOICE_CHOICE, causal_teacher_forcing_inputs
from four_pillar_v1_model import FourPillarComposerV1
from four_pillar_v1_pilot_data import load_mixed_pilot

ROOT = Path(__file__).resolve().parents[1]
CHECKPOINT = ROOT / 'runs/four-pillar-v1-pilot-20260929/best.pt'
REGISTERS = {'woodwinds': (48, 91), 'brass': (40, 83), 'percussion': (35, 82),
             'keys': (36, 97), 'high_strings': (54, 97), 'low_strings': (34, 81)}


def _pick(logits: torch.Tensor, choices: list[int], generator: torch.Generator,
          temperature: float) -> int:
    if not choices:
        raise ValueError('no allowed choices')
    values = logits[choices].float() / temperature
    if not torch.isfinite(values).any():
        raise ValueError('model has no finite allowed prediction')
    probabilities = torch.softmax(values, dim=0)
    return choices[int(torch.multinomial(probabilities, 1, generator=generator))]


def _summary(notes: list[dict]) -> np.ndarray:
    result = np.zeros(SUMMARY_DIM, dtype=np.float32)
    pitched = [note for note in notes if note['pitch'] is not None]
    for note in pitched:
        result[note['pitch'] % 12] += 1
        result[19] += note['pitch'] / 127
    if pitched:
        result[:12] /= len(pitched)
        result[19] /= len(pitched)
    for note in notes:
        if note['group'] in GROUPS:
            result[12 + GROUPS.index(note['group'])] += 1
    if result[12:18].sum():
        result[12:18] /= result[12:18].sum()
    result[18] = math.log1p(len(notes)) / math.log(129)
    return result


def _scaffold(previous: list, measure, known_voices: set, allowed: set) -> list:
    """Pick at most 12 notes from a *past* measure, preserving exact times."""
    by_onset = defaultdict(list)
    for note in previous:
        if (note.voice_id in known_voices and note.group in allowed
                and note.pitch is not None and not note.grace):
            offset = note.onset - measure.onset
            if 0 <= offset < measure.duration:
                by_onset[offset].append(note)
    offsets = sorted(by_onset)
    if len(offsets) > 6:
        offsets = [offsets[round(i * (len(offsets) - 1) / 5)] for i in range(6)]
    chosen = []
    for offset in offsets:
        seen = set()
        for note in by_onset[offset]:
            if note.voice_id not in seen:
                chosen.append((offset, note))
                seen.add(note.voice_id)
            if len(chosen) >= 12:
                return chosen
    return chosen


class BarDecoder:
    def __init__(self, model, histories: list[np.ndarray], registry: torch.Tensor,
                 previous_token: int, prior: dict, allowed: set):
        self.model = model
        self.registry = registry.clone().float()
        self.allowed = allowed
        self.inputs = []
        self.snapshots = []
        self.feedback = []
        self.history = torch.zeros(1, 32, SUMMARY_DIM)
        count = min(32, len(histories))
        self.history[0, :count] = torch.from_numpy(np.stack(histories[-count:]))
        self.history_known = torch.zeros(1, 32, dtype=torch.bool)
        self.history_known[0, :count] = True
        self.prior = prior
        self.feed(previous_token)

    def feed(self, token: int, pointer: int = -1):
        if len(self.inputs) >= 256:
            raise ValueError('preview bar exceeds the trained 256-token context')
        self.snapshots.append(self.registry.clone())
        self.inputs.append(token)
        self.feedback.append(pointer)

    def predict(self) -> dict:
        length = len(self.inputs)
        features = torch.stack(self.snapshots)[None]
        return self.model(
            history=self.history, history_known=self.history_known,
            decoder_input=torch.tensor([self.inputs]),
            material=torch.empty(1, 0, dtype=torch.long),
            material_known=torch.empty(1, 0, dtype=torch.bool),
            task_id=torch.zeros(1, dtype=torch.long),
            intent_id=torch.zeros(1, dtype=torch.long),
            voice_features=features,
            voice_known=torch.ones(1, length, self.registry.shape[0], dtype=torch.bool),
            voice_pointer_input=torch.tensor([self.feedback]),
            allowed_groups=torch.tensor([[name in self.allowed for name in GROUPS]], dtype=torch.bool),
            allow_new_voice=torch.zeros(1, length, dtype=torch.bool), **self.prior)

    def group_for(self, pointer: int) -> str:
        row = self.registry[pointer, :len(GROUPS)]
        return GROUPS[int(row.argmax())] if row.sum() > 0 else 'keys'

    def role_for(self, pointer: int) -> str | None:
        row = self.registry[pointer, len(GROUPS):len(GROUPS) + len(ROLES)]
        return ROLES[int(row.argmax())] if row.sum() > 0 else None


def _choose_start(item) -> int:
    for bar in sorted(range(3, min(len(item.score.measures), 24)), key=lambda x: (abs(x - 8), x)):
        if item.piece is not None and past_window_before_bar(item.score, item.piece, bar) is None:
            continue
        previous = [n for n in item.score.events if n.bar == bar - 1]
        if any(n.pitch is not None and n.group in GROUPS for n in previous):
            return bar
    raise ValueError('validation prompt has no usable completed source bar')


def generate(score_id: str, seed: int, temperature: float, allowed: set,
             use_legacy: bool = True) -> dict:
    torch.set_num_threads(4)
    torch.manual_seed(1)
    data, _, _ = load_mixed_pilot()
    item = next((row for row in data['validation'] if row.score.score_id == score_id), None)
    if item is None:
        raise ValueError('unknown validation prompt')
    bar = _choose_start(item)
    first = bar - 2
    measure = item.score.measures[bar - 1]
    identity_to_pointer = {voice: index for index, voice in enumerate(item.encoded.voice_definitions)}
    start = item.encoded.bar_spans[bar][0]
    teacher = causal_teacher_forcing_inputs(item.encoded, start=start - 1, stop=start)
    initial_registry = teacher['voice_features'][0, 0]
    known_voices = {identity for identity, pointer in identity_to_pointer.items()
                    if pointer < initial_registry.shape[0]}
    scaffold = _scaffold([n for n in item.score.events if n.bar == bar - 1], measure,
                         known_voices, allowed)
    if not scaffold:
        raise ValueError('selected groups have no known voice in the prompt bar')

    checkpoint = torch.load(CHECKPOINT, map_location='cpu', weights_only=True)
    model = FourPillarComposerV1(**checkpoint['config'])
    model.load_state_dict(checkpoint['model'], strict=True)
    model.eval()
    generator = torch.Generator().manual_seed(seed)
    base = item.score.measures[first].onset
    prompt_end = measure.onset + measure.duration
    current_onset = prompt_end
    output = []
    for note in item.score.events:
        if first <= note.bar < bar and note.pitch is not None and note.group in allowed:
            output.append({'quarter': float(note.onset - base), 'duration': float(note.duration),
                           'pitch': note.pitch, 'group': note.group,
                           'velocity': 72, 'drum': False, 'generated': False})
    histories = list(item.summaries[:bar])
    prior = (past_window_before_bar(item.score, item.piece, bar)
             if item.piece is not None and use_legacy else {})
    if prior:
        prior.pop('source', None)
    generated_bars = []
    with torch.inference_mode():
        for generation_bar in range(2):
            decoder = BarDecoder(model, histories, initial_registry, END_BAR, prior if generation_bar == 0 else {}, allowed)
            prior = {}
            # The measure itself and its exact-time metadata are fixed from the
            # *preceding* bar. No held-out target bar is inspected here.
            for token in [BAR, *_fraction(current_onset), *_fraction(measure.duration),
                          *_uint(measure.meter[0]), *_uint(measure.meter[1])]:
                decoder.feed(token)
            prior_offset = Fraction(0)
            bar_notes = []
            for offset in sorted(set(on for on, _ in scaffold)):
                at = [(on, note) for on, note in scaffold if on == offset]
                for token in [ONSET, *_fraction(offset - prior_offset)]:
                    decoder.feed(token)
                prior_offset = offset
                used = set()
                for _, reference in at:
                    decoder.feed(NOTE)
                    result = decoder.predict()
                    possible = [index for index in range(initial_registry.shape[0])
                                if index not in used and decoder.group_for(index) in allowed]
                    if not possible:
                        decoder.inputs.pop(); decoder.snapshots.pop(); decoder.feedback.pop()
                        break
                    pointer = _pick(result['voice_pointer'][0, -1], possible, generator, temperature)
                    used.add(pointer)
                    decoder.feed(VOICE_CHOICE, pointer)
                    group = decoder.group_for(pointer)
                    role = decoder.role_for(pointer)
                    decoder.feed(GROUP_BASE + GROUPS.index(group))
                    decoder.feed(NONE if role is None else ROLE_BASE + ROLES.index(role))
                    pitch_logits = decoder.predict()['tokens'][0, -1]
                    low, high = REGISTERS[group]
                    candidates = list(range(low, high))
                    pitch = _pick(pitch_logits, [PITCH_BASE + p for p in candidates],
                                  generator, temperature) - PITCH_BASE
                    decoder.feed(PITCH_BASE + pitch)
                    duration = min(reference.duration, measure.duration - offset)
                    if duration <= 0:
                        duration = Fraction(1, 4)
                    for token in [*_fraction(duration), NONE, NONE, NONE, NONE,
                                  ACCENT_BASE, GRACE_NO]:
                        decoder.feed(token)
                    event = {'quarter': float(current_onset + offset - base),
                             'duration': float(duration), 'pitch': pitch,
                             'group': group, 'velocity': 76, 'drum': False,
                             'generated': True}
                    bar_notes.append(event)
                    output.append(event)
                decoder.feed(END_ONSET)
            decoder.feed(END_BAR)
            generated_bars.append(bar_notes)
            histories.append(_summary(bar_notes))
            current_onset += measure.duration
            # The same verified *past* rhythm scaffold is reused; no held-out
            # note in either target bar enters the rollout.
    bars = [{'quarter': float(item.score.measures[index].onset - base), 'bpm': 96}
            for index in range(first, bar)]
    bars.extend({'quarter': float(prompt_end - base + i * measure.duration), 'bpm': 96}
                for i in range(len(generated_bars)))
    return {'seed': seed, 'scoreId': score_id, 'source': item.score.source,
            'work': item.score.work or item.score.score_id,
            'oldPriorApplied': bool(item.piece is not None and use_legacy),
            'promptBars': 2, 'generatedBars': len(generated_bars),
            'bars': len(bars), 'totalQuarters': float(current_onset - base),
            'barEvents': bars, 'notes': output,
            'method': 'past-score-rhythm-scaffold; sampled model voice pointers and pitches; no target-bar material'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--score-id', required=True)
    parser.add_argument('--seed', type=int, default=41977)
    parser.add_argument('--temperature', type=float, default=0.95)
    parser.add_argument('--groups', required=True, help='comma-separated six-group names')
    parser.add_argument('--disable-legacy', action='store_true')
    args = parser.parse_args()
    allowed = set(args.groups.split(','))
    if not 0 <= args.seed <= 999999999 or not 0.6 <= args.temperature <= 1.3 or not allowed <= set(GROUPS):
        parser.error('invalid preview options')
    print(json.dumps(generate(args.score_id, args.seed, args.temperature, allowed,
                              use_legacy=not args.disable_legacy),
                     ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
