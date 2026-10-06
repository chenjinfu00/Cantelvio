"""Four-pillar v3.1 training windows and the shared streaming state.

`StreamState` is used both here (fed with source events) and by the sampler (fed
with generated events), so every conditioning feature is computed by the same
code at training and generation time. Inputs only ever describe committed past
events; the attributes of the event being predicted are targets, and the parts
of them decided earlier in the attribute order (onset before group, group
before voice, ...) are teacher-forced conditions for the later heads.

Pitch: every bar has a local key; pitches enter and leave the model as indices
relative to the key's tonic (four_pillar_v31_tonal), chord roots likewise. The
state keeps absolute pitches internally (voices, intervals, sounding notes), so
nothing is lost: the sounding pitch is tonic_ref + index - offset, exactly.

Events per bar: chord changes (explicit events, placed before the notes at the
same onset), notes, and the end of the bar. Time: onset positions within the
bar, inter-onset intervals and durations use the frozen v3.1 vocabulary of exact fractions
(four_pillar_v31_time). Counts of snapped, remapped and dropped values are
reported with every example.

Reference bars: every bar's reference is the most similar earlier bar within
the planner history (Jaccard of key-relative (onset, pitch) items on a 1/24
quarter grid, at least REF_THRESHOLD, ties to the most recent), or none. The
pointer learns that choice; the decoder reads the reference through
StreamState.ref_lookahead / ref_aligned, which the sampler calls in the same
way on its own reference bars. A voice identity includes its instrument group,
so a part that changes group opens a new voice, as generation would.
"""
from __future__ import annotations

import bisect
import heapq
import json
import math
import random
from collections import Counter
from dataclasses import dataclass
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch

from four_pillar_codec import DYNAMICS, GROUPS, WEDGES
from four_pillar_v31_model import (ABS_NONE, ABS_UNPITCHED, CHORD_DEGREE_NONE, CHORD_QUALITY_NONE, CHORD_ROOT_NONE, CONFIG,
                                   CONTINUOUS_BAR, CONTINUOUS_EVENT, CONTINUOUS_ONSET, DEGREE_NONE, DENSITY_BUCKETS,
                                   HARMONY_FEATURES, INTERVAL_NONE, INTERVAL_UNPITCHED, KEY_NONE, KIND_CHORD,
                                   KIND_END, KIND_NOTE, KIND_START, MODULATION_NONE, PITCH_NONE, PITCH_UNPITCHED,
                                   REF_COUNT_NONE, REF_GROUP_NONE, REGISTER_NONE, SLOT_FEATURES, SOURCE_NONE, SOURCES,
                                   UNKNOWN_GROUP, VELOCITY_UNKNOWN, VOICE_FEATURES)
from four_pillar_v31_time import TimeVocabulary, cluster_onsets, snap, snap_duration
from four_pillar_v31_tonal import (PROFILE_DIM, REL_OFFSET, TONIC_LOW, NoteTable, analyze, beat_length, key_change_class,
                                   key_parts, profile_bin, tonic_ref, transpose_analysis)

ROOT = Path(__file__).resolve().parents[1]
QUALITIES = json.loads((ROOT / 'data/chord-qualities.json').read_text())
SCORE_SOURCES = frozenset({'Lieder', 'classical-scores'})
TWO_PI = 2 * math.pi
REGISTER_EDGES = (40, 48, 55, 60, 65, 72, 79)
DEN_CODES = {1: 1, 2: 2, 4: 3, 8: 4, 16: 5}
CONTROL_DROP = {'groups': .5, 'density': .5, 'source': .3, 'reference': .2}
REF_THRESHOLD, REF_GRID = .5, 24      # reference: Jaccard >= .5 over (onset on a 1/24-quarter grid, relative pitch)
RECENCY_EVENTS, RECENCY_QUARTERS = 2048, 256
LOG_EVENTS, LOG_QUARTERS = math.log1p(512.), math.log1p(64.)
# Snapping is a pure function of exact values that repeat constantly in a piece.
cached_snap = lru_cache(maxsize=1 << 16)(snap)
cached_snap_duration = lru_cache(maxsize=1 << 16)(snap_duration)


def lookup(vocab: TimeVocabulary, value: Fraction, positive: bool = False) -> tuple[int, bool]:
    """TimeVocabulary.lookup with a per-vocabulary memo (the vocabulary is frozen)."""
    memo = vocab.__dict__.setdefault('_v31_memo', {})
    key = (value, positive)
    found = memo.get(key)
    if found is None:
        if len(memo) > 1 << 17:
            memo.clear()
        found = memo[key] = vocab.lookup(value, positive)
    return found


def density_bucket(count: int) -> int:
    for bucket, limit in enumerate((0, 2, 4, 8, 16, 32, 64)):
        if count <= limit:
            return bucket
    return DENSITY_BUCKETS - 1


def register_bucket(mean_pitch: float) -> int:
    return sum(mean_pitch >= edge for edge in REGISTER_EDGES)


def meter_codes(meter, known: bool) -> tuple[int, int]:
    if not known or meter is None:
        return 0, 0
    return max(1, min(16, int(meter[0]))), DEN_CODES.get(int(meter[1]), 0)


def tempo_feature(tempo) -> tuple[float, float]:
    if tempo is None or not tempo > 0:
        return 0., 0.
    return (math.log(float(tempo)) - math.log(100.)) / math.log(2.) / 2., 1.


def _ratio(a: Fraction, b: Fraction) -> float:
    """float(a / b) for exact fractions, correctly rounded, without building Fraction objects."""
    return (a.numerator * b.denominator) / (a.denominator * b.numerator)


@lru_cache(maxsize=1 << 16)
def phases(position: Fraction, length: Fraction, beat: Fraction) -> tuple[float, float]:
    """(beat phase, bar phase) in [0, 1), from exact fractions."""
    n, d = position.numerator * beat.denominator, position.denominator * beat.numerator
    return (n % d) / d, (_ratio(position, length) if length > 0 else 0.)


@lru_cache(maxsize=1 << 16)
def phase_features(position: Fraction, length: Fraction, beat: Fraction) -> tuple[float, ...]:
    out = []
    for x in phases(position, length, beat):
        out += [math.sin(TWO_PI * x), math.cos(TWO_PI * x), math.sin(2 * TWO_PI * x), math.cos(2 * TWO_PI * x)]
    return tuple(out)


@lru_cache(maxsize=1 << 16)
def metric_level(position: Fraction, beat: Fraction) -> int:
    """0 downbeat, 1 beat, 2 beat division, 3 subdivision, 4 anything else (tuplets, off-grid)."""
    if position == 0:
        return 0
    compound = beat.numerator % 3 == 0
    for level, unit in ((1, beat), (2, beat / (3 if compound else 2)), (3, beat / (6 if compound else 4))):
        value = position / unit
        if value.denominator == 1:
            return level
    return 4


