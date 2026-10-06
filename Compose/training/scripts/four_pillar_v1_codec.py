"""Dynamic-voice wire view over the verified exact-time event codec.

At each NOTE, VOICE_CHOICE is followed by a separate pointer target over the
registry *so far* plus NEW_VOICE. A score-local definition sidecar preserves
source part/staff/voice names for round-trip audit; it is never a model input.
The timing, group-before-pitch and expression bytes remain identical to the
lossless v1 event representation. No fixed 32/64-voice vocabulary is created.
"""
from __future__ import annotations

from dataclasses import dataclass

import torch

from four_pillar_codec import (EncodedScore, GROUP_BASE, GROUPS, NOTE, ROLE_BASE,
                               ROLES, VOCAB_SIZE, _Reader, _uint, decode_score,
                               encode_score)
from score_events_v2 import ScoreEvents

VOICE_CHOICE = VOCAB_SIZE
V1_VOCAB_SIZE = VOCAB_SIZE + 1


@dataclass(frozen=True)
class DynamicEncodedScore:
    tokens: tuple[int, ...]
    # -1 except at VOICE_CHOICE, where the current registry size means NEW_VOICE.
    voice_pointer_targets: tuple[int, ...]
    voice_definitions: tuple[tuple[str, str, str], ...]
    source_indices: tuple[int, ...]
    note_spans: tuple[tuple[int, int], ...]
    bar_spans: tuple[tuple[int, int], ...]
    loss_mask: tuple[bool, ...]


def encode_dynamic_score(score: ScoreEvents) -> DynamicEncodedScore:
    old = encode_score(score)
    by_source = {note.source_index: note for note in score.events}
    tokens, pointer_targets, loss_mask = [], [], []
    new_spans = []
    boundaries = {index for pair in old.bar_spans for index in pair}
    mapped_boundaries = {}
    registry: dict[tuple[str, str, str], int] = {}
    definitions = []
    cursor = 0
    for note_index, (start, end) in enumerate(old.note_spans):
        while cursor < start:
            if cursor in boundaries:
                mapped_boundaries[cursor] = len(tokens)
            tokens.append(old.tokens[cursor])
            pointer_targets.append(-1)
            loss_mask.append(old.loss_mask[cursor])
            cursor += 1
        new_start = len(tokens)
        source = by_source[old.source_indices[note_index]]
        identity = source.voice_id
        pointer = registry.get(identity)
        if pointer is None:
            pointer = len(registry)
            registry[identity] = pointer
            definitions.append(identity)
        tokens.extend((NOTE, VOICE_CHOICE))
        pointer_targets.extend((-1, pointer))
        loss_mask.extend((True, True))
        reader = _Reader(old.tokens)
        reader.i = start + 1
        previous_pointer = reader.uint()
        if old.voice_ids[previous_pointer] != identity:
            raise AssertionError('static and dynamic voice identities differ')
        for cursor in range(reader.i, end):
            tokens.append(old.tokens[cursor])
            pointer_targets.append(-1)
            loss_mask.append(old.loss_mask[cursor])
        new_spans.append((new_start, len(tokens)))
        cursor = end
    while cursor < len(old.tokens):
        if cursor in boundaries:
            mapped_boundaries[cursor] = len(tokens)
        tokens.append(old.tokens[cursor])
        pointer_targets.append(-1)
        loss_mask.append(old.loss_mask[cursor])
        cursor += 1
    mapped_boundaries[len(old.tokens)] = len(tokens)
    bars = tuple((mapped_boundaries[start], mapped_boundaries[end]) for start, end in old.bar_spans)
    return DynamicEncodedScore(tuple(tokens), tuple(pointer_targets),
                               tuple(definitions), old.source_indices, tuple(new_spans),
                               bars, tuple(loss_mask))


def decode_dynamic_score(encoded: DynamicEncodedScore, template: ScoreEvents) -> ScoreEvents:
    if (len(encoded.tokens) != len(encoded.voice_pointer_targets)
            or len(encoded.tokens) != len(encoded.loss_mask)):
        raise ValueError('dynamic score masks and pointers must match tokens')
    tokens = []
    defined = 0
    for index, (token, pointer) in enumerate(zip(encoded.tokens, encoded.voice_pointer_targets)):
        if token == VOICE_CHOICE:
            if index == 0 or encoded.tokens[index - 1] != NOTE:
                raise ValueError('voice choice must follow NOTE')
            if pointer < 0 or pointer > defined:
                raise ValueError('pointer refers to a future voice')
            if pointer == defined:
                if defined >= len(encoded.voice_definitions):
                    raise ValueError('NEW_VOICE has no source definition')
                defined += 1
            tokens.extend(_uint(pointer))
        else:
            if pointer != -1 or token < 0 or token >= VOCAB_SIZE:
                raise ValueError('invalid pointer position or event token')
            tokens.append(token)
    if defined != len(encoded.voice_definitions):
        raise ValueError('unused future voice definition')
    old = EncodedScore(tuple(tokens), encoded.voice_definitions,
                       encoded.source_indices, (), ())
    return decode_score(old, template)


