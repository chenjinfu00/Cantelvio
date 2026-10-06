"""Keys, chords and key-relative pitch for the four-pillar v3.1 composer (numpy only, deterministic).

Every pitch the v3.1 model reads or writes is relative to the local key of its bar:

    relative index  i = pitch - tonic_ref(tonic) + REL_OFFSET,   0 <= i < REL_PITCHES
    pitch           = i - REL_OFFSET + tonic_ref(tonic)          (exact inverse)

tonic_ref places the tonic in MIDI 54..65 (F#3..F4), so the same melody in any
key has the same codes up to an octave, and the sounding pitch is recovered
exactly; nothing is folded, clamped or replaced.

Labels (estimates, not ground truth; versioned with this file's SHA-256):
  * Keys for every source come from KeyTracker: duration-weighted pitch-class
    histograms per bar (lowest note of each onset weighted 1.5x), multinomial
    log-likelihood under 24 key profiles estimated from the Lieder corpus with
    its AugmentedNet local keys, a small bonus for keys matching a notated key
    signature, and Viterbi smoothing with a change cost growing with distance
    on the circle of fifths. On 187 held-out Lieder it agrees with AugmentedNet
    on 78.6% of bars (82.9% same key signature); it changes key about every 20
    bars where AugmentedNet marks a tonicization every 7 bars.
  * Chords for Lieder come from the aligned AugmentedNet labels; other sources
    use ChordTracker: beat segments, template matching over the nine qualities
    that cover 99.8% of the Lieder labels, bass and diatonic priors in the
    tracked key, and Viterbi smoothing (see CHORD_PARAMS for agreement).
"""
from __future__ import annotations

import json
import math
from fractions import Fraction
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
QUALITIES = json.loads((ROOT / 'data/chord-qualities.json').read_text())
QUALITY_INDEX = {q['id']: i for i, q in enumerate(QUALITIES)}

# ---------------------------------------------------------------- key-relative pitch
REL_OFFSET = 65
REL_PITCHES = 139                  # relative indices 0..138 cover MIDI 0..127 for every tonic
TONIC_LOW = 54                     # tonic_ref is in 54..65


def tonic_ref(tonic: int) -> int:
    return TONIC_LOW + (int(tonic) - 6) % 12


def relative_index(pitch: int, tonic: int) -> int:
    index = int(pitch) - tonic_ref(tonic) + REL_OFFSET
    if not 0 <= index < REL_PITCHES:
        raise ValueError('pitch outside the relative range')
    return index


def absolute_pitch(index: int, tonic: int) -> int:
    return int(index) - REL_OFFSET + tonic_ref(tonic)


def valid_relative_range(tonic: int) -> range:
    """Relative indices whose sounding pitch lies in MIDI 0..127."""
    low = REL_OFFSET - tonic_ref(tonic)
    return range(low, low + 128)


def degree_of_index(index: int) -> int:
    return (int(index) - REL_OFFSET) % 12


def key_id(tonic: int, mode: int) -> int:
    return int(tonic) % 12 + 12 * int(mode)


def key_parts(key: int) -> tuple[int, int]:
    return key % 12, key // 12