@lru_cache(maxsize=None)
def _chord_tones(root: int, quality: int) -> tuple[float, ...]:
    tones = [0.] * 12
    if 0 <= root < 12 and 0 <= quality < len(QUALITIES):
        for interval in QUALITIES[quality]['intervals']:
            tones[(root + interval) % 12] = 1.
    return tuple(tones)


def chord_tones(root: int, quality: int) -> list[float]:
    return list(_chord_tones(root, quality))


def key_summary(row: list[float] | np.ndarray, key: int, previous: int | None) -> list[float]:
    """Planner input for one completed bar: summarize_bars' 20 values with the pitch-class part rotated
    to scale degrees of the bar's key, then mode one-hot and the tonic step from the previous bar."""
    row = [float(x) for x in row]
    tonic, mode = key_parts(key)
    out = [row[(tonic + d) % 12] for d in range(12)] + row[12:20] + [float(mode == 0), float(mode == 1)]
    step = [0.] * 12
    if previous is not None:
        step[(tonic - previous % 12) % 12] = 1.
    return out + step


def bar_profile(events, length: Fraction, tonic: int) -> list[float]:
    """Generation-side twin of NoteTable.profiles for one bar: events = [(position Fraction, pitch or None)]."""
    onsets: dict = {}
    for position, pitch in events:
        onsets.setdefault(position, []).append(pitch)
    out = [0.] * PROFILE_DIM
    pitched = 0
    size = length.numerator / length.denominator
    for position, pitches in onsets.items():
        out[profile_bin(position.numerator / position.denominator, size)] += 1.
        real = [p for p in pitches if p is not None]
        if real:
            pitched += 1
            out[16 + (max(real) - tonic) % 12] += 1.
            out[28 + (min(real) - tonic) % 12] += 1.
    if onsets:
        out[:16] = [x / len(onsets) for x in out[:16]]
    if pitched:
        out[16:] = [x / pitched for x in out[16:]]
    return out


def bar_vector(row: list[float] | np.ndarray, key: int, previous: int | None, profile, index: int) -> list[float]:
    """Planner input for one completed bar: key_summary (34) + rhythm/top/bass profile (40) + phrase position
    (bar index phases over 4 and 16 bars, as in the event inputs)."""
    return (key_summary(row, key, previous) + [float(x) for x in profile]
            + [math.sin(TWO_PI * index / 4), math.cos(TWO_PI * index / 4), math.sin(TWO_PI * index / 16),
               math.cos(TWO_PI * index / 16)])


def canonical_reference(notes) -> tuple:
    """(onset index, group, relative pitch, duration index) in bar_notes order: by onset, unpitched first, then
    pitched from the lowest up; ties keep their order."""
    return tuple(sorted(notes, key=lambda n: (n[0], (0, n[1]) if n[2] == PITCH_UNPITCHED else (1, n[2]), n[1])))


class Reference:
    """A reference bar as the decoder reads it: notes by onset index, each (group, pitch relative to the reference
    bar's key, duration index). Built from source notes in training and from generated notes in the sampler."""

    def __init__(self, notes):
        self.notes = canonical_reference(notes)
        self.at: dict[int, list] = {}
        for onset, group, pitch, duration in self.notes:
            self.at.setdefault(onset, []).append((group, pitch, duration))
        self.onsets = sorted(self.at)
        self.degrees = {onset: [float(any(p < PITCH_UNPITCHED and (p - REL_OFFSET) % 12 == d for _, p, _ in notes))
                                for d in range(12)] for onset, notes in self.at.items()}


def reference_notes(notes, vocab: TimeVocabulary, length: Fraction, tonic: int) -> list[tuple[int, int, int, int]]:
    """Reference view of one bar's source notes (bar_notes order): onset vocabulary index (never before the previous
    note, inside the bar), group, pitch relative to the bar's tonic (PITCH_UNPITCHED for drums), duration index."""
    out, running, base = [], 0., tonic_ref(tonic)
    floats = vocab.floats
    for n in notes:
        index = lookup(vocab, n.position)[0]
        if floats[index] < running:
            index = bisect.bisect_left(floats, running)
        if index >= len(vocab) or vocab.value(index) >= length:
            continue
        running = floats[index]
        pitch = PITCH_UNPITCHED if n.pitch == ABS_UNPITCHED else n.pitch - base + REL_OFFSET
        out.append((index, n.group, pitch, n.duration_index))
    return out


def reference_items(table: NoteTable, keys, first: int, last: int) -> tuple[np.ndarray, np.ndarray]:
    """Unique (bar, item) pairs of bars first..last sorted by bar; item = onset on the 1/24 grid x 256 + pitch
    relative to the bar's key (PITCH_UNPITCHED for drums)."""
    keep = ~table.grace & (table.duration > 0) & (table.bar >= first) & (table.bar <= last)
    bar = table.bar[keep]
    position = np.rint((table.onset[keep] - table.bar_onset[bar]) * REF_GRID).astype(np.int64)
    pitch = table.pitch[keep]
    tonic = np.asarray(keys, dtype=np.int64)[bar] % 12
    code = np.where(pitch >= 0, pitch - (TONIC_LOW + (tonic - 6) % 12) + REL_OFFSET, PITCH_UNPITCHED)
    key = np.unique(bar * (1 << 40) + position * 256 + code)
    return key >> 40, key & ((1 << 40) - 1)


def choose_references(table: NoteTable, keys, first: int, targets) -> dict[int, int | None]:
    """For each target bar: the earlier bar in first..target-1 with the highest Jaccard similarity of
    reference_items (ties to the most recent), or None below REF_THRESHOLD and for empty bars."""
    targets = list(targets)
    if not targets:
        return {}
    last = max(targets)
    bar, item = reference_items(table, keys, first, last)
    starts = np.searchsorted(bar, np.arange(first, last + 2))
    size = np.diff(starts)
    out = {}
    for b in targets:
        lo, hi, end = starts[0], starts[b - first], starts[b - first + 1]
        mine = item[hi:end]
        if not len(mine) or hi == lo:
            out[b] = None
            continue
        hit = np.isin(item[lo:hi], mine)
        inter = np.bincount(bar[lo:hi][hit] - first, minlength=b - first).astype(np.float64)
        jaccard = inter / (len(mine) + size[:b - first] - inter)
        best = jaccard.max()
        out[b] = first + int(np.flatnonzero(jaccard == best)[-1]) if best >= REF_THRESHOLD else None
    return out


