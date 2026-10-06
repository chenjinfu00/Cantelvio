"""Source-faithful transposition and phrase targets for the next four-pillar run.

Only real source notes are used. Transposition is a whole-excerpt 12-TET shift:
note timing, velocity, tempo, roles and articulation stay paired. Motif recall is
a conservative self-supervised label from *completed past* bars, not an invented
phrase. These operations do not by themselves make network logits equivariant.
"""
from __future__ import annotations

import math
import random
from dataclasses import replace
from fractions import Fraction

import torch

from four_pillar_codec import END_BAR, END_ONSET
from four_pillar_midi_data import MidiItem, _mask_midi_notation
from four_pillar_trial_data import summarize_bars
from four_pillar_trial_model import PLAN_BARS
from four_pillar_v1_codec import encode_dynamic_score
from four_pillar_v1_pilot_data import PairedScore
from score_events_v2 import NoteEvent, ScoreEvents


def _shift_key(key: dict | None, semitones: int) -> dict | None:
    if key is None or key.get('fifths') is None:
        return key
    old = int(key['fifths'])
    target_pc = (7 * old + semitones) % 12
    candidates = [f for f in range(-7, 8) if (7 * f) % 12 == target_pc]
    return {**key, 'fifths': min(candidates, key=lambda f: (abs(f), abs(f - old)))}


def _shift_allowed(score: ScoreEvents, shift: int) -> bool:
    if shift == 0:
        return True
    limits = {'woodwinds': (36, 108), 'brass': (28, 100),
              'keys': (21, 108), 'high_strings': (55, 108),
              'low_strings': (24, 96)}
    for note in score.events:
        if note.unpitched:
            continue
        if any(pitch is not None and not 0 <= pitch + shift <= 127
               for pitch in (note.pitch, note.written_pitch)):
            return False
        if note.pitch is not None and note.group in limits:
            low, high = limits[note.group]
            if not low <= note.pitch + shift <= high:
                return False
    return True


def valid_shifts(score: ScoreEvents, *, maximum: int = 6) -> tuple[int, ...]:
    """Only register-safe semitone shifts, with zero always available."""
    if not 0 <= maximum <= 48:
        raise ValueError('transposition span must be within four octaves')
    possible = []
    for shift in range(-maximum, maximum + 1):
        if _shift_allowed(score, shift):
            possible.append(shift)
    return tuple(possible)


def transpose_score(score: ScoreEvents, semitones: int) -> ScoreEvents:
    if (not isinstance(semitones, int) or abs(semitones) > 48
            or not _shift_allowed(score, semitones)):
        raise ValueError('whole-score shift exceeds supported instrument/MIDI range')
    if semitones == 0:
        return score
    measures = tuple(replace(measure, key=_shift_key(measure.key, semitones))
                     for measure in score.measures)
    events = tuple(replace(note,
                           pitch=None if note.pitch is None else note.pitch + semitones,
                           written_pitch=(None if note.written_pitch is None else
                                          note.written_pitch + semitones))
                   if not note.unpitched else note for note in score.events)
    return replace(score, measures=measures, events=events)


def transpose_item(item: MidiItem | PairedScore, semitones: int):
    score = transpose_score(item.score, semitones)
    if score is item.score:
        return item
    encoded = encode_dynamic_score(score)
    if isinstance(item, MidiItem):
        encoded = _mask_midi_notation(encoded, item.meter_known)
    return replace(item, score=score, encoded=encoded, summaries=summarize_bars(score))


def augment_item(item: MidiItem | PairedScore, rng: random.Random):
    shifts = valid_shifts(item.score)
    return transpose_item(item, rng.choice(shifts))


def _past_anchor(score: ScoreEvents, target_bar: int) -> int | None:
    for bar in range(target_bar - 1, -1, -1):
        previous = [n for n in score.events
                    if n.bar == bar and n.pitch is not None and not n.unpitched]
        if previous:
            earliest = min(n.onset for n in previous)
            return max(n.pitch for n in previous if n.onset == earliest)
    return None


