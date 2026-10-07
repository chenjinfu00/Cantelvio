#!/usr/bin/env python3
"""Transcription -> score: put a recording's transcribed notes (seconds) on bars and beats, keep the notes a score
should keep, and write MusicXML that Cantelvio Score opens.

    # 1. notes and beats (on the Mac, in MuScriptor's environment; see audio_transcribe_muscriptor.py)
    MuScriptor-large-1.3B/.venv-py312/bin/python training/scripts/audio_transcribe_muscriptor.py song.wav
    # 2. the score (Cantelvio Compose's environment)
    .venv-training/bin/python training/scripts/audio_to_score.py song.notes.json --output song.musicxml
    # 3. open song.musicxml in Cantelvio Score (Open, or drop it on the window)

Steps:
  beats      the tracked beats give a tempo map that follows the performance (rubato included); tracker slips are
             repaired (a doubled beat; a missed beat where notes start; bars made consistent with the downbeats);
             a constant lag of the onsets against the beats is removed; the downbeats give the metre and bar 1.
  rhythm     every beat gets a subdivision (1, 2, 4, 8, or triplets 3, 6, 12) by Viterbi over the beats, for each
             instrument on its own (a triplet accompaniment under a duple melody keeps both): onsets snap to it,
             simpler grids are preferred, a passage keeps its grid, very short notes (often blips) count less;
             mostly triplet beats make a compound metre (6/8, 9/8, 12/8; --metre overrides).
  runs       fast melodic lines (scales, arpeggios, passage work: five or more notes of one instrument, close in
             time and pitch, evenly spaced) are quantized as lines: the run's spacing chooses its grid (which may
             change inside it, e.g. a sextuplet upbeat, then sixteenths), its notes take strictly increasing grid
             points (a crowded spot does not shift the rest), last until the next note, and fix the grid of the
             beats they go through. A run that one or two missing notes cut in two (a gap of two or three times
             its spacing) is joined again. Inside a run one or two missing scale steps or arpeggio notes are added
             and a semitone slip in a diatonic scale is corrected (only where the line leaves no doubt: a regular
             line around the gap, the note before it released early, no chord there, one direction throughout).
  parts      MuScriptor's instrument groups become instruments of the catalog (string and brass ensembles split by
             register, voices by range); a voice label that often sounds several pitches at once (a choir, a duet)
             becomes a part per line (soprano, alto, tenor, bass by register); groups with very few notes are merged
             into the part closest in register; drums are left out. Keyboards and harps get two staves (hands split
             by a moving boundary).
  keep       duplicates; short octave / twelfth ghosts of a longer note that have no neighbour in their own
             register; very short blips outside any run; notes an instrument cannot play (well out of range, or
             more notes than a voice or a wind sounds at once; for a single line a new note ends the previous one)
             move to a part that can take them, or go; with
             Cantelvio Compose's harmonic-analysis model (harmonizer v2), short notes that fit neither the chord nor a
             stepwise line and whose pitch class their part does not play within two beats (the top line is always
             kept). At most four voices per staff; releases that stop just short of the next note of their voice
             reach it.
  fill       Cantelvio Compose's note filler (note_filler_v1.py, when torch and its weights are present; --filler none turns
             it off) reads the cleaned score around every onset and beat-grid point and adds the notes the
             transcription most likely missed, each to the part playing nearest.
  notation   key from the pitch-class profile, spelling in that key, written pitch and <transpose> for transposing
             instruments, ties across beats and bars, tuplet brackets per voice where its notes sit on triplets.

`--report` writes what was removed, adjusted and added, and why. Reading MIDI is not needed: step 1 writes JSON.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
import sys
from collections import Counter, defaultdict
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field
from fractions import Fraction as F
from pathlib import Path
from xml.sax.saxutils import escape

import numpy as np

SCHEMA = 'ailegro.transcription/1'
DIVISIONS = 24                       # per quarter: 16ths (6), triplet eighths (8), sextuplets (4), 32nds (3)
# subdivisions of the beat: prior cost and family (0 fits both, 1 the metre's own, 2 its tuplets)
SIMPLE = {1: (0., 0), 2: (.4, 1), 4: (1.2, 1), 8: (3.5, 1), 3: (2., 2), 6: (3.5, 2), 12: (7.5, 0)}
COMPOUND = {1: (0., 0), 3: (.4, 1), 6: (1.2, 1), 12: (3.5, 0), 2: (2.5, 2), 4: (4., 2)}
TRIPLET = {3, 6, 12}
SWITCH = .5                          # changing between duple and triplet subdivisions (1 and 12 fit both)
ONSET_SIGMA = .035                   # seconds: performance + transcription timing noise
ONSET_CAP = 9.                       # most one onset can cost a grid (squared sigmas)
SHORT_SECONDS = .07                  # onsets of notes shorter than this (often blips) weigh SHORT_WEIGHT in the
SHORT_WEIGHT = .3                    # choice of grid
PER_INSTRUMENT_GRIDS = True          # each instrument with PER_INSTRUMENT_MIN notes gets its own grid per beat
PER_INSTRUMENT_MIN = 24
END_GLOBAL_GRID = False              # releases snap to the grid of all instruments rather than their own
# runs: fast melodic lines (scales, arpeggios, passage work) are quantized as lines, not note by note
RUNS = True
RUN_MIN_NOTES = 5
RUN_MIN_IOI, RUN_MAX_IOI = .035, .3  # seconds from one run note to the next
RUN_MAX_STEP = 7                     # semitones from one run note to the next
RUN_TOLERANCE_SECONDS = .045        # a gap this close to the run's typical gap is regular however fast the run
RUN_SIGMA = .03                      # seconds: timing noise of one onset inside a run
RUN_MISSING = 1.                     # cost of each note a run's grid implies was not transcribed
RUN_SWITCH = 4.                      # cost of changing the grid inside a run (e.g. sextuplets, then sixteenths)
RUN_FIX = 4.                         # extra cost of any other grid in a beat a run goes through
RUN_REPAIR = True                    # add a note a run lost, correct a semitone slip in a diatonic scale run
RUN_BRIDGE = True                    # join two pieces of a run that one or two missing notes cut apart
RUN_BRIDGE_MAX = .3                  # seconds: ... when the run's spacing is at most this
RUN_LEGATO_ACROSS_GAPS = False       # a run note before a missing one lasts until the next note found
RUN_HELD = 1.5                       # a note sounding longer than this many grid steps before a gap is a long note

# MuScriptor (MT3_FULL_PLUS) instrument groups -> (catalog id, MusicXML part name, instrument sound, GM program)
INSTRUMENTS = {
    'acoustic_piano': ('piano', 'Piano', 'keyboard.piano', 1),
    'electric_piano': ('piano', 'Piano', 'keyboard.piano', 1),
    'chromatic_percussion': ('vibraphone', 'Vibraphone', 'pitched-percussion.vibraphone', 12),
    'organ': ('organ', 'Organ', 'keyboard.organ', 20),
    'acoustic_guitar': ('guitar', 'Guitar', 'pluck.guitar', 25),
    'clean_electric_guitar': ('guitar', 'Guitar', 'pluck.guitar', 28),
    'distorted_electric_guitar': ('guitar', 'Guitar', 'pluck.guitar', 31),
    'acoustic_bass': ('double-bass', 'Contrabass', 'strings.contrabass', 33),
    'electric_bass': ('double-bass', 'Contrabass', 'strings.contrabass', 34),
    'violin': ('violin', 'Violin', 'strings.violin', 41),
    'viola': ('viola', 'Viola', 'strings.viola', 42),
    'cello': ('cello', 'Violoncello', 'strings.cello', 43),
    'contrabass': ('double-bass', 'Contrabass', 'strings.contrabass', 44),
    'orchestral_harp': ('harp', 'Harp', 'pluck.harp', 47),
    'timpani': ('timpani', 'Timpani', 'drum.timpani', 48),
    'trumpet': ('trumpet-bb', 'Trumpet in B♭', 'brass.trumpet.bflat', 57),
    'trombone': ('trombone', 'Trombone', 'brass.trombone', 58),
    'tuba': ('tuba', 'Tuba', 'brass.tuba', 59),
    'french_horn': ('horn-f', 'Horn in F', 'brass.french-horn', 61),
    'soprano_and_alto_sax': ('alto-sax', 'Alto Saxophone', 'wind.reed.saxophone.alto', 66),
    'tenor_sax': ('tenor-sax', 'Tenor Saxophone', 'wind.reed.saxophone.tenor', 67),
    'baritone_sax': ('baritone-sax', 'Baritone Saxophone', 'wind.reed.saxophone.baritone', 68),
    'oboe': ('oboe', 'Oboe', 'wind.reed.oboe', 69),
    'english_horn': ('english-horn', 'English Horn', 'wind.reed.english-horn', 70),
    'bassoon': ('bassoon', 'Bassoon', 'wind.reed.bassoon', 71),
    'clarinet': ('clarinet-bb', 'Clarinet in B♭', 'wind.reed.clarinet.bflat', 72),
    'flutes': ('flute', 'Flute', 'wind.flutes.flute', 74),
    'synth_lead': ('flute', 'Flute', 'wind.flutes.flute', 74),
    'synth_pad': ('piano', 'Piano', 'keyboard.piano', 1),
    'orchestra_hit': ('piano', 'Piano', 'keyboard.piano', 1),
}
SPLIT = {   # ensembles become an upper and a lower part
    'string_ensemble': (60, 'violin', 'cello'), 'synth_strings': (60, 'violin', 'cello'),
    'brass_section': (60, 'trumpet', 'trombone'),
}
VOICES = (('soprano', 'Soprano', 'voice.soprano', 60), ('alto', 'Alto', 'voice.alto', 55),
          ('tenor', 'Tenor', 'voice.tenor', 50), ('bass-voice', 'Bass', 'voice.bass', 0))
VOICE_CENTRES = (71, 64, 59, 50)      # typical median pitch of a soprano, alto, tenor, bass line
CHOIR_SHARE = .35                    # a voice label with this share of its onsets sounding two or more pitches ...
CHOIR_MIN_ONSETS = 12                # ... (and at least this many such onsets) is several voices: a choir or a duet
# sounding = written + (diatonic, chromatic): the parts are written in written pitch with <transpose>
TRANSPOSITION = {'trumpet-bb': (-1, -2), 'clarinet-bb': (-1, -2), 'horn-f': (-4, -7), 'english-horn': (-4, -7),
                 'alto-sax': (-5, -9), 'tenor-sax': (-8, -14), 'baritone-sax': (-12, -21), 'double-bass': (-7, -12)}
TWO_STAVES = {'piano', 'organ', 'harp'}
# playable ranges (MIDI, as in Cantelvio Score's catalog) and how many notes one player sounds at once
RANGES = {'soprano': (60, 84), 'alto': (53, 77), 'tenor': (48, 72), 'bass-voice': (40, 64), 'violin': (55, 103),
          'viola': (48, 91), 'cello': (36, 76), 'double-bass': (28, 67), 'flute': (60, 96), 'oboe': (58, 91),
          'english-horn': (52, 81), 'clarinet-bb': (50, 94), 'bassoon': (34, 75), 'horn-f': (34, 77),
          'trumpet-bb': (52, 84), 'trombone': (40, 72), 'tuba': (28, 65), 'alto-sax': (49, 81),
          'tenor-sax': (44, 76), 'baritone-sax': (36, 69), 'guitar': (40, 88), 'harp': (23, 104),
          'piano': (21, 108), 'organ': (24, 96), 'vibraphone': (53, 89), 'timpani': (40, 57)}
POLYPHONY = {'soprano': 1, 'alto': 1, 'tenor': 1, 'bass-voice': 1, 'flute': 1, 'oboe': 1, 'english-horn': 1,
             'clarinet-bb': 1, 'bassoon': 1, 'horn-f': 1, 'trumpet-bb': 1, 'trombone': 1, 'tuba': 1, 'alto-sax': 1,
             'tenor-sax': 1, 'baritone-sax': 1, 'violin': 4, 'viola': 4, 'cello': 4, 'double-bass': 2, 'timpani': 2}
KEYBOARDS = {'piano', 'organ', 'harp', 'guitar', 'vibraphone'}
CLEFS = {'bass-voice': 'F4', 'cello': 'F4', 'double-bass': 'F4', 'bassoon': 'F4', 'trombone': 'F4', 'tuba': 'F4',
         'timpani': 'F4', 'baritone-sax': 'G2', 'viola': 'C3', 'tenor': 'G2-8', 'guitar': 'G2-8'}
STEPS = 'CDEFGAB'
STEP_PC = (0, 2, 4, 5, 7, 9, 11)
MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)   # Krumhansl-Kessler
MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)


@dataclass
class Note:
    start: float                     # seconds (lag-corrected)
    end: float
    pitch: int
    instrument: str
    on: F = F(0)                     # score time in quarters from the start of the first bar
    dur: F = F(0)
    part: int = -1
    staff: int = 0
    voice: int = 0
    removed: str = ''
    run: int = -1                    # index of the run (fast melodic line) the note belongs to, -1 if none
    grid: int = 0                    # a run note: the subdivision of the beat its run uses there
    added: str = ''                  # why the note was added (it was not in the transcription)

    @property
    def length(self) -> float:
        return self.end - self.start


@dataclass
class PartInfo:
    instrument: str                  # catalog id
    name: str
    sound: str
    program: int
    staves: int = 1
    clef: tuple[str, ...] = ('G2',)
    transposition: tuple[int, int] | None = None


@dataclass
class Score:
    title: str
    beats_per_bar: int
    compound: bool
    beat_quarters: F                 # 1 (quarter beat) or 3/2 (dotted quarter)
    pickup: F                        # length of the pickup bar in quarters (0: none)
    bars: int
    qpm: float
    fifths: int
    mode: str
    parts: list[PartInfo]
    notes: list[Note]
    subdivision: dict[int, int] = field(default_factory=dict)   # score beat index -> subdivision
    downbeat: F | None = None        # score time of the first tracked downbeat
    report: dict = field(default_factory=dict)

    @property
    def bar_length(self) -> F:
        return self.beats_per_bar * self.beat_quarters

    def bar_start(self, bar: int) -> F:
        if not self.pickup:
            return bar * self.bar_length
        return F(0) if bar == 0 else self.pickup + (bar - 1) * self.bar_length

    def bar_end(self, bar: int) -> F:
        return self.pickup if self.pickup and bar == 0 else self.bar_start(bar) + self.bar_length

    @property
    def time_signature(self) -> tuple[int, int]:
        return (self.beats_per_bar * 3, 8) if self.compound else (self.beats_per_bar, 4)


# ====================================================================== beats -> score time
class BeatMap:
    """Seconds <-> beat index (float) through the tracked beats; linear beyond the first and last beat."""

    def __init__(self, beats):
        b = np.unique(np.asarray(beats, float))
        if len(b) < 2:
            raise ValueError('need at least two tracked beats')
        self.times = b
        self.head = float(np.median(np.diff(b[:5])))
        self.tail = float(np.median(np.diff(b[-5:])))

    def beat(self, t):
        t = np.asarray(t, float)
        inside = np.interp(t, self.times, np.arange(len(self.times), dtype=float))
        before = (t - self.times[0]) / self.head
        after = len(self.times) - 1 + (t - self.times[-1]) / self.tail
        return np.where(t < self.times[0], before, np.where(t > self.times[-1], after, inside))

    def seconds_per_beat(self, k: int) -> float:
        if k < 0:
            return self.head
        if k >= len(self.times) - 1:
            return self.tail
        return float(self.times[k + 1] - self.times[k])


def regularize_beats(beats, onsets) -> np.ndarray:
    """Tracked beats with tracker slips repaired: a beat much closer than the local beat interval to the previous
    one is dropped; a gap of about two or three intervals gets the missing beats when notes start there (a
    fermata or a long rest has no onsets, and keeps its gap)."""
    b = np.unique(np.asarray(beats, float))
    if len(b) < 6:
        return b
    starts = np.sort(np.asarray(onsets, float))
    out = [float(b[0])]
    for t in b[1:]:
        recent = np.diff(out[-9:]) if len(out) >= 3 else np.diff(b[:9])
        local = float(np.median(recent))
        gap = float(t) - out[-1]
        if gap < .55 * local:
            # two beats too close together: keep the one nearer to where the previous beat says it should be
            if len(out) >= 2 and abs(float(t) - (out[-2] + local)) < abs(out[-1] - (out[-2] + local)):
                out[-1] = float(t)
            continue
        k = round(gap / local)
        if 2 <= k <= 3 and abs(gap / k - local) < .2 * local:
            missing = [out[-1] + gap * j / k for j in range(1, k)]
            near = [np.abs(starts[np.searchsorted(starts, m - .07):np.searchsorted(starts, m + .07)] - m).size > 0
                    for m in missing]
            if any(near):
                out.extend(missing)
        out.append(float(t))
    return np.array(out)


def fit_bars(beats: np.ndarray, downbeats, per_bar: int) -> np.ndarray:
    """Beats made consistent with the tracked bars: a bar (between two downbeats) that lasts about `per_bar` beat
    intervals but holds one beat too few gets a beat in its largest gap; one beat too many loses the beat closest
    to a neighbour. Bars of another length (a metre change) are left alone."""
    b = sorted(map(float, beats))
    d = sorted(float(x) for x in downbeats)
    if len(d) < 2 or len(b) < 8:
        return np.asarray(b)
    for start, end in zip(d, d[1:]):
        before = [t for t in b if t <= start + .05][-9:]
        if len(before) < 4:
            continue
        local = float(np.median(np.diff(before)))
        if abs((end - start) / local - per_bar) > .35:
            continue
        inside = [t for t in b if start - .05 <= t < end - .05]
        points = inside + [end]
        if len(inside) == per_bar - 1:
            width, i = max((points[i + 1] - points[i], i) for i in range(len(points) - 1))
            if width > 1.6 * local:
                b.append(points[i] + width / 2)
                b.sort()
        elif len(inside) == per_bar + 1:
            close = min(range(1, len(inside)), key=lambda i: min(points[i] - points[i - 1], points[i + 1] - points[i]))
            b.remove(inside[close])
    return np.asarray(b)


def onset_lag(onsets, beat_map: BeatMap, limit: float = .05) -> float:
    """Seconds by which the onsets sit late (positive) or early against the beat subdivision they follow best;
    0 when there are too few onsets or no clear subdivision."""
    phases = beat_map.beat(np.unique(np.round(np.asarray(onsets, float), 3)))
    if len(phases) < 24:
        return 0.
    best = max(((abs(np.exp(2j * np.pi * np.mod(phases * s, 1)).mean()), s,
                 float(np.angle(np.exp(2j * np.pi * np.mod(phases * s, 1)).mean()))) for s in (1, 2, 3, 4)))
    strength, s, angle = best
    if strength < .5:
        return 0.
    lag = angle / (2 * np.pi * s) * float(np.median(np.diff(beat_map.times)))
    return lag if abs(lag) <= limit else 0.


def metre(beat_map: BeatMap, downbeats) -> tuple[int, int]:
    """(beats per bar, phase): downbeats sit on beats phase + k * beats per bar."""
    if len(downbeats) == 0:
        return 4, 0
    idx = np.round(beat_map.beat(np.asarray(downbeats, float))).astype(int)
    diffs = np.diff(idx)
    diffs = diffs[(diffs >= 2) & (diffs <= 6)]
    per_bar = Counter(diffs.tolist()).most_common(1)[0][0] if len(diffs) else 4
    phase = Counter((idx % per_bar).tolist()).most_common(1)[0][0]
    return int(per_bar), int(phase)


def _viterbi_subdivisions(groups: dict[int, list[float]], first: int, last: int, table: dict,
                          seconds_per_beat, weights: dict[int, list[float]] | None = None,
                          fixed: dict[int, int] | None = None) -> dict[int, int]:
    """Subdivision per beat: emission = squared onset distances to the grid (in units of ONSET_SIGMA, weighted,
    capped at ONSET_CAP) plus the subdivision's prior, plus RUN_FIX for a grid other than the one a run fixed for
    the beat; switching between the metre's own grids and tuplets costs SWITCH."""
    states = tuple(table)
    prior = {s: table[s][0] for s in states}
    n, k = last - first + 1, len(states)
    cost = np.zeros((n, k))
    for i in range(n):
        beat = first + i
        sec = seconds_per_beat(beat)
        for j, s in enumerate(states):
            c = prior[s]
            ws = weights.get(beat) if weights else None
            for idx, frac in enumerate(groups.get(beat, ())):
                err = abs(frac - round(frac * s) / s) * sec / ONSET_SIGMA
                c += min(err * err, ONSET_CAP) * (ws[idx] if ws else 1.)
            if fixed and beat in fixed and fixed[beat] != s:
                c += RUN_FIX
            cost[i, j] = c
    family = np.array([table[s][1] for s in states])
    trans = np.where((family[:, None] != family[None, :]) & (family[:, None] > 0) & (family[None, :] > 0),
                     SWITCH, 0.)
    total = cost[0].copy()
    back = np.zeros((n, k), np.int32)
    for i in range(1, n):
        cand = total[:, None] + trans
        back[i] = np.argmin(cand, axis=0)
        total = cand[back[i], np.arange(k)] + cost[i]
    path = np.zeros(n, np.int32)
    path[-1] = int(np.argmin(total))
    for i in range(n - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    return {first + i: states[path[i]] for i in range(n)}


def _onset_groups(starts, notes: list[Note]) -> tuple[dict[int, list[float]], dict[int, list[float]]]:
    """Distinct onsets per beat (fraction of the beat) and their weight in the choice of grid."""
    weight_at = defaultdict(float)
    for b, n in zip(np.round(np.asarray(starts, float), 3), notes):
        weight_at[float(b)] = max(weight_at[float(b)], SHORT_WEIGHT if n.length < SHORT_SECONDS else 1.)
    groups, weights = defaultdict(list), defaultdict(list)
    for b in sorted(weight_at):
        k = math.floor(b + 1 / 24)
        groups[k].append(float(b - k))
        weights[k].append(weight_at[b])
    return groups, weights


def snap(b: float, subdivision: dict[int, int]) -> F:
    """A beat position snapped to the subdivision of its beat (positions within 1/24 beat before a beat belong to
    that beat)."""
    k = math.floor(b + 1 / 24)
    s = subdivision.get(k, 4)
    return k + F(round((b - k) * s), s)


# ====================================================================== runs
def find_runs(notes: list[Note]) -> list[list[int]]:
    """Fast melodic lines in the transcription (scales, arpeggios, passage work): chains of notes of one
    instrument, each following the previous one after RUN_MIN_IOI..RUN_MAX_IOI seconds by at most RUN_MAX_STEP
    semitones (the earliest such note, the closer pitch on a tie), cut where the spacing breaks and kept when
    RUN_MIN_NOTES or more notes are regularly spaced (a single dropped note leaves a double gap)."""
    by_instrument = defaultdict(list)
    for i, n in enumerate(notes):
        by_instrument[n.instrument].append(i)
    runs = []
    for idx in by_instrument.values():
        idx.sort(key=lambda i: (notes[i].start, notes[i].pitch))
        successor, taken = {}, set()
        for pos, i in enumerate(idx):
            a, best, best_cost = notes[i], None, 0.
            for j in idx[pos + 1:]:
                b = notes[j]
                dt = b.start - a.start
                if dt > RUN_MAX_IOI:
                    break
                if dt >= RUN_MIN_IOI and abs(b.pitch - a.pitch) <= RUN_MAX_STEP and j not in taken:
                    cost = dt + .012 * abs(b.pitch - a.pitch)
                    if best is None or cost < best_cost:
                        best, best_cost = j, cost
            if best is not None:
                successor[i] = best
                taken.add(best)
        chains = []
        for head in idx:
            if head in taken:
                continue
            chain = [head]
            while chain[-1] in successor:
                chain.append(successor[chain[-1]])
            chains.append(chain)
        if RUN_BRIDGE:
            chains = _bridge(chains, notes)
        for chain in chains:
            runs.extend(_regular_stretches(chain, notes))
    return runs


def _bridge(chains: list[list[int]], notes: list[Note]) -> list[list[int]]:
    """Join a chain to the one that starts where its next note or the one after would be: a missing note leaves
    a gap of two (or three) times the chain's spacing, often longer than RUN_MAX_IOI, which cut the chain."""
    def typical(chain, tail=True):
        gaps = np.diff([notes[i].start for i in (chain[-5:] if tail else chain[:5])])
        return float(np.median(gaps)) if len(gaps) else None

    heads = {chain[0]: chain for chain in chains}
    joined_into = {}
    out = []
    for chain in sorted(chains, key=lambda c: notes[c[0]].start):
        if chain[0] in joined_into:
            continue
        while True:
            g = typical(chain)
            if g is None or g > RUN_BRIDGE_MAX:
                break
            a = notes[chain[-1]]
            best = None
            for head, other in heads.items():
                if head in joined_into or other is chain:
                    continue
                b = notes[head]
                dt = b.start - a.start
                for missing, (lo, hi) in ((1, (1.7, 2.35)), (2, (2.6, 3.4))):
                    if lo * g <= dt <= hi * g and abs(b.pitch - a.pitch) <= RUN_MAX_STEP * (missing + 1):
                        g2 = typical(other, tail=False)
                        if g2 is not None and not (.7 * g <= g2 <= 1.4 * g or abs(g2 - g) <= RUN_TOLERANCE_SECONDS):
                            continue
                        err = abs(dt / g - (missing + 1))
                        if best is None or err < best[0]:
                            best = (err, head, other)
            if best is None:
                break
            _, head, other = best
            joined_into[head] = chain[0]
            chain = chain + other
        out.append(chain)
    return out


def _regular_stretches(chain: list[int], notes: list[Note]) -> list[list[int]]:
    """Parts of a chain whose spacing is regular: each gap 0.6..1.6 times the stretch's typical gap (the median of
    its gaps so far, of its first three to begin with) or within RUN_TOLERANCE_SECONDS of it (very fast runs), or
    about twice or three times it (one or two notes missing). A note belongs to one stretch at most."""
    gaps = [notes[b].start - notes[a].start for a, b in zip(chain, chain[1:])]
    out, start = [], 0
    while start < len(gaps):
        end = start
        while end < len(gaps):
            typical = float(np.median(gaps[start:end] if end > start else gaps[start:start + 3]))
            g = gaps[end]
            if not (.6 * typical <= g <= 1.6 * typical or abs(g - typical) <= RUN_TOLERANCE_SECONDS
                    or (end > start and (1.75 * typical <= g <= 2.3 * typical or 2.6 * typical <= g <= 3.4 * typical))):
                break
            end += 1
        if end - start + 1 >= RUN_MIN_NOTES:
            out.append(chain[start:end + 1])
        start = end + 1
    return out


def run_positions(beats: list[float], seconds_per_beat: float, table: dict) -> list[tuple[int, F]]:
    """Grid and position (beat-map beats) of each onset of a run. Each gap between consecutive notes takes a
    subdivision by Viterbi: its fit as a whole number of grid steps (one, or more when notes were not transcribed,
    RUN_MISSING each), the subdivision's prior when the run enters it, RUN_SWITCH for changing it inside the run.
    Within each stretch of one grid the notes take the strictly increasing grid points closest to them (least
    squares), so a crowded spot does not push the rest of the run along; a stretch the grid fits so badly that a
    note moves 1.5 steps or more ends the run (fewer than RUN_MIN_NOTES placed notes: no run)."""
    b = np.asarray(beats, float)
    gaps = np.diff(b)
    states = [x for x in table if x >= 2]
    if not len(gaps) or not states:
        return []
    emit = np.zeros((len(gaps), len(states)))
    for j, x in enumerate(states):
        steps = np.maximum(1, np.round(gaps * x))
        err = (gaps * x - steps) * (seconds_per_beat / x) / (RUN_SIGMA * math.sqrt(2))
        emit[:, j] = np.minimum(err * err, 9.) + RUN_MISSING * (steps - 1)
    prior = np.array([table[x][0] for x in states])
    trans = np.where(np.eye(len(states), dtype=bool), 0., RUN_SWITCH + prior[None, :])
    total, back = prior + emit[0], np.zeros(emit.shape, np.int32)
    for i in range(1, len(gaps)):
        cand = total[:, None] + trans
        back[i] = np.argmin(cand, axis=0)
        total = cand[back[i], np.arange(len(states))] + emit[i]
    path = [int(np.argmin(total))]
    for i in range(len(gaps) - 1, 0, -1):
        path.append(int(back[i, path[-1]]))
    path.reverse()
    grid_of = [states[j] for j in path] + [states[path[-1]]]      # a note takes the grid of the gap after it
    out: list[tuple[int, F]] = []
    start = 0
    while start < len(b):
        end = start
        while end + 1 < len(b) and grid_of[end + 1] == grid_of[start]:
            end += 1
        x = grid_of[start]
        real = b[start:end + 1] * x
        slots = _increasing_slots(real)
        if float(np.max(np.abs(np.asarray(slots) - real))) >= 1.5:
            break                                     # the grid does not fit this stretch: the run ends here
        for q in slots:
            pos = F(q, x)
            if out and pos <= out[-1][1]:
                pos = F(math.floor(out[-1][1] * x) + 1, x)
            out.append((x, pos))
        start = end + 1
    return out if len(out) >= RUN_MIN_NOTES else []


def _increasing_slots(real: np.ndarray) -> list[int]:
    """Strictly increasing whole numbers closest (least squares) to `real`: isotonic regression of real - i (pool
    adjacent violators), rounded, plus i."""
    y = [float(v) - i for i, v in enumerate(real)]
    blocks: list[list[float]] = []                  # [mean, count]
    for v in y:
        blocks.append([v, 1])
        while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
            m2, c2 = blocks.pop()
            m1, c1 = blocks.pop()
            blocks.append([(m1 * c1 + m2 * c2) / (c1 + c2), c1 + c2])
    fitted = [m for m, c in blocks for _ in range(int(c))]
    return [int(round(v)) + i for i, v in enumerate(fitted)]


def scale_classes(fifths: int, mode: str) -> set[int]:
    """Pitch classes of the key (a minor key also has its raised sixth and seventh)."""
    tonic = (fifths * 7) % 12
    classes = {(tonic + i) % 12 for i in (0, 2, 4, 5, 7, 9, 11)}
    if mode == 'minor':
        classes |= {(tonic + 9 + 9) % 12, (tonic + 9 + 11) % 12}
    return classes


def _sign(x: int) -> int:
    return (x > 0) - (x < 0)


def repair_runs(notes: list[Note], score: 'Score', chords: dict[int, set[int]] | None, stats: Counter) -> None:
    """Inside a run (a fast melodic line found before quantization), where its grid shows one or two points empty
    in a regular line, the note before the gap was released early (not held) and no chord sounds around: a scale run
    (steps of one or two semitones) gets the scale steps in between, an arpeggio the chord tones in between (the
    run's own pitch classes nearby that are also tones of the analysed chord), when the line goes the same way
    before, through and after the gap and exactly one pitch fits each empty point. A note of a diatonic scale run
    that lies a semitone off the key (and is no chord tone) between two scale notes a third apart is moved onto the
    scale step. The key's pitch classes count as the scale, plus the chord tones of Cantelvio Compose's harmonic analysis
    when it ran."""
    scale = scale_classes(score.fifths, score.mode)

    def in_scale(pitch: int, on: F) -> bool:
        tones = chords.get(int(on * 4)) if chords else None
        return pitch % 12 in scale or bool(tones and pitch % 12 in tones)

    runs = defaultdict(list)
    for n in notes:
        if not n.removed and n.run >= 0:
            runs[n.run].append(n)
    added = []

    def gap(a: Note, b: Note) -> int:
        """Grid steps from a to b (0 when the two notes are not on one grid)."""
        if not a.grid or a.grid != b.grid:
            return 0
        steps = (b.on - a.on) / (score.beat_quarters / a.grid)
        return int(steps) if steps.denominator == 1 else 0

    for run in runs.values():
        run.sort(key=lambda n: n.on)
        steps = [b.pitch - a.pitch for a, b in zip(run, run[1:]) if gap(a, b) == 1]
        if len(steps) < 3:
            continue
        typical = float(np.median(np.abs(steps)))
        stepwise, arpeggio = typical <= 2.5, 2.5 < typical <= 5.5
        diatonic = sum(in_scale(n.pitch, n.on) for n in run) >= .85 * len(run)
        # a semitone slip in a diatonic scale run
        if stepwise and diatonic:
            for a, x, b in zip(run, run[1:], run[2:]):
                if not (gap(a, x) == 1 == gap(x, b)) or in_scale(x.pitch, x.on):
                    continue
                d = b.pitch - a.pitch
                if abs(d) not in (3, 4) or not (in_scale(a.pitch, a.on) and in_scale(b.pitch, b.on)):
                    continue
                fixes = [y for y in (x.pitch - 1, x.pitch + 1) if in_scale(y, x.on)
                         and 1 <= abs(y - a.pitch) <= 2 and 1 <= abs(b.pitch - y) <= 2
                         and _sign(y - a.pitch) == _sign(d) == _sign(b.pitch - y)]
                if len(fixes) == 1:
                    x.pitch = fixes[0]
                    stats['run pitch'] += 1
        # one or two notes missing between two run notes: only where the line leaves no doubt (a regular line
        # around the gap, the note before it released early instead of held, no chord around, the same direction
        # before, through and after the gap, one pitch that fits for each empty grid point)
        for i, (a, b) in enumerate(zip(run, run[1:])):
            k = gap(a, b)
            if k not in (2, 3) or a.part != b.part:
                continue
            if not (i >= 2 and gap(run[i - 2], run[i - 1]) == 1 == gap(run[i - 1], a)
                    and i + 2 < len(run) and gap(b, run[i + 2]) == 1):
                continue
            if a.end - a.start > RUN_HELD * (b.start - a.start) / k:
                continue                      # the note before the gap is held: a longer note, nothing missing
            if any(not m.removed and m is not a and m is not b and m.part == a.part and m.on in (a.on, b.on)
                   and abs(m.pitch - a.pitch) <= 9 for m in notes):
                continue                      # chords: the line may be read out of a texture
            d = b.pitch - a.pitch
            way = _sign(d)
            if not way or _sign(a.pitch - run[i - 1].pitch) != way or _sign(run[i + 2].pitch - b.pitch) != way:
                continue                      # a turn or a repeated note: the missing note is not clear
            step = score.beat_quarters / a.grid
            ons = [a.on + j * step for j in range(1, k)]
            lo, hi = sorted((a.pitch, b.pitch))
            if stepwise:
                fits = [y for y in range(lo + 1, hi) if in_scale(y, ons[0])]
                if k == 2 and abs(d) == 4:
                    fits = [a.pitch + 2 * way]           # a whole-tone scale step either way
            elif arpeggio:
                nearby = {n.pitch % 12 for n in run if abs(n.on - ons[0]) <= score.beat_quarters}
                tones = chords.get(int(ons[0] * 4)) if chords else None
                fits = [y for y in range(lo + 2, hi - 1) if y % 12 in nearby and (not tones or y % 12 in tones)]
            else:
                continue
            if len(fits) != k - 1 or any(abs(y - z) < 1 for y, z in zip(fits, fits[1:])):
                continue
            fits = sorted(fits, reverse=way < 0)
            if any(not m.removed and m.part == a.part and m.on in ons and abs(m.pitch - y) <= 2
                   for m in notes for y in fits):
                continue
            t_step = (b.start - a.start) / k
            for j, (on, y) in enumerate(zip(ons, fits)):
                t = a.start + (j + 1) * t_step
                added.append(Note(t, t + t_step, y, a.instrument, on=on, dur=step, part=a.part, run=a.run,
                                  grid=a.grid, added='run gap'))
                stats['run gap'] += 1
            if a.on + a.dur > ons[0]:
                a.dur = ons[0] - a.on
    notes.extend(added)


# ====================================================================== parts
def choir_lines(notes: list[Note]) -> dict[int, int]:
    """Several voices under MuScriptor's one 'voice' label (a choir, a duet): when CHOIR_SHARE of the label's onsets
    sound two or more pitches, its notes go to k lines (k: the usual number of pitches at once, 2 to 4), onset by
    onset: with k or more pitches the top ones take the upper lines and the lowest the bottom line; with fewer, the
    lines whose last pitch is closest (in order, avoiding a line that is still sounding). Line (0 = top) per index
    of a voice note in `notes`; empty when the label sounds one voice."""
    by_on = defaultdict(list)
    for i, n in enumerate(notes):
        if n.instrument == 'voice':
            by_on[n.on].append(i)
    if not by_on:
        return {}
    sizes = [len({notes[i].pitch for i in idx}) for idx in by_on.values()]
    several = sum(s >= 2 for s in sizes)
    if several < CHOIR_MIN_ONSETS or several / len(sizes) < CHOIR_SHARE:
        return {}
    k = int(np.clip(round(float(np.percentile(sizes, 80))), 2, 4))
    pitches = [notes[i].pitch for idx in by_on.values() for i in idx]
    last = [float(v) for v in np.percentile(pitches, np.linspace(90, 10, k))]
    ends = [F(-1)] * k
    line_of = {}
    for on in sorted(by_on):
        chord = sorted({notes[i].pitch for i in by_on[on]}, reverse=True)
        if len(chord) >= k:
            lines = list(range(k - 1)) + [None] * (len(chord) - k) + [k - 1]
            for j, line in enumerate(lines):
                if line is None:                      # more pitches than lines: the closest line takes it
                    lines[j] = min(range(k), key=lambda v: abs(last[v] - chord[j]))
        else:
            def cost(combo, chord=chord, on=on):
                return sum(abs(last[v] - p) + (4. if ends[v] > on else 0.) for v, p in zip(combo, chord))
            lines = list(min(itertools.combinations(range(k), len(chord)), key=cost))
        for p, line in zip(chord, lines):
            for i in by_on[on]:
                if notes[i].pitch == p:
                    line_of[i] = line
                    ends[line] = notes[i].on + notes[i].dur    # a new note ends the line's previous one
            last[line] = float(p)
    return line_of


def assign_parts(notes: list[Note], min_share: float = .04, min_notes: int = 40) -> tuple[list[PartInfo], dict]:
    """Catalog instruments for MuScriptor's groups; small groups merge into the part closest in register; a voice
    label that sounds several voices becomes a part per voice (choir_lines)."""
    pitched = [n for n in notes if n.instrument != 'drums']
    dropped = len(notes) - len(pitched)
    choir = choir_lines(pitched)
    keys = []                                   # part key per note: group, group:upper/lower or voice:line
    for i, n in enumerate(pitched):
        if n.instrument in SPLIT:
            cut = SPLIT[n.instrument][0]
            keys.append(f'{n.instrument}:{"upper" if n.pitch >= cut else "lower"}')
        elif i in choir:
            keys.append(f'voice:{choir[i]}')
        else:
            keys.append(n.instrument if n.instrument in INSTRUMENTS or n.instrument == 'voice' else 'acoustic_piano')
    count = Counter(keys)
    total = max(len(pitched), 1)
    big = [k for k, c in count.most_common() if c >= min_notes or c / total >= min_share]
    if not big and count:
        big = [count.most_common(1)[0][0]]
    centre = {k: float(np.median([n.pitch for n, kk in zip(pitched, keys) if kk == k])) for k in count}
    merged = {}
    for k in count:
        merged[k] = k if k in big else min(big, key=lambda b: abs(centre[b] - centre[k]))
    order = sorted(big, key=lambda k: (not k.startswith('voice'), -centre[k]))   # voices, then high to low
    lines = [k for k in order if k.startswith('voice:')]
    voice_type = {}
    if lines:                                   # soprano, alto, tenor, bass in order of register
        combo = min(itertools.combinations_with_replacement(range(len(VOICES)), len(lines)),
                    key=lambda c: sum(abs(centre[k] - VOICE_CENTRES[t]) for k, t in zip(lines, c))
                    + 3 * (len(c) - len(set(c))))             # two lines of one type (S1, S2) only when clear
        voice_type = dict(zip(lines, combo))
    infos, index = [], {}
    for k in order:
        group, _, side = k.partition(':')
        if group in SPLIT:
            target = SPLIT[group][1 if side == 'upper' else 2]
            inst, name, sound, program = INSTRUMENTS[target]
        elif group == 'voice':
            if k in voice_type:
                inst, name, sound, _ = VOICES[voice_type[k]]
            else:
                inst, name, sound, _ = next(v for v in VOICES if centre[k] >= v[3])
            program = 53
        else:
            inst, name, sound, program = INSTRUMENTS[group]
        info = PartInfo(inst, name, sound, program, staves=2 if inst in TWO_STAVES else 1,
                        transposition=TRANSPOSITION.get(inst))
        info.clef = ('G2', 'F4') if info.staves == 2 else (CLEFS.get(inst, 'G2'),)
        index[k] = len(infos)
        infos.append(info)
    # two parts of the same instrument get numbered names
    seen = Counter(i.name for i in infos)
    numbers = Counter()
    for info in infos:
        if seen[info.name] > 1:
            numbers[info.name] += 1
            info.name = f'{info.name} {numbers[info.name]}'
    for n, k in zip(pitched, keys):
        n.part = index[merged[k]]
    stats = {'drums': dropped, 'mergedGroups': sorted(k for k in count if k not in big),
             'mergedNotes': sum(c for k, c in count.items() if k not in big),
             'voiceLines': len({line for line in choir.values()})}
    return infos, stats


def fit_instruments(notes: list[Note], parts: list[PartInfo], stats: Counter) -> None:
    """Notes an instrument cannot play go where they fit: a note well outside a part's range, and the extra notes
    of an instrument that sounds fewer notes at once (one for a voice or a wind, four for a bowed string) move to
    the part that can take them (keyboards first, then the closest register); without one, the extra notes of a
    single line are removed and the others stay."""
    live = [n for n in notes if not n.removed]
    centre = {i: float(np.median([n.pitch for n in live if n.part == i] or [60])) for i in range(len(parts))}

    def home(n: Note, exclude: int) -> int | None:
        fits = [i for i, p in enumerate(parts) if i != exclude
                and RANGES.get(p.instrument, (0, 127))[0] - 2 <= n.pitch <= RANGES.get(p.instrument, (0, 127))[1] + 2]
        if not fits:
            return None
        return min(fits, key=lambda i: (parts[i].instrument not in KEYBOARDS, abs(centre[i] - n.pitch)))

    def move(n: Note, why: str) -> None:
        target = home(n, n.part)
        if target is None:
            if POLYPHONY.get(parts[n.part].instrument) == 1:      # a single line: the extra note is noise
                remove([n], why, stats)
        else:
            n.part = target
            stats[f'moved: {why}'] += 1

    for n in live:
        lo, hi = RANGES.get(parts[n.part].instrument, (0, 127))
        if n.pitch < lo - 2 or n.pitch > hi + 2:
            move(n, 'out of range')
    for i, info in enumerate(parts):
        limit = POLYPHONY.get(info.instrument)
        if not limit:
            continue
        line = sorted((n for n in notes if not n.removed and n.part == i), key=lambda n: (n.on, -n.length))
        sounding: list[Note] = []
        previous = None
        for on in sorted({n.on for n in line}):
            sounding = [m for m in sounding if m.on + m.dur > on and m.part == i and not m.removed]
            starting = [n for n in line if n.on == on and n.part == i and not n.removed]
            if limit == 1 and starting:
                # a single line: a new note ends the one before (legato releases overlap the next onset,
                # above all in fast runs); only notes starting together compete
                for m in sounding:
                    m.dur = on - m.on
                    stats['shortened'] += 1
                sounding = []
            room = max(limit - len(sounding), 0)
            if len(starting) > room:
                ref = previous if previous is not None else float(np.median([n.pitch for n in line]))
                starting.sort(key=lambda n: (abs(n.pitch - ref), -n.length))
                for n in starting[max(room, 1 if not sounding else room):]:
                    move(n, 'more notes than the instrument plays at once')
                starting = [n for n in starting if n.part == i and not n.removed]
            if starting:
                previous = starting[0].pitch
            sounding += starting


def split_hands(notes: list[Note]) -> None:
    """Staff 0 (right hand) / 1 (left hand) for a keyboard part: each onset's chord is cut where it best fits the
    two hands' recent average pitches, starting from middle C."""
    upper, lower = 67., 50.
    by_onset = defaultdict(list)
    for n in notes:
        by_onset[n.on].append(n)
    for on in sorted(by_onset):
        chord = sorted(by_onset[on], key=lambda n: n.pitch)
        best, best_cost = 0, math.inf
        for cut in range(len(chord) + 1):
            low, high = chord[:cut], chord[cut:]
            c = sum(abs(n.pitch - lower) for n in low) + sum(abs(n.pitch - upper) for n in high)
            for hand in (low, high):
                if len(hand) > 1 and hand[-1].pitch - hand[0].pitch > 14:
                    c += 12 * (hand[-1].pitch - hand[0].pitch - 14)
            if c < best_cost:
                best, best_cost = cut, c
        for i, n in enumerate(chord):
            n.staff = 1 if i < best else 0
        if best < len(chord):
            upper = .7 * upper + .3 * float(np.mean([n.pitch for n in chord[best:]]))
        if best:
            lower = .7 * lower + .3 * float(np.mean([n.pitch for n in chord[:best]]))
        if upper - lower < 7:
            upper, lower = upper + 2, lower - 2


# ====================================================================== keeping notes
def remove(notes, why: str, stats: Counter) -> None:
    for n in notes:
        if not n.removed:
            n.removed = why
            stats[why] += 1


def clean_rules(notes: list[Note], stats: Counter) -> None:
    """Duplicates (same part, onset and pitch), ghosts (short notes an octave, twelfth or two octaves above a longer
    note that starts with them, with no neighbour in their own register) and blips (very short, and alone in their
    register: not part of a run or an ornament)."""
    groups = defaultdict(list)
    for n in notes:
        if not n.removed:
            groups[(n.part, n.on, n.pitch)].append(n)
    for group in groups.values():
        if len(group) > 1:
            group.sort(key=lambda n: -n.length)
            remove(group[1:], 'duplicate', stats)
    for part_notes in _by_part(notes).values():
        part_notes.sort(key=lambda n: n.start)
        for i, n in enumerate(part_notes):
            if n.removed or n.length >= .3:
                continue
            nearby = part_notes[max(0, i - 24):i + 24]
            # a real note an octave above another usually belongs to a line: a neighbour in its register
            if any(m is not n and not m.removed and .04 < abs(m.start - n.start) < .5
                   and abs(m.pitch - n.pitch) <= 4 for m in nearby):
                continue
            for m in nearby:
                if m is not n and not m.removed and abs(m.start - n.start) <= .04 \
                        and n.pitch - m.pitch in (12, 19, 24, 28, 31) and n.length < .6 * m.length:
                    remove([n], 'ghost', stats)
                    break
        for i, n in enumerate(part_notes):
            if n.removed:
                continue
            if n.length < .045:
                remove([n], 'blip', stats)
            elif n.length < .09 and not any(
                    m is not n and not m.removed and abs(m.start - n.start) < .3 and abs(m.pitch - n.pitch) <= 5
                    for m in part_notes[max(0, i - 16):i + 16]):
                remove([n], 'blip', stats)


def clean_harmony(notes: list[Note], chords: dict[int, set[int]], beat_quarters: F, seconds_per_quarter: float,
                  stats: Counter) -> None:
    """Short notes that are neither chord tones (Cantelvio Compose's harmonic analysis, per sixteenth step) nor on a stepwise
    line (a note of the same part a step away within three quarters of a beat), and whose pitch class the part does
    not play within two beats either (passing and neighbour figures of an accompaniment come back; noise does not);
    the top line (no higher note sounding when it starts) is always kept."""
    live = [n for n in notes if not n.removed]
    short = min(.2, .5 * float(beat_quarters) * seconds_per_quarter)
    window = beat_quarters * F(3, 4)
    for part_notes in _by_part(notes).values():
        part_notes.sort(key=lambda n: n.on)
        onsets = [n.on for n in part_notes]
        for n in part_notes:
            if n.removed or n.length >= short:
                continue
            tones = chords.get(int(n.on * 4))
            if not tones or n.pitch % 12 in tones:
                continue
            if not any(m.pitch > n.pitch and m.on <= n.on < m.on + m.dur for m in live):
                continue                                                   # the top line
            lo, hi = bisect_left(onsets, n.on - window), bisect_right(onsets, n.on + window)
            if any(m is not n and not m.removed and 1 <= abs(m.pitch - n.pitch) <= 2 for m in part_notes[lo:hi]):
                continue                                                   # a stepwise line
            lo, hi = bisect_left(onsets, n.on - 2 * beat_quarters), bisect_right(onsets, n.on + 2 * beat_quarters)
            if not any(m is not n and not m.removed and m.pitch % 12 == n.pitch % 12 for m in part_notes[lo:hi]):
                remove([n], 'off-harmony', stats)


def _by_part(notes: list[Note]) -> dict[int, list[Note]]:
    out = defaultdict(list)
    for n in notes:
        if not n.removed:
            out[n.part].append(n)
    return out


def tidy_durations(notes: list[Note], stats: Counter) -> None:
    """Per staff: notes of one onset share a duration when they differ by at most a sixteenth; a same-pitch note
    ends where the next one starts."""
    staves = defaultdict(list)
    for n in notes:
        if not n.removed:
            staves[(n.part, n.staff)].append(n)
    for staff_notes in staves.values():
        chords = defaultdict(list)
        for n in staff_notes:
            chords[n.on].append(n)
        onsets = sorted(chords)
        for i, on in enumerate(onsets):
            chord = chords[on]
            durs = Counter(n.dur for n in chord)
            if len(durs) > 1 and max(durs) - min(durs) <= F(1, 4):
                common = max(durs, key=lambda d: (durs[d], d))
                for n in chord:
                    n.dur = common
            if i + 1 < len(onsets):
                nxt = onsets[i + 1]
                for n in chord:
                    if nxt < n.on + n.dur and any(m.pitch == n.pitch for m in chords[nxt]):
                        n.dur = nxt - n.on


def legato(notes: list[Note], stats: Counter) -> None:
    """Within a voice, a chord that stops short of the next one by at most a sixteenth, or by less than a third of
    its own length, lasts until it (transcribed releases come early more often than late)."""
    voices = defaultdict(lambda: defaultdict(list))
    for n in notes:
        if not n.removed:
            voices[(n.part, n.staff, n.voice)][n.on].append(n)
    for chords in voices.values():
        onsets = sorted(chords)
        for on, nxt in zip(onsets, onsets[1:]):
            for n in chords[on]:
                gap = nxt - (n.on + n.dur)
                if 0 < gap and (gap <= F(1, 4) or gap < n.dur / 3):
                    n.dur = nxt - n.on
                    stats['legato'] += 1


def assign_voices(notes: list[Note], stats: Counter, voices: int = 4) -> None:
    """Voices 0..3 per staff: chords (same onset and duration) go to the first free voice, higher chords first;
    when no voice is free the one that ends first is cut short."""
    staves = defaultdict(lambda: defaultdict(list))
    for n in notes:
        if not n.removed:
            staves[(n.part, n.staff)][(n.on, n.dur)].append(n)
    for events in staves.values():
        ends = [F(-1)] * voices
        last: list[list[Note] | None] = [None] * voices
        for (on, dur), chord in sorted(events.items(), key=lambda kv: (kv[0][0], -max(n.pitch for n in kv[1]))):
            free = [v for v in range(voices) if ends[v] <= on]
            if free:
                v = free[0]
            else:
                v = min(range(voices), key=lambda x: ends[x])
                prev = last[v]
                if not prev or prev[0].on >= on:
                    remove(chord, 'too many voices', stats)
                    continue
                for p in prev:
                    p.dur = on - p.on
                stats['shortened'] += len(prev)
            for n in chord:
                n.voice = v
            ends[v] = on + dur
            last[v] = chord


# ====================================================================== key and spelling
def estimate_key(notes: list[Note]) -> tuple[int, str]:
    """(fifths, mode) from the duration-weighted pitch-class profile (Krumhansl-Kessler)."""
    hist = np.zeros(12)
    for n in notes:
        if not n.removed:
            hist[n.pitch % 12] += max(n.length, .05)
    if not hist.any():
        return 0, 'major'
    best = None
    for tonic in range(12):
        for mode, profile in (('major', MAJOR_PROFILE), ('minor', MINOR_PROFILE)):
            r = float(np.corrcoef(hist, np.roll(profile, tonic))[0, 1])
            if best is None or r > best[0]:
                best = (r, tonic, mode)
    _, tonic, mode = best
    major_tonic = (tonic + 3) % 12 if mode == 'minor' else tonic
    fifths = (major_tonic * 7) % 12
    if fifths > 6 or (fifths == 6 and mode == 'major'):
        fifths -= 12
    return int(fifths), mode


def spell(pitch: int, fifths: int, mode: str) -> tuple[str, int, int]:
    """(step, alter, octave) of a MIDI pitch in a key: scale notes as in the key signature; others as sharps in
    sharp keys and flats in flat keys, except the raised seventh of a minor key."""
    tonic = (fifths * 7) % 12                         # major tonic
    scale = {}
    first = STEPS.index('CGDAEBF'[fifths % 7] if fifths >= 0 else 'CFBEADG'[-fifths % 7])
    for degree in range(7):
        step = (first + degree) % 7
        pc = (tonic + (0, 2, 4, 5, 7, 9, 11)[degree]) % 12
        scale[pc] = (STEPS[step], (pc - STEP_PC[step] + 6) % 12 - 6)
    pc = pitch % 12
    if pc in scale:
        step, alter = scale[pc]
    else:
        minor_tonic = (tonic + 9) % 12
        if mode == 'minor' and pc == (minor_tonic + 11) % 12:      # raised seventh
            lower = scale[(pc - 1) % 12]
            step, alter = lower[0], lower[1] + 1
        elif fifths >= 0:
            lower = scale.get((pc - 1) % 12) or (STEPS[STEP_PC.index((pc - 1) % 12)], 0)
            step, alter = lower[0], lower[1] + 1
        else:
            upper = scale.get((pc + 1) % 12) or (STEPS[STEP_PC.index((pc + 1) % 12)], 0)
            step, alter = upper[0], upper[1] - 1
    octave = (pitch - alter - STEP_PC[STEPS.index(step)]) // 12 - 1
    return step, alter, octave


def written(step: str, alter: int, octave: int, transposition: tuple[int, int]) -> tuple[str, int, int]:
    """Written spelling of a sounding pitch for an instrument whose sounding = written + transposition."""
    diatonic, chromatic = transposition
    index = STEPS.index(step) + 7 * octave - diatonic
    w_step, w_octave = STEPS[index % 7], index // 7
    natural = 12 * (w_octave + 1) + STEP_PC[STEPS.index(w_step)]
    sounding = 12 * (octave + 1) + STEP_PC[STEPS.index(step)] + alter
    return w_step, sounding - chromatic - natural, w_octave


# ====================================================================== the pipeline
def parse_metre(text: str) -> tuple[int, bool]:
    """'3/4' -> (3 beats, simple); '6/8' -> (2 beats, compound)."""
    beats, _, unit = text.partition('/')
    n, d = int(beats), int(unit)
    if d == 8 and n % 3 == 0 and n > 3:
        return n // 3, True
    if d == 4:
        return n, False
    if d == 2:
        return 2 * n, False
    raise ValueError(f'unsupported metre {text} (use x/4, or 6/8, 9/8, 12/8)')


def transcription_to_score(doc: dict, *, chords_model=None, keep_all: bool = False, piano: bool = False,
                           title: str | None = None, metre_override: str | None = None, filler=None) -> Score:
    """Build a Score from an ailegro.transcription/1 document. `chords_model`: (harmonizer module, model, info) of
    Cantelvio Compose's harmonic-analysis model, or None for the rules only; `keep_all` skips the cleanup; `piano` puts
    everything on one piano part; `metre_override` ('3/4', '6/8', ...) replaces the metre read from the beats;
    `filler(notes, score, chords, seconds)` may add the notes the transcription missed (note_filler_v1.Filler)
    after the cleanup, before hands, durations and voices are settled (`seconds`: score time in quarters ->
    seconds of the recording)."""
    if doc.get('schema') != SCHEMA:
        raise ValueError(f'expected {SCHEMA}')
    raw = [Note(float(s), float(e), int(p), str(i)) for s, e, p, i in doc['notes'] if float(e) > float(s)]
    if not raw:
        raise ValueError('the transcription has no notes')
    if piano:
        for n in raw:
            if n.instrument != 'drums':
                n.instrument = 'acoustic_piano'
    beats = doc.get('beats') or []
    if len(beats) < 4:                                   # no beats tracked: a steady 100 bpm grid
        beats = list(np.arange(0., max(n.end for n in raw) + 1.2, .6))
    beats = regularize_beats(beats, [n.start for n in raw])
    downbeats = doc.get('downbeats') or []
    per_bar, _ = metre(BeatMap(beats), downbeats)
    beat_map = BeatMap(fit_bars(beats, downbeats, per_bar))
    lag = onset_lag([n.start for n in raw], beat_map)
    for n in raw:
        n.start, n.end = n.start - lag, n.end - lag
    per_bar, phase = metre(beat_map, downbeats)
    forced = parse_metre(metre_override) if metre_override else None
    if forced and forced[0] != per_bar:
        per_bar = forced[0]
        idx = np.round(beat_map.beat(np.asarray(doc.get('downbeats') or [beat_map.times[0]], float))).astype(int)
        phase = int(Counter((idx % per_bar).tolist()).most_common(1)[0][0])

    # rhythm: a subdivision per tracked beat (per instrument, so a triplet accompaniment under a duple melody
    # keeps both)
    starts = beat_map.beat([n.start for n in raw])
    groups, weights = _onset_groups(starts, raw)
    first, last = min(groups), max(groups)
    simple = _viterbi_subdivisions(groups, first, last, SIMPLE, beat_map.seconds_per_beat, weights)
    busy = [k for k in groups if len(groups[k]) >= 2]
    compound = forced[1] if forced else len(busy) >= 8 and sum(simple[k] in TRIPLET for k in busy) / len(busy) > .5
    table = COMPOUND if compound else SIMPLE
    subdivision = _viterbi_subdivisions(groups, first, last, COMPOUND, beat_map.seconds_per_beat, weights) \
        if compound else simple
    # runs keep their notes in order and evenly spaced, and fix the grid of the beats they go through
    fixed: dict[str, dict[int, int]] = defaultdict(dict)
    runs = find_runs(raw) if RUNS else []
    placed: dict[int, F] = {}
    for r, run in enumerate(runs):
        spb = float(np.median([beat_map.seconds_per_beat(math.floor(starts[i])) for i in run]))
        found = run_positions([float(starts[i]) for i in run], spb, table)
        runs[r] = run[:len(found)]
        for i, (x, pos) in zip(run, found):
            raw[i].run, raw[i].grid = r, x
            placed[i] = pos
            fixed[raw[i].instrument][math.floor(pos)] = x
    grids: dict[str, dict[int, int]] = {}
    by_instrument = defaultdict(list)
    for i, n in enumerate(raw):
        by_instrument[n.instrument].append(i)
    if (PER_INSTRUMENT_GRIDS and len(by_instrument) > 1) or fixed:
        for instrument, idx in by_instrument.items():
            if len(idx) >= PER_INSTRUMENT_MIN or instrument in fixed:
                g, w = _onset_groups(starts[idx], [raw[i] for i in idx])
                grids[instrument] = _viterbi_subdivisions(g, first, last, table, beat_map.seconds_per_beat, w,
                                                          fixed.get(instrument))
    beat_quarters = F(3, 2) if compound else F(1)
    on_beats = [placed[i] if i in placed else snap(b, grids.get(n.instrument, subdivision))
                for i, (b, n) in enumerate(zip(starts, raw))]
    end_grid = (lambda n: subdivision) if END_GLOBAL_GRID else (lambda n: grids.get(n.instrument, subdivision))
    end_beats = [snap(b, end_grid(n)) for b, n in zip(beat_map.beat([n.end for n in raw]), raw)]
    for run in runs:                             # a run note lasts until the next one (passage work is legato),
        for a, b in zip(run, run[1:]):           # not across a grid point where a note is missing
            if RUN_LEGATO_ACROSS_GAPS or on_beats[b] - on_beats[a] <= F(1, raw[a].grid):
                end_beats[a] = on_beats[b]

    # bars: downbeats at phase + j * per_bar; a pickup when the first bar would start with a beat or more of rest
    # (the first note is the first one that is not a short blip)
    first_on = min((a for a, n in zip(on_beats, raw) if n.length >= .1), default=min(on_beats))
    bar_start = phase + per_bar * math.floor((first_on - phase) / per_bar)
    if first_on - bar_start >= 1:
        origin = math.floor(first_on)
        pickup_beats = bar_start + per_bar - origin
    else:
        origin, pickup_beats = bar_start, 0
    for n, a, b in zip(raw, on_beats, end_beats):
        n.on = (a - origin) * beat_quarters
        grid = grids.get(n.instrument, subdivision)
        n.dur = max((b - a) * beat_quarters, beat_quarters / grid.get(math.floor(a), 4))

    parts, part_stats = assign_parts(raw)
    notes = [n for n in raw if n.part >= 0]
    seconds_per_quarter = float(np.median(np.diff(beat_map.times))) / float(beat_quarters)
    pickup = F(pickup_beats) * beat_quarters
    end = max(n.on + n.dur for n in notes)
    bar_length = per_bar * beat_quarters
    bars = (1 if pickup else 0) + max(1, math.ceil((end - pickup) / bar_length))
    score = Score(title or Path(str(doc.get('audio') or 'transcription')).stem, per_bar, compound, beat_quarters,
                  pickup, bars, 60. / seconds_per_quarter, 0, 'major', parts, notes,
                  {k - origin: s for k, s in subdivision.items()})
    if doc.get('downbeats'):
        score.downbeat = (int(round(float(beat_map.beat(doc['downbeats'][0])))) - origin) * beat_quarters
    stats = Counter()
    if not keep_all:
        clean_rules(notes, stats)
        fit_instruments(notes, parts, stats)
    score.fifths, score.mode = estimate_key(notes)
    chords = None
    if not keep_all and chords_model is not None:
        chords = analysed_chords(score, chords_model, notes)
        clean_harmony(notes, chords, beat_quarters, seconds_per_quarter, stats)
    if RUN_REPAIR and not keep_all:
        repair_runs(notes, score, chords, stats)
    if filler is not None and not keep_all:
        index = np.arange(len(beat_map.times), dtype=float)

        def seconds(on_quarters):
            return np.interp(np.asarray(on_quarters, float) / float(beat_quarters) + origin, index, beat_map.times)

        for why, count in filler(notes, score, chords, seconds).items():
            stats[why] += count
    for i, info in enumerate(parts):
        if info.staves == 2:
            split_hands([n for n in notes if n.part == i and not n.removed])
    tidy_durations(notes, stats)
    assign_voices(notes, stats)
    legato(notes, stats)
    adjusted, added = ('legato', 'shortened', 'run pitch'), ('run gap', 'filler')
    score.report = {'notes': len(raw), 'kept': sum(not n.removed and not n.added for n in notes),
                    'removed': {k: v for k, v in stats.items() if k not in adjusted + added},
                    'adjusted': {k: stats[k] for k in adjusted}, 'added': {k: stats[k] for k in added},
                    'runs': len({n.run for n in notes if n.run >= 0 and not n.removed}), 'lagSeconds': round(lag, 4),
                    'metre': '/'.join(map(str, score.time_signature)), 'qpm': round(score.qpm, 1),
                    'pickupQuarters': str(pickup), 'bars': bars, 'key': [score.fifths, score.mode],
                    'harmonyCheck': chords is not None, 'noteFiller': filler is not None and not keep_all,
                    'parts': [p.instrument for p in parts], **part_stats}
    return score


def analysed_chords(score: Score, chords_model, notes: list[Note]) -> dict[int, set[int]]:
    """Chord tones per sixteenth step of score time from Cantelvio Compose's harmonic-analysis model (melody = the top
    line, texture = every note)."""
    module, model, info = chords_model
    live = [n for n in notes if not n.removed]
    if not live:
        return {}
    shapes = [(score.bar_end(b) - score.bar_start(b), score.time_signature, score.fifths) for b in range(score.bars)]
    texture = [(n.on, n.dur, n.pitch) for n in live]
    top = {}
    for n in live:
        if n.pitch > top.get(n.on, (0, -1))[1]:
            top[n.on] = (n.dur, n.pitch)
    melody = [(on, d, p) for on, (d, p) in sorted(top.items())]
    _, path = module.harmonize(model, info, melody, shapes, texture=texture)
    tones = {}
    for step, cls in enumerate(path):
        root, quality = int(cls) % 12, int(cls) // 12
        tones[step] = {(root + i) % 12 for i in module.QUALITIES[quality]['intervals']}
    return tones


def load_chords_model(path: str | None):
    """Cantelvio Compose's harmonic-analysis model (harmonizer v2), or None when torch or the weights are missing."""
    if path == 'none':
        return None
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import harmonizer_v1 as hz
    except ImportError:
        return None
    weights = Path(path) if path else hz.ANALYSIS_WEIGHTS
    if not weights.is_file():
        return None
    model, info = hz.load(weights)
    return hz, model, info


def load_filler(path: str | None, threshold: float | None = None):
    """Cantelvio Compose's note filler (note_filler_v1.Filler), or None when torch or the weights are missing ('none': off)."""
    if path == 'none':
        return None
    sys.modules.setdefault('audio_to_score', sys.modules[__name__])     # run as a script: one module, one Note
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import note_filler_v1 as nf
    except ImportError:
        return None
    return nf.load_filler(path, threshold)


# ====================================================================== MusicXML
NOTE_TYPES = [(96, 'whole', 0), (84, 'half', 2), (72, 'half', 1), (48, 'half', 0), (42, 'quarter', 2),
              (36, 'quarter', 1), (24, 'quarter', 0), (21, 'eighth', 2), (18, 'eighth', 1), (12, 'eighth', 0),
              (9, '16th', 1), (6, '16th', 0), (3, '32nd', 0)]
TRIPLET_TYPES = [(16, 'quarter', 0), (12, 'eighth', 1), (8, 'eighth', 0), (6, '16th', 1), (4, '16th', 0),
                 (2, '32nd', 0)]          # written values under 3:2 (their sounding length in divisions)
TUPLET = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>'


def _divisions(time: F) -> int:
    value = time * DIVISIONS
    if value.denominator != 1:
        raise ValueError(f'{time} is not on the {DIVISIONS}-per-quarter grid')
    return int(value)


def pieces(start: int, length: int, beat: int, triplet_beats: set[int]) -> list[tuple[int, int, str, int, bool]]:
    """Split [start, start + length) (divisions from the bar start) into notatable values (position, duration,
    type, dots, triplet). Triplet beats are written beat by beat with 3:2 values; elsewhere the values run to the
    next triplet beat, and an off-beat start first finishes its beat."""
    out, pos, end = [], start, start + length
    while pos < end:
        k = pos // beat
        beat_end = (k + 1) * beat
        if k in triplet_beats:
            stop = min(end, beat_end)
            values = _plain(stop - pos) if pos % beat == 0 and stop == beat_end else _triplet(stop - pos)
        else:
            stop = min([end] + [j * beat for j in triplet_beats if j * beat > pos])
            if pos % beat and stop > beat_end:
                stop = beat_end
            values = _plain(stop - pos)
        for d, kind, dots, trip in values:
            out.append((pos, d, kind, dots, trip))
            pos += d
    return out


def _plain(length: int) -> list[tuple[int, str, int, bool]]:
    out = []
    while length > 0:
        d, kind, dots = next((v for v in NOTE_TYPES if v[0] <= length), (length, '32nd', 0))
        if d == length and (length, kind, dots) not in NOTE_TYPES:     # off the duple grid (cannot happen)
            return out + _triplet(length)
        out.append((d, kind, dots, False))
        length -= d
    return out


def _triplet(length: int) -> list[tuple[int, str, int, bool]]:
    out = []
    while length > 0:
        value = next((v for v in TRIPLET_TYPES if v[0] <= length), None)
        if value is None:
            return out + [(length, '32nd', 0, False)]
        out.append((value[0], value[1], value[2], True))
        length -= value[0]
    return out


def musicxml(score: Score) -> str:
    """The score as MusicXML 4.0 (partwise)."""
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
             '"http://www.musicxml.org/dtds/partwise.dtd">',
             '<score-partwise version="4.0">',
             f'<work><work-title>{escape(score.title)}</work-title></work>',
             '<identification><encoding><software>Cantelvio Compose audio_to_score (transcribed audio)</software>'
             '</encoding></identification>', '<part-list>']
    for i, p in enumerate(score.parts):
        lines.append(f'<score-part id="P{i + 1}"><part-name>{escape(p.name)}</part-name>'
                     f'<score-instrument id="P{i + 1}-I1"><instrument-name>{escape(p.name)}</instrument-name>'
                     f'<instrument-sound>{p.sound}</instrument-sound></score-instrument>'
                     f'<midi-instrument id="P{i + 1}-I1"><midi-program>{p.program}</midi-program></midi-instrument>'
                     '</score-part>')
    lines.append('</part-list>')
    beat = _divisions(score.beat_quarters)
    kept = [n for n in score.notes if not n.removed]
    for i, p in enumerate(score.parts):
        lines.append(f'<part id="P{i + 1}">')
        part_notes = [n for n in kept if n.part == i]
        for bar in range(score.bars):
            b0, b1 = score.bar_start(bar), score.bar_end(bar)
            length = _divisions(b1 - b0)
            implicit = ' implicit="yes"' if score.pickup and bar == 0 else ''
            lines.append(f'<measure number="{bar if score.pickup else bar + 1}"{implicit}>')
            if bar == 0:
                lines.append(_attributes(score, p))
                lines.append('<direction placement="above"><direction-type><metronome><beat-unit>quarter'
                             f'</beat-unit><per-minute>{round(score.qpm)}</per-minute></metronome>'
                             f'</direction-type><sound tempo="{round(score.qpm, 1)}"/></direction>')
            written_any = False
            for staff in range(p.staves):
                for voice in range(4):
                    items = _voice_items(part_notes, staff, voice, b0, b1)
                    if not items and voice > 0:
                        continue
                    if written_any:
                        lines.append(f'<backup><duration>{length}</duration></backup>')
                    triplets = set() if score.compound else _triplet_beats(items, b0, beat)
                    lines.extend(_write_voice(items, b0, length, staff, voice, p, score, beat, triplets))
                    written_any = True
            if bar == score.bars - 1:
                lines.append('<barline location="right"><bar-style>light-heavy</bar-style></barline>')
            lines.append('</measure>')
        lines.append('</part>')
    lines.append('</score-partwise>')
    return '\n'.join(lines) + '\n'