@dataclass
class BarContext:
    index: int                 # bar index within the piece or session
    onset: Fraction            # absolute onset (quarters)
    length: Fraction
    meter: tuple | None
    meter_known: bool
    tempo: float | None
    key: int                   # local key id: tonic + 12 * mode
    previous_key: int | None   # key of the previous bar (None at the start)
    reference: Reference | None = None   # the bar this one may restate (decoder inputs), or none


class StreamState:
    """Voice registry, voice states, sounding notes, key, chord and bar position of one stream."""

    def __init__(self, vocab: TimeVocabulary, config: dict = CONFIG):
        self.vocab, self.config = vocab, config
        v = config['voices']
        self.registry: dict = {}
        self.slot_group = np.full(v, -1, dtype=np.int64)
        self.slot_pitch = np.full(v, ABS_NONE, dtype=np.int64)
        self.slot_event = np.full(v, -1, dtype=np.int64)
        self.slot_onset = np.zeros(v, dtype=np.float64)   # exact Fractions converted once; comparisons stay exact
        self.slot_end = np.zeros(v, dtype=np.float64)     # for musical denominators at any session length
        self.slot_interval = np.full(v, INTERVAL_NONE, dtype=np.int64)   # interval into each voice's last note
        self.heap: list = []           # (end, pitch) of pitched notes that may still sound
        self.events = 0                 # committed events (notes, chords and bar ends)
        self.bar: BarContext | None = None
        self.position = Fraction(0)
        self.bar_events = 0
        self.key, self.tonic, self.mode, self.tonic_ref = KEY_NONE, 0, 0, tonic_ref(0)
        self.chord: tuple[int, int] | None = None     # (absolute root, quality) in effect
        self.zero_index = lookup(vocab, Fraction(0))[0]
        self.position_index = self.zero_index          # vocabulary index of self.position
        self.placed_here = 0                           # notes of this bar at the current position
        self.reference: Reference | None = None

    # ---------------------------------------------------------------- bars
    def start_bar(self, bar: BarContext):
        self.bar, self.position, self.bar_events = bar, Fraction(0), 0
        self.position_index, self.placed_here, self.reference = self.zero_index, 0, bar.reference
        self.beat = beat_length(bar.meter if bar.meter_known else None)
        self.key = bar.key
        self.tonic, self.mode = key_parts(bar.key)
        self.tonic_ref = tonic_ref(self.tonic)
        self._bar_tail = self.bar_continuous() + [math.sin(TWO_PI * bar.index / 4), math.cos(TWO_PI * bar.index / 4),
                                                  math.sin(TWO_PI * bar.index / 16), math.cos(TWO_PI * bar.index / 16)]

    def modulation(self) -> int:
        b = self.bar
        return MODULATION_NONE if b.previous_key is None else key_change_class(b.previous_key, b.key)

    def bar_continuous(self) -> list[float]:
        b = self.bar
        tempo, tempo_known = tempo_feature(b.tempo)
        return [math.log2(float(b.length)) / 4. if b.length > 0 else 0., tempo, tempo_known, float(b.meter_known)]

    def event_continuous(self, position: Fraction) -> list[float]:
        return list(phase_features(position, self.bar.length, self.beat)) + self._bar_tail

    def beat_index(self, position: Fraction) -> int:
        n = position.numerator * self.beat.denominator
        return min(16, n // (position.denominator * self.beat.numerator))

    def rope(self, position: Fraction, now: Fraction | None = None) -> dict:
        """Rotary coordinates of an event at `position` in the current bar (`now`: its absolute time)."""
        beat_phase, bar_phase = phases(position, self.bar.length, self.beat)
        now = self.bar.onset + position if now is None else now
        return {'rope_time': now.numerator / now.denominator, 'rope_beat': beat_phase, 'rope_bar': bar_phase}

    # ---------------------------------------------------------------- key-relative views
    def relative(self, pitch: int) -> int:
        """Relative pitch index in the current key; PITCH_UNPITCHED / PITCH_NONE for the absolute codes."""
        if pitch == ABS_UNPITCHED:
            return PITCH_UNPITCHED
        if pitch >= ABS_NONE:
            return PITCH_NONE
        return pitch - self.tonic_ref + REL_OFFSET

    def absolute(self, index: int) -> int:
        """Sounding MIDI pitch of a relative index in the current key (ABS_UNPITCHED for unpitched)."""
        if index == PITCH_UNPITCHED:
            return ABS_UNPITCHED
        return index - REL_OFFSET + self.tonic_ref

    def chord_relative(self) -> tuple[int, int]:
        if self.chord is None:
            return CHORD_ROOT_NONE, CHORD_QUALITY_NONE
        return (self.chord[0] - self.tonic) % 12, self.chord[1]

    # ---------------------------------------------------------------- conditions for a new event
    def onset(self, position: Fraction) -> dict:
        """Features of a new onset at `position` (after the onset was chosen)."""
        if position < self.position or position >= self.bar.length:
            raise ValueError('onset outside the remaining bar')
        now = self.bar.onset + position
        now_f = now.numerator / now.denominator      # exact fractions converted once: comparisons stay exact
        while self.heap and self.heap[0][0] <= now_f:
            heapq.heappop(self.heap)
        pcs = [0.] * 12
        bass, lowest = CHORD_ROOT_NONE, 999
        for _, pitch in self.heap:
            degree = (pitch - self.tonic) % 12
            pcs[degree] = 1.
            if pitch < lowest:
                lowest, bass = pitch, degree
        bass_hot = [0.] * 12
        if bass < 12:
            bass_hot[bass] = 1.
        root, quality = self.chord_relative()
        return {'position': position, 'now': now, 'beat': self.beat_index(position),
                'level': metric_level(position, self.beat),
                'cont': list(phase_features(position, self.bar.length, self.beat)),
                'pcs': pcs, 'bass': bass, 'harm': pcs + bass_hot + [math.log1p(len(self.heap)) / math.log(16.)],
                'chord_root': root, 'chord_quality': quality, 'chord_tones': chord_tones(root, quality),
                'tonic_ref': self.tonic_ref, 'mode': self.mode}

    def recency(self, slots, now: float):
        """Events and quarters since a voice last started a note, log-scaled and capped
        (a generation session may run for hours), and whether it is still sounding."""
        events = np.log1p(np.minimum(RECENCY_EVENTS, self.events - self.slot_event[slots])) / LOG_EVENTS
        quarters = np.log1p(np.minimum(RECENCY_QUARTERS, now - self.slot_onset[slots])) / LOG_QUARTERS
        return events, quarters, self.slot_end[slots] > now

    def slot_features(self, group: int, now: Fraction) -> np.ndarray:
        v = self.config['voices']
        count = len(self.registry)
        out = np.zeros((v, SLOT_FEATURES), dtype=np.float32)
        if count < v:
            out[count, 1] = 1.
        if count:
            out[:count, 0] = 1.
            out[:count, 2] = self.slot_group[:count] == group
            out[:count, 3], out[:count, 4], out[:count, 5] = self.recency(slice(0, count), float(now))
        return out

    def voice_features(self, slot: int, now: Fraction) -> tuple[int, list[float]]:
        """Absolute previous pitch of the voice (ABS_NONE if new) and its state features."""
        if slot >= len(self.registry):
            return ABS_NONE, [1., 0., 1., 1.]
        events, quarters, sounding = self.recency(slice(slot, slot + 1), float(now))
        return int(self.slot_pitch[slot]), [0., float(sounding[0]), float(events[0]), float(quarters[0])]

    def voice_interval(self, slot: int) -> int:
        """Interval by which the voice reached its previous note (melodic direction and size)."""
        return int(self.slot_interval[slot]) if slot < len(self.registry) else INTERVAL_NONE

    @staticmethod
    def interval(last_pitch: int, pitch: int) -> int:
        if pitch >= 128 or last_pitch == ABS_UNPITCHED:
            return INTERVAL_UNPITCHED
        if last_pitch >= 128:
            return INTERVAL_NONE
        return max(-24, min(24, pitch - last_pitch)) + 24

    def slot_for(self, identity) -> int:
        """Existing slot of a voice identity, or the next free slot (not yet registered)."""
        slot = self.registry.get(identity)
        if slot is not None:
            return slot
        if len(self.registry) >= self.config['voices']:
            raise ValueError('voice registry exceeds the v3.1 limit')
        return len(self.registry)

    def chord_allowed(self, position: Fraction) -> bool:
        """A chord change may share an onset only with nothing earlier in its bar (chords precede notes)."""
        return self.bar_events == 0 or position > self.position

    def onset_range(self, limit: Fraction, strict: bool = False) -> range:
        """Vocabulary indices of onset positions from the current position (after it if strict) up to,
        excluding, `limit`. Sorted floats of exact fractions with small denominators order exactly."""
        values, position = self.vocab.floats, self.position
        low = (bisect.bisect_right if strict else bisect.bisect_left)(values, position.numerator / position.denominator)
        return range(low, max(low, bisect.bisect_left(values, limit.numerator / limit.denominator)))

    def ref_lookahead(self) -> tuple[int, int, int]:
        """Before the next event: (the reference's next onset after the current position, the current position if
        the reference has notes left there, how many are left 0..4) as vocabulary indices / classes."""
        k = len(self.vocab)
        ref = self.reference
        if ref is None:
            return k, k, REF_COUNT_NONE
        here = self.position_index
        remain = max(0, min(4, len(ref.at.get(here, ())) - self.placed_here))
        j = bisect.bisect_right(ref.onsets, here)
        return (ref.onsets[j] if j < len(ref.onsets) else k), (here if remain else k), remain

    def ref_aligned(self, onset_index: int) -> tuple[int, int, int, list[float]]:
        """After the onset: (group, relative pitch, duration index) of the reference note with the same rank among
        the notes at this onset as the next note here, and the scale degrees the reference sounds at this onset."""
        ref = self.reference
        if ref is None:
            return REF_GROUP_NONE, PITCH_NONE, len(self.vocab), [0.] * 12
        notes = ref.at.get(onset_index, ())
        rank = self.placed_here if onset_index == self.position_index else 0
        degrees = ref.degrees.get(onset_index) or [0.] * 12
        if rank < len(notes):
            group, pitch, duration = notes[rank]
            return group, pitch, duration, degrees
        return REF_GROUP_NONE, PITCH_NONE, len(self.vocab), degrees

    def delta_index(self, position: Fraction) -> int:
        """Inter-onset interval from the previous event in this bar (input only; nearest vocabulary value)."""
        return lookup(self.vocab, position - self.position)[0]

    # ---------------------------------------------------------------- commits (backbone inputs)
    def _base(self, kind: int, position: Fraction, onset: dict | None, delta_index: int, position_index: int) -> dict:
        root, quality = self.chord_relative()
        k, v = len(self.vocab), self.config['voices']
        return {'in_kind': kind, 'in_group': UNKNOWN_GROUP, 'in_pitch': PITCH_NONE, 'in_degree': DEGREE_NONE,
                'in_register': REGISTER_NONE, 'in_drum': 128, 'in_voice': v, 'in_interval': INTERVAL_NONE,
                'in_delta': delta_index, 'in_position': position_index, 'in_duration': k,
                'in_velocity': VELOCITY_UNKNOWN, 'in_dynamic': 0, 'in_accent': 0, 'in_wedge': 0, 'in_beat': onset['beat'] if onset else self.beat_index(position),
                'in_level': onset['level'] if onset else metric_level(position, self.beat), 'in_key': self.key,
                'in_chord_root': root, 'in_chord_quality': quality, 'in_chord_degree': CHORD_DEGREE_NONE,
                'in_cont': self.event_continuous(position), **self.rope(position, onset['now'] if onset else None)}

    def commit_chord(self, root: int, quality: int, onset: dict, position_index: int) -> dict:
        """root: absolute pitch class. The new chord is in effect for this event's input and after."""
        if not self.chord_allowed(onset['position']):
            raise ValueError('a chord change cannot follow an event at the same onset')
        delta = self.delta_index(onset['position'])
        self.chord = (root % 12, quality)
        if onset['position'] != self.position:
            self.placed_here = 0
        self.position, self.position_index = onset['position'], position_index
        self.events += 1
        self.bar_events += 1
        return self._base(KIND_CHORD, onset['position'], onset, delta, position_index)

    def commit_note(self, identity, onset: dict, group: int, slot: int, pitch: int, drum: int | None,
                    position_index: int, duration_index: int, velocity: int | None, dynamic: int, accent: int,
                    wedge: int, interval: int) -> dict:
        """pitch: absolute MIDI pitch, or ABS_UNPITCHED."""
        delta = self.delta_index(onset['position'])
        if slot == len(self.registry):
            self.registry[identity] = slot
            self.slot_group[slot] = group
        elif self.registry.get(identity) != slot:
            raise ValueError('voice slot does not match its identity')
        now = onset['now']
        duration = self.vocab.value(duration_index)
        self.slot_pitch[slot] = pitch
        self.slot_interval[slot] = interval
        self.slot_event[slot] = self.events
        self.slot_onset[slot], self.slot_end[slot] = float(now), float(now + duration)
        if pitch < 128:
            end = now + duration
            heapq.heappush(self.heap, (end.numerator / end.denominator, pitch))
        self.placed_here = self.placed_here + 1 if onset['position'] == self.position else 1
        self.position, self.position_index = onset['position'], position_index
        self.events += 1
        self.bar_events += 1
        row = self._base(KIND_NOTE, onset['position'], onset, delta, position_index)
        row.update({'in_group': group, 'in_pitch': self.relative(pitch), 'in_drum': 128 if drum is None else drum,
                    'in_voice': slot, 'in_interval': interval, 'in_duration': duration_index,
                    'in_velocity': VELOCITY_UNKNOWN if velocity is None else min(15, velocity // 8),
                    'in_dynamic': dynamic, 'in_accent': accent, 'in_wedge': wedge})
        if pitch < 128:
            row['in_degree'] = (pitch - self.tonic) % 12 + 12 * self.mode
            row['in_register'] = pitch // 12
            if self.chord is not None:
                row['in_chord_degree'] = (pitch - self.chord[0]) % 12   # interval above the chord root
        return row

    def commit_end(self) -> dict:
        self.events += 1
        return self._base(KIND_END, self.bar.length, None, len(self.vocab), len(self.vocab))

    def start_input(self, time: Fraction = Fraction(0)) -> dict:
        k, v = len(self.vocab), self.config['voices']
        return {'in_kind': KIND_START, 'in_group': UNKNOWN_GROUP, 'in_pitch': PITCH_NONE, 'in_degree': DEGREE_NONE,
                'in_register': REGISTER_NONE, 'in_drum': 128, 'in_voice': v, 'in_interval': INTERVAL_NONE,
                'in_delta': k, 'in_position': k, 'in_duration': k, 'in_velocity': VELOCITY_UNKNOWN, 'in_dynamic': 0,
                'in_accent': 0,
                'in_wedge': 0, 'in_beat': 0, 'in_level': 0, 'in_key': KEY_NONE, 'in_chord_root': CHORD_ROOT_NONE,
                'in_chord_quality': CHORD_QUALITY_NONE, 'in_chord_degree': CHORD_DEGREE_NONE,
                'in_cont': [0.] * CONTINUOUS_EVENT,
                'rope_time': float(time), 'rope_beat': 0., 'rope_bar': 0.}


# ==================================================================== source events per bar
@dataclass
class SourceNote:
    position: Fraction
    duration_index: int
    group: int
    pitch: int                 # absolute MIDI pitch or ABS_UNPITCHED (already transposed)
    drum: int | None
    identity: tuple
    velocity: int | None
    dynamic: int
    dynamic_known: bool
    accent: int
    wedge: int


def bar_notes(score, bar_index: int, notes, vocab: TimeVocabulary, shift: int, performance: bool,
              velocities: dict, drums: dict, stats: Counter) -> list[SourceNote]:
    """Snap and order the non-grace notes of one bar (onsets are assigned after chords are merged)."""
    measure = score.measures[bar_index]
    length = measure.duration
    raw = [n for n in notes if not n.grace and n.duration > 0]
    clusters = cluster_onsets([n.onset - measure.onset for n in raw]) if performance else None
    staged = []
    for n in raw:
        position = n.onset - measure.onset
        if clusters is not None:
            position = clusters[position]
        snapped = cached_snap(position)
        if snapped is None:
            stats['position-unsnapped'] += 1
            snapped = position
        elif snapped != n.onset - measure.onset:
            stats['position-snapped'] += 1
        if snapped >= length:
            stats['note-beyond-bar'] += 1
            continue
        duration = cached_snap_duration(n.duration, performance)
        if duration is None:
            stats['duration-unsnapped'] += 1
            duration = n.duration
        elif duration != n.duration:
            stats['duration-snapped'] += 1
        duration_index, remapped = lookup(vocab, duration, positive=True)
        stats['duration-remapped'] += remapped
        group = GROUPS.index(n.group) if n.group in GROUPS else UNKNOWN_GROUP
        if n.pitch is None:
            pitch = ABS_UNPITCHED
        else:
            pitch = n.pitch + shift
            if not 0 <= pitch <= 127:
                raise ValueError('transposition leaves the MIDI range')
        # Within an onset: unpitched first, then pitched notes from the lowest up (bass before melody, as in
        # the joint model's B -> M order); chord changes are placed before all of them.
        staged.append((snapped.numerator / snapped.denominator, (0, group) if pitch == ABS_UNPITCHED else (1, pitch),
                       group, n.source_index, SourceNote(
            snapped, duration_index, group, pitch, drums.get(n.source_index) if pitch == ABS_UNPITCHED else None,
            (n.voice_id, group), velocities.get(n.source_index), DYNAMICS.index(n.dynamic) + 1 if n.dynamic in DYNAMICS else 0,
            n.dynamic in DYNAMICS, max(0, min(2, n.accent)), WEDGES.index(n.wedge) + 1 if n.wedge in WEDGES else 0)))
    staged.sort(key=lambda item: item[:4])
    return [item[4] for item in staged]


# ==================================================================== examples
def build_example(score, end_bar: int, vocab: TimeVocabulary, *, source: str, rng: random.Random,
                  velocities=None, drums=None, tempos=None, meter_known=None, analysis=None, labels=None,
                  shift: int = 0, context: int = 512, lead_bars: int = 16, lead_events: int = 384,
                  config: dict = CONFIG, drop_controls: bool = True) -> dict:
    """One training window ending with bar `end_bar` (inclusive).

    analysis: optional {'keys': [key id per bar], 'chords': {bar: [(offset, root, quality), ...]}} for the
    untransposed score (computed by four_pillar_v31_tonal.analyze when omitted; labels = SourceLabels for
    Lieder chords). Returns numpy arrays; `collate` turns a list of examples into a padded batch.
    The stream starts up to `lead_bars` bars (at most `lead_events` events) before the window, so voices, sounding
    notes and the chord are already established when the window begins.
    """
    velocities, drums = velocities or {}, drums or {}
    performance = source not in SCORE_SOURCES
    if not 0 <= end_bar < len(score.measures):
        raise ValueError('end bar outside the score')
    history_first = max(0, end_bar - (config['history_bars'] - 1))
    by_bar: dict[int, list] = {}
    for n in score.events:
        if history_first <= n.bar <= end_bar:
            by_bar.setdefault(n.bar, []).append(n)
    # Walk back from the end bar to find where `context` events begin, then add a lead-in.
    total, first_window_bar = 0, end_bar
    for b in range(end_bar, history_first - 1, -1):
        total += sum(1 for n in by_bar.get(b, ()) if not n.grace) + 1
        first_window_bar = b
        if total >= context:
            break
    stream_first, lead = first_window_bar, 0
    for b in range(first_window_bar - 1, max(history_first, first_window_bar - lead_bars) - 1, -1):
        lead += sum(1 for n in by_bar.get(b, ()) if not n.grace) + 1
        if lead > lead_events:
            break
        stream_first = b
    if analysis is None:
        analysis = analyze(score, source, labels, stream_first, end_bar)
    source_keys = analysis['keys']                    # untransposed: rotates the untransposed bar summaries
    table = analysis.get('table') or NoteTable(score)
    analysis = transpose_analysis(analysis, shift)
    keys, chords = analysis['keys'], analysis['chords']
    stats = Counter()
    # Reference bars (key-relative, so the choice does not depend on the transposition).
    references = choose_references(table, source_keys, history_first, range(stream_first, end_bar + 1))
    bar_cache: dict[int, list] = {}
    contents: dict[int, Reference] = {}

    def reference_of(r: int) -> Reference:
        if r not in contents:
            notes = bar_cache.get(r)
            if notes is None:
                notes = bar_notes(score, r, by_bar.get(r, ()), vocab, shift, performance, velocities, drums, Counter())
            contents[r] = Reference(reference_notes(notes, vocab, score.measures[r].duration, keys[r] % 12))
        return contents[r]

    regrouped: dict = {}
    state = StreamState(vocab, config)
    rows, previous_input = [], state.start_input(score.measures[stream_first].onset)
    bar_info = {}
    for b in range(stream_first, end_bar + 1):
        measure = score.measures[b]
        known = True if meter_known is None else bool(meter_known[b])
        tempo = tempos[b] if tempos is not None and b < len(tempos) else None
        target = references[b]
        used = None if target is None or (drop_controls and rng.random() < CONTROL_DROP['reference']) else target
        bar = BarContext(b, measure.onset, measure.duration, measure.meter, known, tempo, keys[b],
                         keys[b - 1] if b > 0 else None, None if used is None else reference_of(used))
        state.start_bar(bar)
        notes = bar_notes(score, b, by_bar.get(b, ()), vocab, shift, performance, velocities, drums, stats)
        bar_cache[b] = notes
        for n in notes:
            groups_seen = regrouped.setdefault(n.identity[0], set())
            if n.group not in groups_seen:
                stats['voice-regrouped'] += bool(groups_seen)     # the same part in another group: a new voice
                groups_seen.add(n.group)
        changes = [(offset, root, quality) for offset, root, quality in chords.get(b, ()) if offset < measure.duration]
        events = sorted([(offset, 0, i, ('chord', root, quality)) for i, (offset, root, quality) in enumerate(changes)]
                        + [(note.position, 1, i, ('note', note)) for i, note in enumerate(notes)],
                        key=lambda item: (item[0].numerator / item[0].denominator, item[1], item[2]))
        groups_present = sorted({n.group for n in notes})
        unknown_group = UNKNOWN_GROUP in groups_present
        pitched = [n.pitch for n in notes if n.pitch < 128]
        info = {'meter': meter_codes(measure.meter, known), 'cont': state.bar_continuous(), 'key': keys[b],
                'modulation': state.modulation(), 'groups': [float(g in groups_present) for g in range(6)],
                'groups_known': not unknown_group, 'density': density_bucket(len(notes)), 'pcs': None,
                'register': None, 'reference': target, 'reference_used': used}
        if pitched:
            degrees = np.bincount((np.asarray(pitched) - state.tonic) % 12, minlength=12).astype(np.float32)
            info['pcs'] = (degrees / degrees.sum()).tolist()
            info['register'] = register_bucket(float(np.mean(pitched)))
        info['groups_given'] = (not unknown_group) and (not drop_controls or rng.random() >= CONTROL_DROP['groups'])
        info['density_given'] = not drop_controls or rng.random() >= CONTROL_DROP['density']
        source_given = source in SOURCES and (not drop_controls or rng.random() >= CONTROL_DROP['source'])
        info['source'] = SOURCES.index(source) if source_given else SOURCE_NONE
        bar_info[b] = info
        for target, _, _, item in events:
            index, remapped = lookup(vocab, target)
            stats['onset-remapped'] += remapped
            if vocab.value(index) < state.position:  # a remapped onset never moves before the previous event
                index = bisect.bisect_left(vocab.floats, state.position.numerator / state.position.denominator)
                stats['onset-raised'] += 1
            if index >= len(vocab) or vocab.value(index) >= measure.duration:
                stats['event-beyond-bar'] += 1
                continue
            position = vocab.value(index)
            if item[0] == 'chord':
                _, root, quality = item
                if state.chord == (root % 12, quality):
                    continue                         # no change (e.g. the same chord after a bar line)
                if not state.chord_allowed(position):
                    stats['chord-dropped'] += 1      # would follow a note at its own onset
                    continue
                allowed = state.onset_range(measure.duration, strict=state.bar_events > 0)
                look = state.ref_lookahead()
                onset = state.onset(position)
                rows.append({'input': previous_input, 'bar': b, 'kind': KIND_CHORD, 'onset_index': index,
                             'onset_range': (allowed.start, allowed.stop), 'chord_root': (root - state.tonic) % 12,
                             'chord_quality': quality, 'onset': onset, 'look': look,
                             'aligned': state.ref_aligned(index)})
                previous_input = state.commit_chord(root, quality, onset, index)
            else:
                note = item[1]
                allowed = state.onset_range(measure.duration)
                look = state.ref_lookahead()
                onset = state.onset(position)
                slot = state.slot_for(note.identity)
                slot_features = state.slot_features(note.group, onset['now'])
                last_pitch, voice_features = state.voice_features(slot, onset['now'])
                interval = state.interval(last_pitch, note.pitch)
                rows.append({'input': previous_input, 'bar': b, 'kind': KIND_NOTE, 'onset_index': index, 'note': note,
                             'onset_range': (allowed.start, allowed.stop), 'prev_interval': state.voice_interval(slot),
                             'voice': slot, 'pitch': state.relative(note.pitch), 'onset': onset,
                             'slot': slot_features, 'last_pitch': last_pitch, 'last_rel': state.relative(last_pitch),
                             'voice_features': voice_features, 'interval': interval, 'look': look,
                             'aligned': state.ref_aligned(index)})
                previous_input = state.commit_note(note.identity, onset, note.group, slot, note.pitch, note.drum,
                                                   index, note.duration_index, note.velocity, note.dynamic,
                                                   note.accent, note.wedge, interval)
        rows.append({'input': previous_input, 'bar': b, 'kind': KIND_END, 'look': state.ref_lookahead()})
        previous_input = state.commit_end()
    stats['chord-events'] += sum(1 for r in rows if r['kind'] == KIND_CHORD)
    rows = rows[-context:]
    window_bars = sorted({r['bar'] for r in rows})
    bar_slot = {b: i for i, b in enumerate(window_bars)}
    summaries = table.summaries(history_first, end_bar)
    profiles = table.profiles(history_first, end_bar, source_keys)
    history = np.asarray([bar_vector(summaries[h - history_first], source_keys[h], source_keys[h - 1] if h > 0 else None,
                                     profiles[h - history_first], h) for h in range(history_first, end_bar)],
                         dtype=np.float32).reshape(-1, config['summary_dim'])
    if shift and len(history):
        pitched_bars = history[:, :12].sum(1) > 0
        history[pitched_bars, 19] += shift / 127.
    return _arrays(rows, window_bars, bar_slot, bar_info, history, history_first, source, len(vocab), config, stats)


def _arrays(rows, window_bars, bar_slot, bar_info, history, history_first, source, k, config, stats) -> dict:
    t, nb, v = len(rows), len(window_bars), config['voices']
    score_source = source in SCORE_SOURCES
    a = {name: np.zeros(t, dtype=np.int64) for name in (
        'in_kind', 'in_group', 'in_pitch', 'in_degree', 'in_register', 'in_drum', 'in_voice', 'in_interval',
        'in_delta', 'in_position', 'in_duration', 'in_velocity', 'in_dynamic', 'in_accent', 'in_wedge', 'in_beat', 'in_level',
        'in_key', 'in_chord_root', 'in_chord_quality', 'in_chord_degree', 'bar_of_event', 'tg_kind', 'tg_onset',
        'at_onset_lo', 'at_onset_hi', 'vs_prev_interval', 'tg_chord_root',
        'tg_chord_quality', 'tg_group', 'tg_group_in', 'tg_voice', 'tg_pitch', 'tg_duration', 'tg_velocity',
        'tg_dynamic', 'tg_accent', 'tg_wedge', 'tg_drum', 'tg_interval', 'at_beat', 'at_level', 'vs_last_abs',
        'vs_last_rel', 'bass_rel', 'chord_root', 'chord_quality', 'tonic_ref', 'mode', 'rf_next', 'rf_here',
        'rf_remain', 'rf_group', 'rf_pitch', 'rf_duration')}
    a['in_cont'] = np.zeros((t, CONTINUOUS_EVENT), dtype=np.float32)
    a['rf_pcs'] = np.zeros((t, 12), dtype=np.float32)
    a['rope_time'] = np.zeros(t, dtype=np.float64)
    a['rope_beat'] = np.zeros(t, dtype=np.float64)
    a['rope_bar'] = np.zeros(t, dtype=np.float64)
    a['at_cont'] = np.zeros((t, CONTINUOUS_ONSET), dtype=np.float32)
    a['slot_feat'] = np.zeros((t, v, SLOT_FEATURES), dtype=np.float32)
    a['vs_feat'] = np.zeros((t, VOICE_FEATURES), dtype=np.float32)
    a['harm_feat'] = np.zeros((t, HARMONY_FEATURES), dtype=np.float32)
    a['harm_pcs'] = np.zeros((t, 12), dtype=np.float32)
    a['chord_tones'] = np.zeros((t, 12), dtype=np.float32)
    for name in ('kind', 'onset', 'chord_root', 'chord_quality', 'group', 'voice', 'pitch', 'duration', 'velocity',
                 'dynamic', 'accent', 'wedge', 'drum'):
        a['kn_' + name] = np.zeros(t, dtype=bool)
    origin = rows[0]['input']['rope_time'] if rows else 0.
    for i, r in enumerate(rows):
        for key, value in r['input'].items():
            a[key][i] = value
        a['rope_time'][i] -= origin            # rotary attention only sees time differences
        a['bar_of_event'][i] = bar_slot[r['bar']]
        a['tg_kind'][i], a['kn_kind'][i] = r['kind'], True
        a['tg_group_in'][i], a['tg_interval'][i], a['tg_pitch'][i] = UNKNOWN_GROUP, INTERVAL_NONE, PITCH_NONE
        a['vs_prev_interval'][i] = INTERVAL_NONE
        a['vs_last_abs'][i], a['vs_last_rel'][i], a['bass_rel'][i] = ABS_NONE, PITCH_NONE, CHORD_ROOT_NONE
        a['chord_root'][i], a['chord_quality'][i], a['tonic_ref'][i] = CHORD_ROOT_NONE, CHORD_QUALITY_NONE, 60
        a['rf_next'][i], a['rf_here'][i], a['rf_remain'][i] = r['look']
        a['rf_group'][i], a['rf_pitch'][i], a['rf_duration'][i] = REF_GROUP_NONE, PITCH_NONE, k
        if r['kind'] == KIND_END:
            continue
        a['rf_group'][i], a['rf_pitch'][i], a['rf_duration'][i], a['rf_pcs'][i] = r['aligned']
        onset = r['onset']
        a['tg_onset'][i], a['kn_onset'][i] = r['onset_index'], True
        a['at_onset_lo'][i], a['at_onset_hi'][i] = r['onset_range']
        a['at_beat'][i], a['at_level'][i], a['at_cont'][i] = onset['beat'], onset['level'], onset['cont']
        if r['kind'] == KIND_CHORD:
            a['tg_chord_root'][i], a['kn_chord_root'][i] = r['chord_root'], True
            a['tg_chord_quality'][i], a['kn_chord_quality'][i] = r['chord_quality'], True
            continue
        note = r['note']
        a['tg_group_in'][i] = note.group
        if note.group != UNKNOWN_GROUP:
            a['tg_group'][i], a['kn_group'][i] = note.group, True
        a['tg_voice'][i], a['kn_voice'][i] = r['voice'], True
        a['tg_pitch'][i], a['kn_pitch'][i] = r['pitch'], True
        a['tg_duration'][i], a['kn_duration'][i] = note.duration_index, True
        if note.velocity is not None:
            a['tg_velocity'][i], a['kn_velocity'][i] = note.velocity, True
        if score_source:
            a['tg_accent'][i], a['kn_accent'][i] = note.accent, True
            a['tg_wedge'][i], a['kn_wedge'][i] = note.wedge, True
        if note.dynamic_known:
            a['tg_dynamic'][i], a['kn_dynamic'][i] = note.dynamic, True
        if note.drum is not None:
            a['tg_drum'][i], a['kn_drum'][i] = note.drum, True
        a['slot_feat'][i] = r['slot']
        a['vs_last_abs'][i], a['vs_last_rel'][i], a['vs_feat'][i] = r['last_pitch'], r['last_rel'], r['voice_features']
        a['vs_prev_interval'][i] = r['prev_interval']
        a['harm_feat'][i], a['harm_pcs'][i], a['bass_rel'][i] = onset['harm'], onset['pcs'], onset['bass']
        a['chord_root'][i], a['chord_quality'][i] = onset['chord_root'], onset['chord_quality']
        a['chord_tones'][i], a['tonic_ref'][i], a['mode'][i] = onset['chord_tones'], onset['tonic_ref'], onset['mode']
        a['tg_interval'][i] = r['interval']
    bars = {name: np.zeros(nb, dtype=np.int64) for name in (
        'bar_plan_index', 'ctrl_meter_num', 'ctrl_meter_den', 'ctrl_density', 'ctrl_key', 'ctrl_modulation',
        'ctrl_source', 'bt_bar_key', 'bt_bar_density', 'bt_bar_register', 'bt_bar_ref')}
    bars['ctrl_groups'] = np.zeros((nb, 7), dtype=np.float32)
    bars['ctrl_cont'] = np.zeros((nb, CONTINUOUS_BAR), dtype=np.float32)
    bars['bt_bar_pcs'] = np.zeros((nb, 12), dtype=np.float32)
    bars['bt_bar_groups'] = np.zeros((nb, 6), dtype=np.float32)
    for name in ('kn_bar_key', 'kn_bar_density', 'kn_bar_register', 'kn_bar_pcs', 'kn_bar_ref'):
        bars[name] = np.zeros(nb, dtype=bool)
    bars['kn_bar_groups'] = np.zeros((nb, 6), dtype=bool)
    for j, b in enumerate(window_bars):
        info = bar_info[b]
        bars['bar_plan_index'][j] = b - 1 - history_first if b - 1 >= history_first else -1
        # pointer target: 0 = no reference, 1 + h = history bar h (the decoder may have had it dropped)
        bars['bt_bar_ref'][j] = 0 if info['reference'] is None else 1 + info['reference'] - history_first
        bars['kn_bar_ref'][j] = bars['bar_plan_index'][j] >= 0
        bars['ctrl_meter_num'][j], bars['ctrl_meter_den'][j] = info['meter']
        bars['ctrl_cont'][j] = info['cont']
        bars['ctrl_key'][j], bars['ctrl_modulation'][j] = info['key'], info['modulation']
        bars['ctrl_source'][j] = info['source']
        if info['modulation'] != MODULATION_NONE:
            bars['bt_bar_key'][j], bars['kn_bar_key'][j] = info['modulation'], True
        if info['groups_given']:
            bars['ctrl_groups'][j] = info['groups'] + [1.]
        bars['ctrl_density'][j] = info['density'] if info['density_given'] else DENSITY_BUCKETS
        bars['bt_bar_density'][j], bars['kn_bar_density'][j] = info['density'], True
        if info['pcs'] is not None:
            bars['bt_bar_pcs'][j], bars['kn_bar_pcs'][j] = info['pcs'], True
            bars['bt_bar_register'][j], bars['kn_bar_register'][j] = info['register'], True
        if info['groups_known']:
            bars['bt_bar_groups'][j], bars['kn_bar_groups'][j] = info['groups'], True
    a.update(bars)
    a['history'] = np.asarray(history, dtype=np.float32).reshape(-1, config['summary_dim'])
    a['stats'] = dict(stats)
    a['references'] = {b: bar_info[b]['reference_used'] for b in window_bars}        # what the decoder read
    a['reference_targets'] = {b: bar_info[b]['reference'] for b in window_bars}      # what the pointer learns
    return a


PAD_EVENT = {'in_kind': KIND_START, 'in_group': UNKNOWN_GROUP, 'in_pitch': PITCH_NONE, 'in_degree': DEGREE_NONE,
             'in_register': REGISTER_NONE, 'in_drum': 128, 'in_interval': INTERVAL_NONE,
             'in_velocity': VELOCITY_UNKNOWN, 'in_key': KEY_NONE, 'in_chord_root': CHORD_ROOT_NONE,
             'in_chord_quality': CHORD_QUALITY_NONE, 'in_chord_degree': CHORD_DEGREE_NONE, 'tg_group_in': UNKNOWN_GROUP,
             'tg_pitch': PITCH_NONE, 'vs_prev_interval': INTERVAL_NONE,
             'vs_last_abs': ABS_NONE, 'vs_last_rel': PITCH_NONE, 'bass_rel': CHORD_ROOT_NONE,
             'chord_root': CHORD_ROOT_NONE, 'chord_quality': CHORD_QUALITY_NONE, 'tg_interval': INTERVAL_NONE,
             'tonic_ref': 60, 'rf_remain': REF_COUNT_NONE, 'rf_group': REF_GROUP_NONE, 'rf_pitch': PITCH_NONE}
BAR_PAD = {'bar_plan_index': -1, 'ctrl_key': KEY_NONE, 'ctrl_modulation': MODULATION_NONE, 'ctrl_source': SOURCE_NONE}
BAR_FIELDS = ('bar_plan_index', 'ctrl_meter_num', 'ctrl_meter_den', 'ctrl_density', 'ctrl_key', 'ctrl_modulation',
              'ctrl_source',
              'bt_bar_key', 'bt_bar_density', 'bt_bar_register', 'ctrl_groups', 'ctrl_cont', 'bt_bar_pcs',
              'bt_bar_groups', 'kn_bar_key', 'kn_bar_density', 'kn_bar_register', 'kn_bar_pcs', 'kn_bar_groups',
              'bt_bar_ref', 'kn_bar_ref')


def collate(examples: list[dict], vocab_size: int, config: dict = CONFIG) -> dict:
    """Right-pad events, bars and history; padded positions carry no known targets."""
    t = max(len(e['in_kind']) for e in examples)
    nb = max(len(e['bar_plan_index']) for e in examples)
    h = max(len(e['history']) for e in examples)
    pad = dict(PAD_EVENT, in_voice=config['voices'], in_delta=vocab_size, in_position=vocab_size,
               in_duration=vocab_size, rf_next=vocab_size, rf_here=vocab_size, rf_duration=vocab_size)
    batch = {}
    for name, value in examples[0].items():
        if name == 'history' or not isinstance(value, np.ndarray):
            continue   # history is padded below; stats and source labels are not tensors
        rows = []
        for e in examples:
            x = e[name]
            length = nb if name in BAR_FIELDS else t
            fill = BAR_PAD.get(name, 0) if name in BAR_FIELDS else pad.get(name, 0)
            padded = np.full((length,) + x.shape[1:], fill, dtype=x.dtype)
            padded[:len(x)] = x
            rows.append(padded)
        batch[name] = torch.from_numpy(np.stack(rows))
    history = np.zeros((len(examples), h, config['summary_dim']), dtype=np.float32)
    for i, e in enumerate(examples):
        history[i, :len(e['history'])] = e['history']
    batch['history'] = torch.from_numpy(history)
    return batch
