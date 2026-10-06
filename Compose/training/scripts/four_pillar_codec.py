"""Lossless score-event wire format for the four-pillar *training candidate*.

This is an exact notation/event codec, not a trained model. Fractions use canonical
unsigned LEB128 numerator and denominator bytes; no sixteenth-note rounding.
Score identity, part metadata and source provenance stay in the sidecar. The voice
table is a score-local encoding table, not a future-material conditioning input.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from fractions import Fraction

from score_events_v2 import NoteEvent, ScoreEvents

PAD, BOS, BAR, ONSET, NOTE, END_ONSET, END_BAR, END_SCORE = range(8)
NONE, ESCAPE, UNPITCHED, GRACE_NO, GRACE_YES = range(8, 13)
BYTE_BASE = 32
PITCH_BASE = BYTE_BASE + 256
WRITTEN_BASE = PITCH_BASE + 128
GROUPS = ('woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings')
ROLES = ('rhythm', 'mel', 'rhythm+harm', 'mel+rhythm', 'harm',
         'mel+harm', 'mel+rhythm+harm', 'rhythn')
DYNAMICS = ('p', 'f', 'pp', 'ff', 'sf', 'mf', 'other-dynamics', 'fz', 'fff',
            'fp', 'ppp', 'mp', 'sfp', 'sfz', 'rf', 'rfz', 'ffff', 'sffz',
            'pppp', 'sfpp', 'ppppp', 'pppppp')
WEDGES = ('crescendo', 'diminuendo')
GROUP_BASE = WRITTEN_BASE + 128
ROLE_BASE = GROUP_BASE + len(GROUPS)
DYNAMIC_BASE = ROLE_BASE + len(ROLES)
WEDGE_BASE = DYNAMIC_BASE + len(DYNAMICS)
ACCENT_BASE = WEDGE_BASE + len(WEDGES)
VOCAB_SIZE = ACCENT_BASE + 3


def _uint(value: int) -> list[int]:
    if not isinstance(value, int) or value < 0:
        raise ValueError('wire integer must be nonnegative')
    out = []
    while value >= 128:
        out.append(BYTE_BASE + (value & 127) + 128)
        value >>= 7
    out.append(BYTE_BASE + value)
    return out


class _Reader:
    def __init__(self, tokens):
        self.tokens = tuple(tokens)
        self.i = 0

    def pop(self) -> int:
        if self.i >= len(self.tokens):
            raise ValueError('truncated event stream')
        value = self.tokens[self.i]
        self.i += 1
        if not isinstance(value, int) or not 0 <= value < VOCAB_SIZE:
            raise ValueError('token outside vocabulary')
        return value

    def peek(self) -> int:
        if self.i >= len(self.tokens):
            raise ValueError('truncated event stream')
        return self.tokens[self.i]

    def expect(self, expected: int):
        if self.pop() != expected:
            raise ValueError(f'expected token {expected} at {self.i - 1}')

    def uint(self) -> int:
        value = shift = 0
        for n in range(10):
            token = self.pop() - BYTE_BASE
            if not 0 <= token <= 255:
                raise ValueError('expected LEB128 byte')
            value |= (token & 127) << shift
            if token < 128:
                if _uint(value) != list(self.tokens[self.i - n - 1:self.i]):
                    raise ValueError('noncanonical LEB128')
                return value
            shift += 7
        raise ValueError('LEB128 integer too long')

    def fraction(self) -> Fraction:
        numerator, denominator = self.uint(), self.uint()
        if denominator == 0:
            raise ValueError('zero time denominator')
        value = Fraction(numerator, denominator)
        if value.numerator != numerator or value.denominator != denominator:
            raise ValueError('noncanonical fraction')
        return value

    def label(self, values: tuple[str, ...], base: int) -> str | None:
        token = self.pop()
        if token == NONE:
            return None
        if base <= token < base + len(values):
            return values[token - base]
        if token != ESCAPE:
            raise ValueError('invalid label token')
        size = self.uint()
        if size > 128:
            raise ValueError('label too long')
        raw = bytearray()
        for _ in range(size):
            byte = self.pop() - BYTE_BASE
            if not 0 <= byte < 256:
                raise ValueError('invalid label byte')
            raw.append(byte)
        return raw.decode('utf-8')


def _fraction(value: Fraction) -> list[int]:
    value = Fraction(value)
    if value < 0:
        raise ValueError('negative score time')
    return _uint(value.numerator) + _uint(value.denominator)


def _label(value: str | None, options: tuple[str, ...], base: int) -> list[int]:
    if value is None:
        return [NONE]
    if value in options:
        return [base + options.index(value)]
    raw = value.encode('utf-8')
    if len(raw) > 128:
        raise ValueError('label too long')
    return [ESCAPE] + _uint(len(raw)) + [BYTE_BASE + b for b in raw]


@dataclass(frozen=True)
class EncodedScore:
    tokens: tuple[int, ...]
    voice_ids: tuple[tuple[str, str, str], ...]
    source_indices: tuple[int, ...]
    # Inclusive start, exclusive end of each note's complete token payload.
    note_spans: tuple[tuple[int, int], ...]
    # Token span per bar; intervals never bisect an onset_slice.
    bar_spans: tuple[tuple[int, int], ...]
    # Unknown source labels are context symbols, never prediction targets.
    loss_mask: tuple[bool, ...] = ()


def encode_score(score: ScoreEvents) -> EncodedScore:
    voices = score.voice_ids()
    voice_index = {voice: i for i, voice in enumerate(voices)}
    tokens = [BOS]
    source_indices, spans, bars = [], [], []
    unknown_label_positions = []
    by_bar: list[list[NoteEvent]] = [[] for _ in score.measures]
    for note in score.events:
        by_bar[note.bar].append(note)
    for measure, notes in zip(score.measures, by_bar):
        start = len(tokens)
        tokens.append(BAR)
        tokens += _fraction(measure.onset) + _fraction(measure.duration)
        tokens += _uint(measure.meter[0]) + _uint(measure.meter[1])
        previous = measure.onset
        for i, note in enumerate(notes):
            if i == 0 or note.onset != previous:
                tokens.append(ONSET)
                tokens += _fraction(note.onset - previous)
                previous = note.onset
            note_start = len(tokens)
            tokens.append(NOTE)
            tokens += _uint(voice_index[note.voice_id])
            # Instrument/role precede pitch so these conditions can affect
            # what note is written, rather than merely label it afterwards.
            if note.group is None:
                unknown_label_positions.append(len(tokens))
            tokens += _label(note.group, GROUPS, GROUP_BASE)
            if note.role is None:
                unknown_label_positions.append(len(tokens))
            tokens += _label(note.role, ROLES, ROLE_BASE)
            tokens.append(UNPITCHED if note.pitch is None else PITCH_BASE + note.pitch)
            tokens += _fraction(note.duration)
            tokens.append(NONE if note.written_pitch is None else WRITTEN_BASE + note.written_pitch)
            if note.tuplet is None:
                tokens.append(NONE)
            else:
                a, b = (int(x) for x in note.tuplet.split(':'))
                tokens += _uint(a) + _uint(b)
            if note.dynamic is None:
                unknown_label_positions.append(len(tokens))
            tokens += _label(note.dynamic, DYNAMICS, DYNAMIC_BASE)
            tokens += _label(note.wedge, WEDGES, WEDGE_BASE)
            if not 0 <= note.accent <= 2:
                raise ValueError('accent outside supported range')
            tokens.append(ACCENT_BASE + note.accent)
            tokens.append(GRACE_YES if note.grace else GRACE_NO)
            source_indices.append(note.source_index)
            spans.append((note_start, len(tokens)))
            if i + 1 == len(notes) or notes[i + 1].onset != note.onset:
                tokens.append(END_ONSET)
        tokens.append(END_BAR)
        bars.append((start, len(tokens)))
    tokens.append(END_SCORE)
    loss_mask = [True] * len(tokens)
    for position in unknown_label_positions:
        loss_mask[position] = False
    return EncodedScore(tuple(tokens), voices, tuple(source_indices), tuple(spans),
                        tuple(bars), tuple(loss_mask))


def decode_score(encoded: EncodedScore, template: ScoreEvents) -> ScoreEvents:
    reader = _Reader(encoded.tokens)
    reader.expect(BOS)
    notes: list[NoteEvent] = []
    for measure in template.measures:
        reader.expect(BAR)
        bar_on, bar_duration = reader.fraction(), reader.fraction()
        meter = (reader.uint(), reader.uint())
        if (bar_on, bar_duration, meter) != (measure.onset, measure.duration, measure.meter):
            raise ValueError('bar metadata differs from template')
        on = bar_on
        while reader.peek() == ONSET:
            reader.pop()
            on += reader.fraction()
            if on > measure.onset + measure.duration:
                raise ValueError('onset exceeds bar')
            count = 0
            while reader.peek() == NOTE:
                reader.pop()
                voice_index = reader.uint()
                if voice_index >= len(encoded.voice_ids):
                    raise ValueError('unknown score-local voice')
                part, staff, voice = encoded.voice_ids[voice_index]
                group = reader.label(GROUPS, GROUP_BASE)
                role = reader.label(ROLES, ROLE_BASE)
                p = reader.pop()
                if p == UNPITCHED:
                    pitch = None
                elif PITCH_BASE <= p < PITCH_BASE + 128:
                    pitch = p - PITCH_BASE
                else:
                    raise ValueError('invalid pitch token')
                duration = reader.fraction()
                wp = reader.pop()
                if wp == NONE:
                    written = None
                elif WRITTEN_BASE <= wp < WRITTEN_BASE + 128:
                    written = wp - WRITTEN_BASE
                else:
                    raise ValueError('invalid written pitch')
                next_token = reader.peek()
                if next_token == NONE:
                    reader.pop()
                    tuplet = None
                else:
                    tuplet = f'{reader.uint()}:{reader.uint()}'
                dynamic = reader.label(DYNAMICS, DYNAMIC_BASE)
                wedge = reader.label(WEDGES, WEDGE_BASE)
                accent_token = reader.pop()
                if not ACCENT_BASE <= accent_token < ACCENT_BASE + 3:
                    raise ValueError('invalid accent')
                grace_token = reader.pop()
                if grace_token not in (GRACE_NO, GRACE_YES):
                    raise ValueError('invalid grace flag')
                grace = grace_token == GRACE_YES
                if duration == 0 and not grace:
                    raise ValueError('non-grace zero duration')
                notes.append(NoteEvent(
                    source_index=encoded.source_indices[len(notes)] if len(notes) < len(encoded.source_indices) else len(notes),
                    onset=on, duration=duration, bar=measure.index, part=part, staff=staff, voice=voice,
                    pitch=pitch, written_pitch=written, group=group, role=role, tuplet=tuplet,
                    dynamic=dynamic, wedge=wedge, accent=accent_token - ACCENT_BASE,
                    grace=grace, unpitched=pitch is None,
                ))
                count += 1
            if count == 0:
                raise ValueError('empty onset slice')
            reader.expect(END_ONSET)
        reader.expect(END_BAR)
    reader.expect(END_SCORE)
    if reader.i != len(reader.tokens):
        raise ValueError('trailing event tokens')
    # A note declared at the preceding barline may share its absolute onset
    # with notes declared in the next bar. Restore ScoreEvents' global order.
    order = {part.id: part.index for part in template.parts}
    notes.sort(key=lambda n: (n.onset, order[n.part], n.staff, n.voice,
                              -1 if n.pitch is None else n.pitch, n.source_index))
    return replace(template, events=tuple(notes))