def _attributes(score: Score, p: PartInfo) -> str:
    beats, beat_type = score.time_signature
    fifths = score.fifths
    if p.transposition:
        shift = (-p.transposition[1] * 7) % 12
        fifths += shift if shift <= 6 else shift - 12
        fifths = fifths - 12 if fifths > 7 else fifths + 12 if fifths < -7 else fifths
    out = [f'<attributes><divisions>{DIVISIONS}</divisions>',
           f'<key><fifths>{fifths}</fifths><mode>{score.mode}</mode></key>',
           f'<time><beats>{beats}</beats><beat-type>{beat_type}</beat-type></time>']
    if p.staves > 1:
        out.append(f'<staves>{p.staves}</staves>')
    for s, clef in enumerate(p.clef):
        number = f' number="{s + 1}"' if p.staves > 1 else ''
        line, _, octave = clef[1:].partition('-')
        change = f'<clef-octave-change>-{octave}</clef-octave-change>' if octave else ''
        out.append(f'<clef{number}><sign>{clef[0]}</sign><line>{line}</line>{change}</clef>')
    if p.transposition:
        d, c = p.transposition
        octaves = 0
        while c <= -12 and d <= -7:
            c, d, octaves = c + 12, d + 7, octaves - 1
        out.append(f'<transpose><diatonic>{d}</diatonic><chromatic>{c}</chromatic>'
                   + (f'<octave-change>{octaves}</octave-change>' if octaves else '') + '</transpose>')
    out.append('</attributes>')
    return ''.join(out)