def causal_teacher_forcing_inputs(encoded: DynamicEncodedScore, *, start: int = 0,
                                  stop: int | None = None) -> dict[str, torch.Tensor]:
    """Build one score's shifted targets and causal, growing voice registry.

    Only already emitted group/role tokens update voice metadata. The source
    `voice_definitions` sidecar is deliberately ignored: it can contain future
    identities, so feeding it to the network would leak the target score.
    The returned tensors include a batch dimension; callers may pad multiple
    scores, but must preserve each score's own causal snapshots and masks.
    """
    if (len(encoded.tokens) < 2 or len(encoded.tokens) != len(encoded.voice_pointer_targets)
            or len(encoded.tokens) != len(encoded.loss_mask)):
        raise ValueError('incomplete dynamic score stream')
    stop = len(encoded.tokens) - 1 if stop is None else stop
    if not 0 <= start < stop <= len(encoded.tokens) - 1:
        raise ValueError('teacher-forcing window is outside the score stream')
    # Field-end positions can be located by reading the complete wire, but
    # their *values* become visible only after their final byte is emitted.
    updates: dict[int, tuple[int, int, int]] = {}
    for note_start, note_end in encoded.note_spans:
        if note_start >= stop:
            break
        if (not 0 <= note_start + 2 <= note_end <= len(encoded.tokens)
                or encoded.tokens[note_start:note_start + 2] != (NOTE, VOICE_CHOICE)):
            raise ValueError('invalid dynamic note span')
        pointer = encoded.voice_pointer_targets[note_start + 1]
        if pointer < 0:
            raise ValueError('missing voice pointer in note span')
        reader = _Reader(encoded.tokens)
        reader.i = note_start + 2
        group = reader.label(GROUPS, GROUP_BASE)
        if group in GROUPS:
            updates[reader.i - 1] = (pointer, 0, GROUPS.index(group))
        role = reader.label(ROLES, ROLE_BASE)
        if role in ROLES:
            updates[reader.i - 1] = (pointer, 1, ROLES.index(role))
        if reader.i >= note_end:
            raise ValueError('note span lacks pitch and duration')

    # The registry contains metadata learned from emitted tokens only. Range
    # defaults to the explicit unrestricted sounding MIDI range [0,127].
    registry: list[list[float]] = []
    snapshots: list[list[list[float]]] = []
    feedback: list[int] = []
    for index, token in enumerate(encoded.tokens[:stop]):
        if index >= start:
            snapshots.append([row.copy() for row in registry])
        pointer = encoded.voice_pointer_targets[index]
        if token == VOICE_CHOICE:
            if not 0 <= pointer <= len(registry):
                raise ValueError('voice choice refers to an unregistered future voice')
            if index >= start:
                feedback.append(pointer)
            if pointer == len(registry):
                row = [0.0] * (len(GROUPS) + len(ROLES) + 2)
                row[-1] = 1.0
                registry.append(row)
        else:
            if pointer != -1:
                raise ValueError('voice pointer outside VOICE_CHOICE')
            if index >= start:
                feedback.append(-1)
        if index in updates:
            voice, kind, value = updates[index]
            if voice >= len(registry):
                raise ValueError('metadata precedes voice registration')
            offset = 0 if kind == 0 else len(GROUPS)
            width = len(GROUPS) if kind == 0 else len(ROLES)
            old = registry[voice][offset:offset + width]
            if any(old) and old[value] != 1.0:
                raise ValueError('voice group or role changes within a score')
            registry[voice][offset:offset + width] = [float(slot == value) for slot in range(width)]

    length = len(snapshots)
    maximum = max(map(len, snapshots), default=0)
    features = torch.zeros(1, length, maximum, len(GROUPS) + len(ROLES) + 2)
    known = torch.zeros(1, length, maximum, dtype=torch.bool)
    for index, rows in enumerate(snapshots):
        if rows:
            features[0, index, :len(rows)] = torch.tensor(rows)
            known[0, index, :len(rows)] = True
    pointer_targets = torch.tensor(encoded.voice_pointer_targets[start + 1:stop + 1],
                                   dtype=torch.long)[None]
    return {
        'decoder_input': torch.tensor(encoded.tokens[start:stop], dtype=torch.long)[None],
        'event_target': torch.tensor(encoded.tokens[start + 1:stop + 1], dtype=torch.long)[None],
        'event_known': torch.tensor(encoded.loss_mask[start + 1:stop + 1], dtype=torch.bool)[None],
        'voice_features': features,
        'voice_known': known,
        'voice_pointer_input': torch.tensor(feedback, dtype=torch.long)[None],
        'voice_pointer_target': pointer_targets,
        'voice_pointer_target_known': pointer_targets >= 0,
    }