def canonicalize_item(item: MidiItem | PairedScore, target_bar: int,
                      *, reference_pitch: int = 60):
    """Causally normalize a safe excerpt by a note in its completed past.

    For globally transposed versions whose shift stays in range, both normalize
    to identical pitch tokens. If the full register cannot be shifted safely,
    return None so callers can retain the original or use ordinary augmentation.
    """
    if not 0 < target_bar < len(item.score.measures):
        raise ValueError('canonicalization needs a completed past bar')
    anchor = _past_anchor(item.score, target_bar)
    if anchor is None:
        return None
    shift = reference_pitch - anchor
    return (transpose_item(item, shift), shift) if abs(shift) <= 48 and _shift_allowed(
        item.score, shift) else None


def canonicalize_pitch_class_item(item: MidiItem | PairedScore, target_bar: int):
    """Normalize a known past key, or a past-note anchor, without octave jumps.

    This shares pitch-class relationships but is not full transposition
    equivariance: two normalized versions may differ by an octave.
    """
    if not 0 < target_bar < len(item.score.measures):
        raise ValueError('pitch-class canonicalization needs a completed past bar')
    reference_pc = _tonic_pc(item.score.measures[target_bar - 1].key)
    if reference_pc is None:
        anchor = _past_anchor(item.score, target_bar)
        if anchor is None:
            return None
        reference_pc = anchor % 12
    smallest = (-reference_pc) % 12
    if smallest > 6:
        smallest -= 12
    candidates = sorted({smallest, smallest - 12, smallest + 12},
                        key=lambda shift: (abs(shift), shift))
    for shift in candidates:
        if _shift_allowed(item.score, shift):
            return transpose_item(item, shift), shift
    return None


def _melodic_line(score: ScoreEvents, bar: int) -> tuple[NoteEvent, ...]:
    """Highest pitched note per onset is a traceable skyline, not a role claim."""
    by_onset: dict[Fraction, NoteEvent] = {}
    for note in score.events:
        if note.bar == bar and note.pitch is not None and not note.unpitched:
            previous = by_onset.get(note.onset)
            if previous is None or note.pitch > previous.pitch:
                by_onset[note.onset] = note
    return tuple(by_onset[time] for time in sorted(by_onset)[:8])


def _motif_signature(line: tuple[NoteEvent, ...]):
    if len(line) < 4 or line[1].onset <= line[0].onset:
        return None
    line = line[:4]
    unit = line[1].onset - line[0].onset
    if any(note.duration <= 0 for note in line):
        return None
    return (tuple(note.pitch - line[0].pitch for note in line),
            tuple((note.onset - line[0].onset) / unit for note in line),
            tuple(note.duration / unit for note in line))


def _motif_fragment(encoded, bar: int, limit: int = 192) -> tuple[int, ...]:
    start, end = encoded.bar_spans[bar]
    stop = max((index + 1 for index in range(start, min(end, start + limit))
                if encoded.tokens[index] in (END_ONSET, END_BAR)), default=0)
    return tuple(encoded.tokens[start:stop]) if stop else ()