def _triplet_beats(items, b0: F, beat: int) -> set[int]:
    """Beats of the bar in which this voice starts or ends a note off the duple grid (a triplet position): each
    voice gets its own tuplets, so triplets in the accompaniment and sixteenths in the melody both stay right."""
    out = set()
    for start, end, *_ in items:
        for t in (start, end):
            d = _divisions(max(t - b0, F(0)))
            if d % 3:
                out.add(d // beat)
    return out


def _voice_items(part_notes: list[Note], staff: int, voice: int, b0: F, b1: F):
    """Chords of one voice sounding in [b0, b1): (start, end, notes low to high, tied in, tied out)."""
    chords = defaultdict(list)
    for n in part_notes:
        if n.staff == staff and n.voice == voice and n.on < b1 and n.on + n.dur > b0:
            chords[(n.on, n.dur)].append(n)
    return [(max(on, b0), min(on + dur, b1), sorted(chord, key=lambda n: n.pitch), on < b0, on + dur > b1)
            for (on, dur), chord in sorted(chords.items())]


def _write_voice(items, b0: F, length: int, staff: int, voice: int, p: PartInfo, score: Score, beat: int,
                 triplet_beats: set[int]) -> list[str]:
    number = staff * 4 + voice + 1
    staff_tag = f'<staff>{staff + 1}</staff>' if p.staves > 1 else ''
    if not items:
        return [f'<note><rest measure="yes"/><duration>{length}</duration><voice>{number}</voice>{staff_tag}'
                '</note>']
    entries = []                         # (position, duration, type, dots, triplet, chord, tie in, tie out)
    pos = 0
    for start, end, chord, tied_in, tied_out in items:
        s, e = max(_divisions(start - b0), pos), _divisions(end - b0)
        if s > pos:
            entries += [(*x, None, False, False) for x in pieces(pos, s - pos, beat, triplet_beats)]
        if e <= s:
            continue
        values = pieces(s, e - s, beat, triplet_beats)
        for j, x in enumerate(values):
            entries.append((*x, chord, tied_in or j > 0, tied_out or j < len(values) - 1))
        pos = e
    if pos < length:
        entries += [(*x, None, False, False) for x in pieces(pos, length - pos, beat, triplet_beats)]
    lines = []
    for i, (position, d, kind, dots, trip, chord, tie_in, tie_out) in enumerate(entries):
        bracket = ''
        if trip:
            k = position // beat
            prev_same = i > 0 and entries[i - 1][4] and entries[i - 1][0] // beat == k
            next_same = i + 1 < len(entries) and entries[i + 1][4] and entries[i + 1][0] // beat == k
            bracket = ('<tuplet type="start" bracket="yes"/>' if not prev_same else '') + \
                      ('<tuplet type="stop"/>' if not next_same else '')
        tail = ('<dot/>' * dots) + (TUPLET if trip else '') + staff_tag
        if chord is None:
            notations = f'<notations>{bracket}</notations>' if bracket else ''
            lines.append(f'<note><rest/><duration>{d}</duration><voice>{number}</voice><type>{kind}</type>'
                         f'{tail}{notations}</note>')
            continue
        for c, n in enumerate(chord):
            step, alter, octave = spell(n.pitch, score.fifths, score.mode)
            if p.transposition:
                step, alter, octave = written(step, alter, octave, p.transposition)
            ties = ('<tie type="stop"/>' if tie_in else '') + ('<tie type="start"/>' if tie_out else '')
            tied = ('<tied type="stop"/>' if tie_in else '') + ('<tied type="start"/>' if tie_out else '')
            marks = tied + (bracket if c == 0 else '')
            lines.append('<note>' + ('<chord/>' if c else '')
                         + f'<pitch><step>{step}</step>' + (f'<alter>{alter}</alter>' if alter else '')
                         + f'<octave>{octave}</octave></pitch><duration>{d}</duration>{ties}<voice>{number}</voice>'
                         + f'<type>{kind}</type>{tail}' + (f'<notations>{marks}</notations>' if marks else '')
                         + '</note>')
    return lines


# ====================================================================== command line
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('transcription', type=Path, help='ailegro.transcription/1 JSON (audio_transcribe_muscriptor.py)')
    parser.add_argument('--output', type=Path, help='MusicXML file (default: next to the input, .musicxml)')
    parser.add_argument('--report', type=Path, help='JSON report of what was kept, removed and why')
    parser.add_argument('--analyzer', default=None,
                        help="harmonic-analysis weights for the harmony check (default: Cantelvio Compose's harmonizer v2 when "
                             "present; 'none' = rules only)")
    parser.add_argument('--filler', default=None,
                        help="note-filler weights that add the notes the transcription most likely missed (default: "
                             "Cantelvio Compose's note filler v1 when present; 'none' = off)")
    parser.add_argument('--filler-threshold', type=float,
                        help='probability a missing note needs to be added (default: the one tuned with the weights; '
                             'higher adds fewer)')
    parser.add_argument('--keep-all', action='store_true', help='keep every transcribed note (no cleanup)')
    parser.add_argument('--piano', action='store_true', help='one piano part (a piano reduction of every instrument)')
    parser.add_argument('--metre', help="force the metre, e.g. 3/4 or 6/8 (default: from the tracked beats)")
    parser.add_argument('--title')
    args = parser.parse_args()
    doc = json.loads(args.transcription.read_text())
    chords_model = None if args.keep_all else load_chords_model(args.analyzer)
    filler = None if args.keep_all else load_filler(args.filler, args.filler_threshold)
    score = transcription_to_score(doc, chords_model=chords_model, keep_all=args.keep_all, piano=args.piano,
                                   title=args.title, metre_override=args.metre, filler=filler)
    output = args.output or args.transcription.with_name(
        args.transcription.name.replace('.notes.json', '').replace('.json', '') + '.musicxml')
    output.write_text(musicxml(score), encoding='utf-8')
    report = score.report
    print(json.dumps({'output': str(output), **report}, ensure_ascii=False))
    if args.report:
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
