"""Exact-time state and hard constraints for an eventual four-pillar decoder.

This module is deterministic: learned proposals may choose *unlocked* notes,
groups and tempo, but cannot silently change explicitly supplied material.
No fixed model voice capacity is imposed; resource ceilings must be explicit.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from fractions import Fraction

import torch

from four_pillar_codec import GROUPS, ROLES
from four_pillar_v1_model import VOICE_FEATURES
from score_events_v2 import Measure, NoteEvent


@dataclass(frozen=True)
class InstrumentControl:
    mode: str  # off, fixed, walk
    role: str | None = None
    low: int = 0
    high: int = 127

    def __post_init__(self):
        if self.mode not in ('off', 'fixed', 'walk') or (self.role is not None and self.role not in ROLES):
            raise ValueError('invalid instrument mode or role')
        if not 0 <= self.low <= self.high <= 127:
            raise ValueError('invalid sounding range')


@dataclass(frozen=True)
class TempoControl:
    mode: str  # fixed or walk
    qpm: float
    low: float = 30.0
    high: float = 240.0
    max_log_step: float = 0.15

    def __post_init__(self):
        if (self.mode not in ('fixed', 'walk')
                or not all(math.isfinite(x) for x in (self.qpm, self.low, self.high,
                                                       self.max_log_step))
                or self.qpm <= 0 or not self.low <= self.qpm <= self.high
                or self.max_log_step < 0):
            raise ValueError('invalid tempo control')


@dataclass(frozen=True)
class ChordEvent:
    onset: Fraction
    root: int
    quality: int
    hard_locked: bool = False

    def __post_init__(self):
        if not 0 <= self.root < 12 or not 0 <= self.quality < 40:
            raise ValueError('invalid chord class')


@dataclass(frozen=True)
class VoiceEntry:
    voice_id: tuple[str, str, str]
    group: str | None
    role: str | None
    low: int
    high: int


@dataclass(frozen=True)
class ActiveNote:
    voice_id: tuple[str, str, str]
    pitch: int | None
    end: Fraction


@dataclass(frozen=True)
class CommittedBar:
    measure: Measure
    notes: tuple[NoteEvent, ...]
    chords: tuple[ChordEvent, ...]
    group_active: tuple[bool, ...]
    qpm: float


def resolve_group_activity(controls: tuple[InstrumentControl, ...],
                           proposed: tuple[bool, ...]) -> tuple[bool, ...]:
    if len(controls) != len(GROUPS) or len(proposed) != len(GROUPS):
        raise ValueError('six group controls and proposals are required')
    return tuple(c.mode == 'fixed' or (c.mode == 'walk' and bool(p))
                 for c, p in zip(controls, proposed))


def resolve_tempo(control: TempoControl, proposed_delta_log_qpm: float) -> float:
    if control.mode == 'fixed':
        return control.qpm
    delta = max(-control.max_log_step, min(control.max_log_step, proposed_delta_log_qpm))
    value = control.qpm * math.exp(delta)
    return max(control.low, min(control.high, value))


@dataclass
class CompositionState:
    """Only committed notes may update the registry, active notes and bar cursor."""

    next_bar: int = 0
    voices: dict[tuple[str, str, str], VoiceEntry] = field(default_factory=dict)
    active_notes: tuple[ActiveNote, ...] = ()
    bars: tuple[CommittedBar, ...] = ()
    max_voices: int | None = None

    def voice_features(self) -> tuple[torch.Tensor, tuple[tuple[str, str, str], ...]]:
        """Return [N,16] metadata for the dynamic pointer, in registry order."""
        identities = tuple(self.voices)
        values = torch.zeros(len(identities), VOICE_FEATURES)
        for index, identity in enumerate(identities):
            entry = self.voices[identity]
            if entry.group in GROUPS:
                values[index, GROUPS.index(entry.group)] = 1
            if entry.role in ROLES:
                values[index, len(GROUPS) + ROLES.index(entry.role)] = 1
            values[index, -2] = entry.low / 127
            values[index, -1] = entry.high / 127
        return values, identities

    def commit_bar(self, measure: Measure, *, proposed_notes: tuple[NoteEvent, ...],
                   locked_notes: tuple[NoteEvent, ...] = (),
                   locked_voice_ids: tuple[tuple[str, str, str], ...] = (),
                   proposed_chords: tuple[ChordEvent, ...] = (),
                   locked_chords: tuple[ChordEvent, ...] = (),
                   group_controls: tuple[InstrumentControl, ...],
                   proposed_group_active: tuple[bool, ...],
                   tempo: TempoControl, proposed_tempo_delta: float = 0.0) -> CommittedBar:
        if measure.index != self.next_bar:
            raise ValueError('bar must be committed in order')
        active = resolve_group_activity(group_controls, proposed_group_active)
        qpm = resolve_tempo(tempo, proposed_tempo_delta)
        if not math.isfinite(qpm):
            raise ValueError('nonfinite tempo proposal')
        locked_ids = set(locked_voice_ids) | {note.voice_id for note in locked_notes}
        if any(note.voice_id in locked_ids for note in proposed_notes):
            raise ValueError('generated note conflicts with a hard-locked voice')
        all_notes = tuple(locked_notes) + tuple(proposed_notes)
        for note in all_notes:
            if (note.bar != measure.index or note.onset < measure.onset
                    or note.onset > measure.onset + measure.duration
                    or note.duration < 0 or (note.duration == 0 and not note.grace)):
                raise ValueError('note does not fit declared bar or exact-time grammar')
        if any(chord.onset < measure.onset or chord.onset > measure.onset + measure.duration
               for chord in proposed_chords + locked_chords):
            raise ValueError('chord onset outside declared bar')
        locked_times = {chord.onset for chord in locked_chords}
        if any(chord.onset in locked_times for chord in proposed_chords):
            raise ValueError('generated chord conflicts with a hard-locked chord')

        voices = dict(self.voices)
        for note in all_notes:
            identity = note.voice_id
            if identity not in voices:
                voices[identity] = VoiceEntry(identity, note.group, note.role, 0, 127)
            entry = voices[identity]
            if note.group != entry.group or (entry.role is not None and note.role != entry.role):
                raise ValueError('voice identity, group or fixed role changed')
            if note.group in GROUPS:
                group_index = GROUPS.index(note.group)
                if not active[group_index]:
                    raise ValueError('note uses an inactive instrument group')
                control = group_controls[group_index]
                if control.role is not None and note.role != control.role:
                    raise ValueError('note conflicts with fixed instrument role')
                if note.pitch is not None and not control.low <= note.pitch <= control.high:
                    raise ValueError('note outside sounding register')
            if note.pitch is not None and not entry.low <= note.pitch <= entry.high:
                raise ValueError('note outside voice register')
        if self.max_voices is not None and len(voices) > self.max_voices:
            raise ValueError('explicit voice resource limit exceeded')
        notes = tuple(sorted(all_notes, key=lambda n: (n.onset, n.part, n.staff, n.voice,
                                                       -1 if n.pitch is None else n.pitch,
                                                       n.source_index)))
        chords = tuple(sorted(locked_chords + proposed_chords,
                              key=lambda c: (c.onset, c.root, c.quality)))
        bar_end = measure.onset + measure.duration
        active_notes = tuple(note for note in self.active_notes if note.end > bar_end) + tuple(
            ActiveNote(note.voice_id, note.pitch, note.end)
            for note in notes if note.end > bar_end)
        committed = CommittedBar(measure, notes, chords, active, qpm)
        self.voices = voices
        self.active_notes = active_notes
        self.bars += (committed,)
        self.next_bar += 1
        return committed