def add_motif_targets(item: MidiItem | PairedScore, inputs: dict, targets: dict,
                      target_bar: int, *, history_bars: int = 32) -> None:
    """Only prior bars enter memory; future bars provide labels, never input."""
    past = []
    for bar in range(target_bar - 1, max(0, target_bar - history_bars) - 1, -1):
        line = _melodic_line(item.score, bar)
        signature = _motif_signature(line)
        fragment = _motif_fragment(item.encoded, bar)
        if signature is not None and fragment:
            past.append((bar, line, signature, fragment))
            if len(past) == 8:
                break
    past.reverse()
    if not past:
        return
    width = max(len(row[3]) for row in past)
    motif_tokens = torch.zeros(1, len(past), width, dtype=torch.long)
    motif_known = torch.zeros_like(motif_tokens, dtype=torch.bool)
    for index, (_, _, _, fragment) in enumerate(past):
        motif_tokens[0, index, :len(fragment)] = torch.tensor(fragment, dtype=torch.long)
        motif_known[0, index, :len(fragment)] = True
    inputs['motif_tokens'], inputs['motif_known'] = motif_tokens, motif_known
    recall = torch.zeros(1, PLAN_BARS, dtype=torch.long)
    known = torch.zeros(1, PLAN_BARS, dtype=torch.bool)
    shift = torch.zeros(1, PLAN_BARS)
    duration = torch.zeros(1, PLAN_BARS)
    transformed = torch.zeros_like(known)
    for offset in range(min(PLAN_BARS, len(item.score.measures) - target_bar)):
        line = _melodic_line(item.score, target_bar + offset)
        signature = _motif_signature(line)
        if signature is None:
            continue
        known[0, offset] = True
        for index in range(len(past) - 1, -1, -1):
            prior = past[index][1]
            if signature[0] != past[index][2][0] or signature[1:] != past[index][2][1:]:
                continue
            transposition = line[0].pitch - prior[0].pitch
            ratio = (line[1].onset - line[0].onset) / (prior[1].onset - prior[0].onset)
            if abs(transposition) > 24 or not Fraction(1, 4) <= ratio <= 4:
                continue
            recall[0, offset] = index + 1
            shift[0, offset] = float(transposition)
            duration[0, offset] = math.log(float(ratio))
            transformed[0, offset] = True
            break
    targets.update(motif_recall=recall, motif_recall_known=known,
                   motif_pitch_shift=shift, motif_pitch_shift_known=transformed,
                   motif_log_duration=duration, motif_log_duration_known=transformed)


def _tonic_pc(key: dict | None) -> int | None:
    if key is None or key.get('fifths') is None:
        return None
    mode = str(key.get('mode') or '').lower()
    if mode not in ('major', 'minor'):
        return None
    return (7 * int(key['fifths']) + (9 if mode == 'minor' else 0)) % 12


def add_key_direction_targets(score: ScoreEvents, targets: dict, target_bar: int) -> None:
    direction = torch.zeros(1, PLAN_BARS, dtype=torch.long)
    known = torch.zeros(1, PLAN_BARS, dtype=torch.bool)
    previous = score.measures[target_bar - 1].key
    for offset in range(min(PLAN_BARS, len(score.measures) - target_bar)):
        current = score.measures[target_bar + offset].key
        a, b = _tonic_pc(previous), _tonic_pc(current)
        if (a is not None and b is not None
                and str(previous.get('mode') or 'major').lower() ==
                str(current.get('mode') or 'major').lower()):
            delta = (b - a) % 12
            direction[0, offset] = 12 if delta == 0 else delta
            known[0, offset] = True
        previous = current
    targets['key_direction'], targets['key_direction_known'] = direction, known


def add_expression_targets(item: MidiItem, targets: dict, target_bar: int) -> None:
    """Phrase strength and absolute tempo are source-known only for MIDI."""
    strength = torch.zeros(1, PLAN_BARS, 2)
    strength_known = torch.zeros_like(strength, dtype=torch.bool)
    tempo = torch.zeros(1, PLAN_BARS)
    tempo_known = torch.zeros_like(tempo, dtype=torch.bool)
    for offset in range(min(PLAN_BARS, len(item.score.measures) - target_bar)):
        bar = target_bar + offset
        values = [item.velocities[n.source_index] / 127.0 for n in item.score.events
                  if n.bar == bar and n.source_index in item.velocities]
        if values:
            average = sum(values) / len(values)
            variance = sum((value - average) ** 2 for value in values) / len(values)
            strength[0, offset] = torch.tensor((average, math.sqrt(variance)))
            strength_known[0, offset] = True
        qpm = item.bar_tempos[bar]
        if qpm is not None and math.isfinite(qpm) and qpm > 0:
            tempo[0, offset] = math.log(qpm)
            tempo_known[0, offset] = True
    targets.update(phrase_strength=strength, phrase_strength_known=strength_known,
                   tempo_level=tempo, tempo_level_known=tempo_known)