def key_change_class(previous: int, key: int) -> int:
    """New key relative to the previous tonic: (tonic step mod 12) + 12 * new mode."""
    return (key % 12 - previous % 12) % 12 + 12 * (key // 12)


def apply_key_change(previous: int, change: int) -> int:
    return key_id(previous % 12 + change % 12, change // 12)


# ---------------------------------------------------------------- key tracking
# Duration-weighted scale-degree distributions of Lieder bars under their
# AugmentedNet keys (750 tuning pieces, 2026-10-01); 0 = tonic.
MAJOR_PROFILE = (0.20797, 0.00906, 0.09875, 0.01340, 0.14079, 0.09303, 0.01613, 0.23257, 0.01987, 0.08270, 0.01324,
                 0.07249)
MINOR_PROFILE = (0.20535, 0.01336, 0.10474, 0.12924, 0.01406, 0.08880, 0.02120, 0.23829, 0.07289, 0.02020, 0.03660,
                 0.05528)
KEY_PARAMS = {'evidence': 8., 'change': 8., 'fifthsDistance': 1., 'signature': .5, 'bassWeight': .5, 'floor': 1e-3}


def _log_profiles() -> np.ndarray:
    rows = []
    for profile in (MAJOR_PROFILE, MINOR_PROFILE):
        p = np.asarray(profile, dtype=np.float64)
        p = np.maximum(p / p.sum(), KEY_PARAMS['floor'])
        p = p / p.sum()
        rows.extend(np.log(np.roll(p, tonic)) for tonic in range(12))
    return np.asarray(rows)          # [24 keys, 12 pitch classes]


def _fifths_position(key: int) -> int:
    tonic, mode = key_parts(key)
    major = (tonic + 3) % 12 if mode else tonic
    return (7 * major) % 12


LOG_PROFILES = _log_profiles()
_FIFTHS = np.array([_fifths_position(k) for k in range(24)])
_DISTANCE = np.minimum(np.abs(_FIFTHS[:, None] - _FIFTHS[None, :]), 12 - np.abs(_FIFTHS[:, None] - _FIFTHS[None, :]))
KEY_TRANSITION = -(KEY_PARAMS['change'] + KEY_PARAMS['fifthsDistance'] * _DISTANCE)
np.fill_diagonal(KEY_TRANSITION, 0.)


def _viterbi(emission: np.ndarray, transition: np.ndarray) -> list[int]:
    n, states = emission.shape
    score, back = emission[0].copy(), np.zeros((n, states), dtype=np.int64)
    for i in range(1, n):
        candidates = score[:, None] + transition
        back[i] = candidates.argmax(0)
        score = candidates.max(0) + emission[i]
    path = [int(score.argmax())]
    for i in range(n - 1, 0, -1):
        path.append(int(back[i, path[-1]]))
    return path[::-1]


GROUP_INDEX = {g: i for i, g in enumerate(('woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings'))}


def _float(value) -> float:
    return value.numerator / value.denominator


class NoteTable:
    """NumPy view of a score's notes for analysis (floats only here; events keep exact fractions)."""

    def __init__(self, score):
        events, n = score.events, len(score.events)
        self.bars = len(score.measures)
        self.bar = np.fromiter((e.bar for e in events), np.int64, n)
        self.pitch = np.fromiter((-1 if e.pitch is None else e.pitch for e in events), np.int64, n)
        self.onset = np.fromiter((_float(e.onset) for e in events), np.float64, n)
        self.duration = np.fromiter((_float(e.duration) for e in events), np.float64, n)
        self.grace = np.fromiter((e.grace for e in events), bool, n)
        self.group = np.fromiter((GROUP_INDEX.get(e.group, -1) for e in events), np.int64, n)
        self.bar_onset = np.fromiter((_float(m.onset) for m in score.measures), np.float64, self.bars)
        self.bar_length = np.fromiter((_float(m.duration) for m in score.measures), np.float64, self.bars)
        self.sounding = (self.pitch >= 0) & ~self.grace & (self.duration > 0)

    def profiles(self, first: int, last: int, keys) -> np.ndarray:
        return _profiles(self, first, last, keys)

    def summaries(self, first: int, last: int) -> np.ndarray:
        """four_pillar_trial_data.summarize_bars rows for bars first..last-1 (same 20 values)."""
        rows = np.zeros((max(0, last - first), 20), dtype=np.float64)
        if last <= first:
            return rows.astype(np.float32)
        inside = (self.bar >= first) & (self.bar < last)
        bar = self.bar[inside] - first
        pitch, group = self.pitch[inside], self.group[inside]
        count = np.bincount(bar, minlength=last - first).astype(np.float64)
        pitched = pitch >= 0
        np.add.at(rows, (bar[pitched], pitch[pitched] % 12), 1.)
        np.add.at(rows[:, 19], bar[pitched], pitch[pitched] / 127)
        grouped = group >= 0
        np.add.at(rows, (bar[grouped], 12 + group[grouped]), 1.)
        n_pitched = np.bincount(bar[pitched], minlength=last - first).astype(np.float64)
        n_grouped = np.bincount(bar[grouped], minlength=last - first).astype(np.float64)
        has = n_pitched > 0
        rows[has, :12] /= n_pitched[has, None]
        rows[has, 19] /= n_pitched[has]
        has = n_grouped > 0
        rows[has, 12:18] /= n_grouped[has, None]
        rows[:, 18] = np.log1p(count) / np.log(129)
        return rows.astype(np.float32)


PROFILE_DIM = 40          # 16 rhythm bins + 12 top-voice degrees + 12 bass degrees


def profile_bin(position: float, length: float) -> int:
    """Sixteenth-of-the-bar bin of a position, on a 1/96-quarter grid (identical for scores, MIDI and output)."""
    position = round(position * 96) / 96
    return min(15, max(0, math.floor(16 * position / length + 1e-9))) if length > 0 else 0


def _profiles(table: 'NoteTable', first: int, last: int, keys) -> np.ndarray:
    """Per bar first..last-1: onset rhythm over 16 bins, scale degrees of the highest and of the lowest pitch
    of each onset (in the bar's key); each part normalized to sum 1 when present."""
    n = max(0, last - first)
    out = np.zeros((n, PROFILE_DIM))
    keep = ~table.grace & (table.duration > 0) & (table.bar >= first) & (table.bar < last)
    bar, onset, pitch = table.bar[keep], table.onset[keep], table.pitch[keep]
    if not len(bar):
        return out
    order = np.lexsort((pitch, onset, bar))
    bar, onset, pitch = bar[order], onset[order], pitch[order]
    first_of = np.ones(len(bar), dtype=bool)
    first_of[1:] = (bar[1:] != bar[:-1]) | (onset[1:] != onset[:-1])
    starts = np.flatnonzero(first_of)
    g_bar = bar[starts]
    rel = g_bar - first
    positions = onset[starts] - table.bar_onset[g_bar]
    bins = np.array([profile_bin(float(x), float(length)) for x, length in zip(positions, table.bar_length[g_bar])],
                    dtype=np.int64)
    np.add.at(out, (rel, bins), 1.)
    top = np.maximum.reduceat(pitch, starts)
    low = np.minimum.reduceat(np.where(pitch >= 0, pitch, 999), starts)
    tonic = np.asarray([keys[b] % 12 for b in g_bar], dtype=np.int64)
    has = top >= 0
    np.add.at(out, (rel[has], 16 + (top[has] - tonic[has]) % 12), 1.)
    np.add.at(out, (rel[has], 28 + (low[has] - tonic[has]) % 12), 1.)
    onsets = np.bincount(rel, minlength=n).astype(np.float64)
    pitched = np.bincount(rel[has], minlength=n).astype(np.float64)
    out[onsets > 0, :16] /= onsets[onsets > 0, None]
    out[pitched > 0, 16:] /= pitched[pitched > 0, None]
    return out


def bar_histograms(table: NoteTable) -> np.ndarray:
    """Duration in bar (quarters) per pitch class; the lowest note of each onset counts 1.5x."""
    histogram = np.zeros((table.bars, 12))
    keep = table.sounding
    bar, onset, pitch = table.bar[keep], table.onset[keep], table.pitch[keep]
    if not len(bar):
        return histogram
    weight = np.minimum(table.duration[keep], table.bar_onset[bar] + table.bar_length[bar] - onset)
    order = np.lexsort((pitch, onset, bar))
    first = np.ones(len(order), dtype=bool)
    first[1:] = (bar[order][1:] != bar[order][:-1]) | (onset[order][1:] != onset[order][:-1])
    # every note sharing the lowest pitch of its onset gets the bass weight
    low_pitch = np.empty(len(order), dtype=np.int64)
    group_id = np.cumsum(first) - 1
    low_pitch[order] = pitch[order][first][group_id]
    weight = weight * np.where(pitch == low_pitch, 1 + KEY_PARAMS['bassWeight'], 1.)
    np.add.at(histogram, (bar, pitch % 12), weight)
    return histogram


def track_keys(score, table: NoteTable | None = None) -> list[int]:
    """Local key id (tonic + 12 * minor) for every bar of the piece."""
    table = NoteTable(score) if table is None else table
    histogram = bar_histograms(table)
    total = histogram.sum(1, keepdims=True)
    shares = np.divide(histogram, total, out=np.zeros_like(histogram), where=total > 0)
    emission = KEY_PARAMS['evidence'] * shares @ LOG_PROFILES.T
    for bar, measure in enumerate(score.measures):
        signature = getattr(measure, 'key', None)
        fifths = signature.get('fifths') if isinstance(signature, dict) else None
        if fifths is not None:
            major = (7 * int(fifths)) % 12
            emission[bar, major] += KEY_PARAMS['signature']
            emission[bar, (major + 9) % 12 + 12] += KEY_PARAMS['signature']
    return _viterbi(emission, KEY_TRANSITION) if len(emission) else []


# ---------------------------------------------------------------- chord tracking
CORE_QUALITIES = ('maj', 'min', 'dim', 'aug', 'dom7', 'maj7', 'min7', 'dim7', 'half')
CHORD_PARAMS = {'outside': 2., 'bassRoot': .1, 'bassTone': 0., 'seventh': .3, 'change': .3, 'weakBeatChange': .2,
                'diatonic': .1}
_STATES = [(root, QUALITY_INDEX[q]) for q in CORE_QUALITIES for root in range(12)]
_TEMPLATES = np.zeros((len(_STATES), 12))
for _s, (_root, _quality) in enumerate(_STATES):
    for _interval in QUALITIES[_quality]['intervals']:
        _TEMPLATES[_s, (_root + _interval) % 12] = 1.
_SEVENTH = np.array([QUALITIES[q]['id'] in ('dom7', 'maj7', 'min7', 'dim7', 'half') for _, q in _STATES], dtype=float)
_IS_ROOT = np.array([[float(r == pc) for r, _ in _STATES] for pc in range(12)])
_IS_TONE = np.array([[_TEMPLATES[s, pc] * float(r != pc) for s, (r, _) in enumerate(_STATES)] for pc in range(12)])
_MAJOR_DIATONIC = {(0, 'maj'), (2, 'min'), (4, 'min'), (5, 'maj'), (7, 'maj'), (9, 'min'), (11, 'dim'), (7, 'dom7'),
                   (2, 'min7'), (11, 'half'), (5, 'maj7'), (0, 'maj7'), (9, 'min7'), (4, 'min7'), (11, 'dim7')}
_MINOR_DIATONIC = {(0, 'min'), (2, 'dim'), (3, 'maj'), (5, 'min'), (7, 'maj'), (8, 'maj'), (10, 'maj'), (11, 'dim'),
                   (7, 'dom7'), (11, 'dim7'), (2, 'half'), (5, 'min7'), (8, 'maj7'), (3, 'maj7'), (0, 'min7')}
_DIATONIC = np.array([[float(((r - k % 12) % 12, QUALITIES[q]['id']) in (_MINOR_DIATONIC if k >= 12 else _MAJOR_DIATONIC))
                       for r, q in _STATES] for k in range(24)])


def beat_length(meter) -> Fraction:
    """Felt beat: dotted quarter in 6/8, 9/8, 12/8; eighth in other x/8; half in x/2."""
    if not meter:
        return Fraction(1)
    numerator, denominator = int(meter[0]), int(meter[1])
    if denominator == 8:
        return Fraction(3, 2) if numerator % 3 == 0 and numerator > 3 else Fraction(1, 2)
    if denominator == 16:
        return Fraction(3, 4) if numerator % 3 == 0 and numerator > 3 else Fraction(1, 4)
    return Fraction(4, max(1, denominator))


def beat_segments(score, first: int, last: int) -> list[tuple[int, Fraction, Fraction, int]]:
    """(bar, offset, length, beat index) for every beat of bars first..last."""
    out = []
    for bar in range(first, last + 1):
        measure = score.measures[bar]
        step, offset, index = beat_length(measure.meter), Fraction(0), 0
        while offset < measure.duration:
            out.append((bar, offset, min(step, measure.duration - offset), index))
            offset += step
            index += 1
    return out


def track_chords(score, keys: list[int], first: int, last: int,
                 table: NoteTable | None = None) -> dict[int, list[tuple[Fraction, int, int]]]:
    """Chord changes (offset, root, quality) per bar for bars first..last; the first entry holds the chord in effect."""
    segments = beat_segments(score, first, last)
    if not segments:
        return {}
    table = NoteTable(score) if table is None else table
    starts = np.array([table.bar_onset[b] + _float(x) for b, x, _, _ in segments])
    ends = starts + np.array([_float(length) for _, _, length, _ in segments])
    weights = np.zeros((len(segments), 12))
    lowest = np.full(len(segments), 999)
    a = table.onset[table.sounding]
    e = a + table.duration[table.sounding]
    pitch = table.pitch[table.sounding]
    near = (e > starts[0]) & (a < ends[-1])
    a, e, pitch = a[near], e[near], pitch[near]
    i0 = np.searchsorted(ends, a, 'right')
    i1 = np.searchsorted(starts, e, 'left')
    spans = np.maximum(i1 - i0, 0)
    note = np.repeat(np.arange(len(a)), spans)
    segment = np.repeat(i0, spans) + (np.arange(spans.sum()) - np.repeat(np.cumsum(spans) - spans, spans))
    overlap = np.minimum(e[note], ends[segment]) - np.maximum(a[note], starts[segment])
    keep = overlap > 0
    note, segment, overlap = note[keep], segment[keep], overlap[keep]
    np.add.at(weights, (segment, pitch[note] % 12), overlap)
    strong = overlap >= .25 * (ends[segment] - starts[segment])
    np.minimum.at(lowest, segment[strong], pitch[note[strong]])
    total = weights.sum(1, keepdims=True)
    shares = np.divide(weights, total, out=np.zeros_like(weights), where=total > 0)
    inside = shares @ _TEMPLATES.T
    p = CHORD_PARAMS
    emission = inside - p['outside'] * (1 - inside) - p['seventh'] * _SEVENTH[None]
    has_bass = lowest < 999
    emission[has_bass] += (p['bassRoot'] * _IS_ROOT[lowest[has_bass] % 12]
                           + p['bassTone'] * _IS_TONE[lowest[has_bass] % 12])
    emission += p['diatonic'] * _DIATONIC[[keys[b] for b, _, _, _ in segments]]
    emission[total[:, 0] == 0] = 0.
    # Viterbi with a uniform change cost (stay or jump from the best state): O(segments x states).
    n, states = emission.shape
    score_, back, every = emission[0].copy(), np.zeros((n, states), dtype=np.int64), np.arange(states)
    for i in range(1, n):
        best = int(score_.argmax())
        move = score_[best] - p['change'] - (p['weakBeatChange'] if segments[i][3] % 2 else 0.)
        stay = score_ >= move
        back[i] = np.where(stay, every, best)
        score_ = np.where(stay, score_, move) + emission[i]
    path = np.empty(n, dtype=np.int64)
    path[-1] = int(score_.argmax())
    for i in range(n - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    out: dict[int, list] = {}
    previous = None
    for (bar, offset, _, _), state in zip(segments, path):
        chord = _STATES[int(state)]
        if chord != previous:
            out.setdefault(bar, []).append((offset, chord[0], chord[1]))
        previous = chord
    return out


def lieder_chords(labels, score, first: int, last: int) -> dict[int, list[tuple[Fraction, int, int]]] | None:
    """AugmentedNet chord changes for bars first..last from the aligned joint corpus (None if not aligned)."""
    from four_pillar_v1_alignment import verified_bar_steps
    piece = labels.joint.get(score.score_id)
    if piece is None:
        return None
    if score.score_id not in labels.alignment:
        try:
            labels.alignment[score.score_id] = verified_bar_steps(score, piece)
        except ValueError:
            labels.alignment[score.score_id] = None
    starts = labels.alignment[score.score_id]
    if starts is None:
        return None
    arrays = piece['arrays']
    out: dict[int, list] = {}
    previous = None
    for bar in range(first, last + 1):
        a = starts[bar]
        b = starts[bar + 1] if bar + 1 < len(starts) else len(arrays['bar'])
        for step in range(a, b):
            root, quality = int(arrays['ch_root'][step]), int(arrays['ch_q'][step])
            if not (0 <= root < 12 and 0 <= quality < len(QUALITIES)):
                continue           # unknown span: the last known chord stays in effect
            if (root, quality) != previous:
                out.setdefault(bar, []).append((Fraction(step - a, 4), root, quality))
            previous = (root, quality)
    return out


def analyze(score, source: str, labels=None, first: int = 0, last: int | None = None) -> dict:
    """Keys for every bar and chord changes for bars first..last (labels: SourceLabels for Lieder)."""
    last = len(score.measures) - 1 if last is None else last
    table = NoteTable(score)
    keys = track_keys(score, table)
    chords = None
    if source == 'Lieder' and labels is not None:
        chords = lieder_chords(labels, score, first, last)
    origin = 'augmentednet' if chords is not None else 'tracker'
    if chords is None:
        chords = track_chords(score, keys, first, last, table)
    return {'keys': keys, 'chords': chords, 'chordSource': origin, 'table': table}


def transpose_analysis(analysis: dict, shift: int) -> dict:
    """Same analysis for the score transposed by `shift` semitones (keys and chord roots move with it)."""
    if not shift:
        return analysis
    return {'keys': [key_id(k % 12 + shift, k // 12) for k in analysis['keys']],
            'chords': {bar: [(offset, (root + shift) % 12, quality) for offset, root, quality in spans]
                       for bar, spans in analysis['chords'].items()},
            'chordSource': analysis.get('chordSource'), 'table': analysis.get('table')}


def rule() -> dict:
    return {'relOffset': REL_OFFSET, 'relPitches': REL_PITCHES, 'tonicLow': TONIC_LOW, 'keyParams': KEY_PARAMS,
            'majorProfile': MAJOR_PROFILE, 'minorProfile': MINOR_PROFILE, 'chordParams': CHORD_PARAMS,
            'coreQualities': CORE_QUALITIES}
