"""Exact-time, score-level event view for the proposed multi-voice composer.

This module does not quantize time, infer harmony/form/roles, create splits, or
write training shards. It only normalizes one prepared classical score record
into stable part/voice identities and exactly timed note events. Unknown group,
role, dynamic and pitch fields remain unknown rather than becoming labels.
"""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Any

GROUPS = frozenset(('woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings'))


def exact_time(value: str | int | Fraction) -> Fraction:
    result = Fraction(value)
    if result < 0:
        raise ValueError(f'negative score time: {value}')
    return result


@dataclass(frozen=True)
class Measure:
    index: int
    onset: Fraction                 # absolute quarter-note units
    duration: Fraction
    meter: tuple[int, int]
    irregular: bool
    key: dict[str, Any] | None


@dataclass(frozen=True)
class Part:
    id: str
    index: int
    name: str
    sound: str
    group: str | None
    program: int | None
    mapping: str | None


@dataclass(frozen=True)
class NoteEvent:
    source_index: int                # preserves multiple identical/unison notes
    onset: Fraction                  # absolute, exact quarter-note units
    duration: Fraction
    bar: int
    part: str
    staff: str
    voice: str
    pitch: int | None                # sounding MIDI pitch; None for unpitched
    written_pitch: int | None
    group: str | None
    role: str | None                  # source annotation only, never guessed
    tuplet: str | None               # notated ratio, distinct from actual time
    dynamic: str | None              # score mark, not MIDI velocity
    wedge: str | None
    accent: int
    grace: bool
    unpitched: bool

    @property
    def voice_id(self) -> tuple[str, str, str]:
        return self.part, self.staff, self.voice

    @property
    def end(self) -> Fraction:
        return self.onset + self.duration


@dataclass(frozen=True)
class ScoreEvents:
    score_id: str
    source: str | None
    composer: str | None
    work: str | None
    movement: str | None
    composition_key: str | None
    score_sha256: str | None
    parts: tuple[Part, ...]
    measures: tuple[Measure, ...]
    events: tuple[NoteEvent, ...]

    @classmethod
    def from_candidate(cls, record: dict[str, Any]) -> 'ScoreEvents':
        parts = tuple(Part(id=p['id'], index=i, name=p.get('name', ''), sound=p.get('sound', ''),
                           group=p.get('group'), program=p.get('program'), mapping=p.get('mapping'))
                      for i, p in enumerate(record['parts']))
        part_order = {part.id: part.index for part in parts}
        if len(part_order) != len(parts):
            raise ValueError('duplicate part IDs')
        measures = tuple(Measure(index=i, onset=exact_time(m['on']), duration=exact_time(m['dur']),
                                 meter=tuple(m['meter']), irregular=bool(m.get('irregular', False)),
                                 key=m.get('key')) for i, m in enumerate(record['measures']))
        if not measures or any(m.duration <= 0 or len(m.meter) != 2 or min(m.meter) <= 0 for m in measures):
            raise ValueError('invalid measure duration or meter')
        if any(measures[i].onset < measures[i - 1].onset for i in range(1, len(measures))):
            raise ValueError('measures are out of order')
        notes = []
        for i, raw in enumerate(record['notes']):
            bar = int(raw['bar'])
            if bar < 0 or bar >= len(measures) or raw['part'] not in part_order:
                raise ValueError(f'note {i} has unknown bar or part')
            onset, duration = exact_time(raw['on']), exact_time(raw['dur'])
            if duration == 0 and not raw.get('grace', False):
                raise ValueError(f'non-grace note {i} has zero duration')
            if onset < measures[bar].onset:
                raise ValueError(f'note {i} starts before its declared bar')
            pitch = raw.get('pitch')
            written = raw.get('writtenPitch')
            if any(p is not None and (not isinstance(p, int) or not 0 <= p <= 127)
                   for p in (pitch, written)):
                raise ValueError(f'note {i} has invalid MIDI pitch')
            group = raw.get('group')
            if group is not None and group not in GROUPS:
                raise ValueError(f'note {i} has unknown instrument group {group}')
            notes.append(NoteEvent(source_index=i, onset=onset, duration=duration, bar=bar,
                                   part=raw['part'], staff=str(raw['staff']), voice=str(raw['voice']),
                                   pitch=pitch, written_pitch=written, group=group,
                                   role=raw.get('role'), tuplet=raw.get('tuplet'),
                                   dynamic=raw.get('dynamic'), wedge=raw.get('wedge'),
                                   accent=int(raw.get('accent', 0)), grace=bool(raw.get('grace', False)),
                                   unpitched=bool(raw.get('unpitched', False))))
        # Simultaneous notes share a time slice; stable part/voice/pitch order is
        # a serialization convention, not a claim that one is heard first.
        notes.sort(key=lambda n: (n.onset, part_order[n.part], n.staff, n.voice,
                                  -1 if n.pitch is None else n.pitch, n.source_index))
        return cls(score_id=record['scoreId'], source=record.get('source'),
                   composer=record.get('composer'), work=record.get('work'),
                   movement=record.get('movement'), composition_key=record.get('compositionKey'),
                   score_sha256=record.get('scoreSha256'), parts=parts,
                   measures=measures, events=tuple(notes))

    def onset_slices(self) -> tuple[tuple[NoteEvent, ...], ...]:
        """Group simultaneous note events without discarding doubled/unison notes."""
        slices: list[list[NoteEvent]] = []
        for event in self.events:
            if not slices or slices[-1][0].onset != event.onset:
                slices.append([])
            slices[-1].append(event)
        return tuple(tuple(notes) for notes in slices)

    def voice_ids(self) -> tuple[tuple[str, str, str], ...]:
        """Stable score-specific identities; role and instrument remain separate."""
        seen = {event.voice_id for event in self.events}
        order = {part.id: part.index for part in self.parts}
        return tuple(sorted(seen, key=lambda voice: (order[voice[0]], voice[1], voice[2])))
