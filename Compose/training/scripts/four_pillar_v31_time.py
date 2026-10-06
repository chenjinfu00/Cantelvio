"""Musical time values for the four-pillar v3.1 composer (pure Python, no torch).

Score sources carry exact notated values, including tuplets; they are kept
unchanged whenever their reduced denominator is one of PREFERRED, otherwise
they snap to the simplest PREFERRED fraction within TOLERANCE of a quarter.

MIDI times are exact tick fractions with export and performance artifacts:
durations a few ticks short of the grid (239/480 = 1/2 - 1/480, 127/32 = 4 - 1/32)
and chord notes spread by a few ticks. For MIDI sources only:
  * onsets within CHORD_WINDOW of a cluster's first onset join that onset;
  * a duration within max(TOLERANCE, value * DURATION_RELATIVE) of a simple
    value (denominator in SIMPLE) becomes that value; blips shorter than
    SHORTEST become SHORTEST;
  * everything else follows the score rule. Genuine tuplets (1/5, 1/6, 1/7 ...)
    are exact and stay. Values that no rule explains stay and are counted; the
    training vocabulary then maps them to the nearest listed value.

One shared vocabulary of exact fractions serves onset deltas, bar positions and
durations. It is frozen in a JSON file whose SHA-256 enters every run manifest.
"""
from __future__ import annotations

import bisect
import json
import math
from fractions import Fraction
from pathlib import Path

PREFERRED = (1, 2, 4, 3, 8, 6, 16, 12, 32, 24, 48, 5, 10, 20, 40, 7, 14, 28, 56, 9, 18, 36)
TOLERANCE = Fraction(1, 96)
SIMPLE = (1, 2, 4, 3, 8, 6, 16, 12)
SHORTEST = Fraction(1, 48)
CHORD_WINDOW = Fraction(1, 40)
DURATION_RELATIVE = Fraction(1, 50)
VOCAB_SCHEMA = 'four-pillar-v31-time-vocab-1'
DEFAULT_VOCAB = Path(__file__).resolve().parents[1] / 'data/four-pillar-v31-time-vocab.json'
_PREFERRED_SET = frozenset(PREFERRED)


def snap(value, positive: bool = False) -> Fraction | None:
    """Exact notation values stay; otherwise the simplest fraction within TOLERANCE.

    `positive` forbids zero (durations). Returns None when no preferred fraction
    lies within tolerance; callers keep such values and count them.
    """
    value = Fraction(value)
    if value < 0:
        raise ValueError('negative musical time')
    if value.denominator in _PREFERRED_SET and (value > 0 or not positive):
        return value
    for denominator in PREFERRED:
        numerator = round(value * denominator)
        if positive and numerator == 0:
            continue
        candidate = Fraction(numerator, denominator)
        if abs(candidate - value) <= TOLERANCE:
            return candidate
    return None


def snap_duration(value, performance: bool = False) -> Fraction | None:
    """Positive duration; `performance` (MIDI) also removes near-grid articulation artifacts."""
    value = Fraction(value)
    if value <= 0:
        raise ValueError('duration must be positive')
    if performance:
        limit = max(TOLERANCE, value * DURATION_RELATIVE)
        best = None
        for denominator in SIMPLE:
            numerator = max(1, round(value * denominator))
            candidate = Fraction(numerator, denominator)
            error = abs(candidate - value)
            if error <= limit and (best is None or error < best[0]):
                best = (error, candidate)
        if best is not None:
            return best[1]
        if value < SHORTEST:
            return SHORTEST   # a few-tick MIDI blip: the shortest standard value
    return snap(value, positive=True)


def cluster_onsets(onsets) -> dict:
    """MIDI chord spreading: map each onset to its cluster's first onset (sorted input not required)."""
    mapping, start = {}, None
    for value in sorted(set(Fraction(v) for v in onsets)):
        if start is None or value - start > CHORD_WINDOW:
            start = value
        mapping[value] = start
    return mapping


def rule() -> dict:
    return {'preferredDenominators': list(PREFERRED), 'toleranceQuarter': str(TOLERANCE),
            'simpleDenominators': list(SIMPLE), 'chordWindowQuarter': str(CHORD_WINDOW),
            'durationRelative': str(DURATION_RELATIVE), 'shortestPerformanceDuration': str(SHORTEST),
            'exactFirst': True}


class TimeVocabulary:
    """Frozen list of exact fractions; exact lookup plus nearest-value mapping."""

    def __init__(self, values):
        values = sorted({Fraction(v) for v in values})
        if not values or values[0] != 0:
            raise ValueError('time vocabulary must contain zero (simultaneous onsets)')
        self.values = tuple(values)
        self.index = {v: i for i, v in enumerate(self.values)}
        self.floats = [float(v) for v in self.values]
        self.positive_floats = self.floats[1:]

    def __len__(self) -> int:
        return len(self.values)

    @classmethod
    def load(cls, path: Path = DEFAULT_VOCAB) -> 'TimeVocabulary':
        data = json.loads(Path(path).read_text())
        if data.get('schema') != VOCAB_SCHEMA:
            raise ValueError('unexpected time vocabulary schema')
        built = {k: v for k, v in data['rule'].items() if k in rule()}
        if built != rule():
            raise ValueError('time vocabulary was built with a different snapping rule')
        return cls(data['values'])

    def lookup(self, value, positive: bool = False) -> tuple[int, bool]:
        """Index of `value` (exact if listed) and whether it was remapped.

        Durations (positive=True) use log-ratio distance and never map to zero;
        onset deltas use absolute distance.
        """
        value = Fraction(value)
        exact = self.index.get(value)
        if exact is not None and (exact > 0 or not positive):
            return exact, False
        x = float(value)
        if positive:
            if x <= 0:
                return 1, True
            table, offset = self.positive_floats, 1
            j = bisect.bisect_left(table, x)
            candidates = [k for k in (j - 1, j) if 0 <= k < len(table)]
            best = min(candidates, key=lambda k: abs(math.log(table[k] / x)))
            return best + offset, True
        j = bisect.bisect_left(self.floats, x)
        candidates = [k for k in (j - 1, j) if 0 <= k < len(self.floats)]
        return min(candidates, key=lambda k: abs(self.floats[k] - x)), True

    def value(self, index: int) -> Fraction:
        return self.values[index]
