#!/usr/bin/env python3
"""Build the frozen v3.1 time vocabulary from the approved training sources.

Pure Python (no torch): a minimal MIDI reader for the SymphonyNet / MIDI-Library
members of the frozen membership file, and the score index for Lieder and the
classical scores. Bar positions, onset deltas within bars and durations are
snapped with four_pillar_v31_time.snap, weighted by the v3.1 source mix and the
most frequent values are kept. The script refuses to overwrite an existing file.
"""
from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import random
import sqlite3
import struct
import zlib
from collections import Counter
from fractions import Fraction
from pathlib import Path

from four_pillar_v31_time import VOCAB_SCHEMA, cluster_onsets, rule, snap, snap_duration

ROOT = Path(__file__).resolve().parents[1]


def paths(root: Path):
    return (root / 'orchestra/work/raw', root / 'data/MIDI-Library',
            root / 'data/four-pillar-midi-all-train-v1.json', root / 'data/four-pillar-score-all-train-v1.sqlite')


RAW, LOCAL, MEMBERSHIP, SCORES = paths(ROOT)
MIX = {'symphony-classical': .20, 'symphony-contemporary': .35, 'curated-midi': .10,
       'Lieder': .20, 'classical-scores': .15}


def _vlq(data: bytes, i: int) -> tuple[int, int]:
    value = 0
    while True:
        byte = data[i]
        i += 1
        value = (value << 7) | (byte & 127)
        if byte < 128:
            return value, i


def read_midi(path: Path):
    """Return ticks per quarter, pitched notes (start, duration) and meter changes."""
    data = path.read_bytes()
    if data[:4] != b'MThd':
        raise ValueError('not a MIDI file')
    header = struct.unpack('>I', data[4:8])[0]
    _, tracks, division = struct.unpack('>HHH', data[8:14])
    if division & 0x8000 or division <= 0:
        raise ValueError('unsupported MIDI time division')
    i, notes, meters = 8 + header, [], {}
    for _ in range(tracks):
        if data[i:i + 4] != b'MTrk':
            break
        length = struct.unpack('>I', data[i + 4:i + 8])[0]
        j, end, tick, status, active = i + 8, i + 8 + length, 0, 0, {}
        while j < end:
            delta, j = _vlq(data, j)
            tick += delta
            byte = data[j]
            if byte == 0xFF:
                kind = data[j + 1]
                size, k = _vlq(data, j + 2)
                if kind == 0x58 and size >= 2:
                    meters[tick] = (data[k], 2 ** data[k + 1])
                j = k + size
                continue
            if byte in (0xF0, 0xF7):
                size, j = _vlq(data, j + 1)
                j += size
                continue
            if byte & 0x80:
                status, j = byte, j + 1
            kind, channel = status & 0xF0, status & 15
            if kind in (0xC0, 0xD0):
                j += 1
                continue
            first, second = data[j], data[j + 1]
            j += 2
            if channel == 9:
                continue
            if kind == 0x90 and second > 0:
                active.setdefault(first, []).append(tick)
            elif kind in (0x80, 0x90) and active.get(first):
                start = active[first].pop(0)
                if tick > start:
                    notes.append((start, tick - start))
        i = end
    return division, notes, meters


def midi_bars(division: int, notes, meters):
    """Bar start ticks and lengths, 4/4 when no time signature is present (as the loader)."""
    if not notes:
        return []
    last = max(s + d for s, d in notes)
    changes = sorted(meters.items()) or [(0, (4, 4))]
    if changes[0][0] != 0:
        changes.insert(0, (0, (4, 4)))
    bars = []
    for k, (tick, (num, den)) in enumerate(changes):
        stop = changes[k + 1][0] if k + 1 < len(changes) else last
        length = Fraction(num * 4 * division, den)
        cursor = Fraction(tick)
        while cursor < stop:
            bars.append((cursor, length))
            cursor += length
    return bars


def count_piece(onsets_by_bar, durations, positions: Counter, deltas: Counter, lengths: Counter, unsnapped: Counter,
                performance: bool = False):
    """Same rules as the v3.1 training windows (four_pillar_v31_data)."""
    for value in durations:
        snapped = snap_duration(value, performance)
        if snapped is None:
            unsnapped['duration'] += 1
            snapped = value
        lengths[snapped] += 1
    for onsets in onsets_by_bar:
        previous = Fraction(0)
        snapped_onsets = []
        clusters = cluster_onsets(onsets) if performance else None
        for value in onsets:
            if clusters is not None:
                value = clusters[value]
            snapped = snap(value)
            if snapped is None:
                unsnapped['position'] += 1
                snapped = value
            snapped_onsets.append(snapped)
        for value in sorted(snapped_onsets):
            positions[value] += 1
            deltas[value - previous] += 1
            previous = value


def sample_midi_rows(rows, rng: random.Random, per_source: int) -> dict:
    pools = {
        'symphony-classical': [r for r in rows if r['source'] == 'SymphonyNet' and '/classical/' in r['name']],
        'symphony-contemporary': [r for r in rows if r['source'] == 'SymphonyNet' and '/contemporary/' in r['name']],
        'curated-midi': [r for r in rows if r['source'] == 'MIDI-Library']}
    return {name: rng.sample(pool, min(per_source, len(pool))) for name, pool in pools.items()}


def empty_record() -> dict:
    return {'files': 0, 'positions': Counter(), 'deltas': Counter(), 'durations': Counter(), 'unsnapped': Counter()}


def count_midi_rows(sample, record: dict) -> dict:
    """Accumulate one list of MIDI members into `record` (order-independent counts)."""
    for row in sample:
        path = (RAW if row['source'] == 'SymphonyNet' else LOCAL) / row['name']
        try:
            division, notes, meters = read_midi(path)
        except (OSError, ValueError, IndexError, struct.error):
            record['unsnapped']['unreadable-file'] += 1
            continue
        bars = midi_bars(division, notes, meters)
        if not bars:
            continue
        record['files'] += 1
        starts = [b[0] for b in bars]
        by_bar = [[] for _ in bars]
        for start, _ in notes:
            b = bisect.bisect_right(starts, start) - 1
            by_bar[b].append((start - bars[b][0]) / division)
        count_piece(by_bar, [Fraction(d, division) for _, d in notes], record['positions'], record['deltas'],
                    record['durations'], record['unsnapped'], performance=True)
    return record


def score_counts():
    out = {s: empty_record() for s in ('Lieder', 'classical-scores')}
    db = sqlite3.connect(SCORES)
    try:
        for source, payload in db.execute("select source, payload from scores where split='train'"):
            try:
                piece = json.loads(payload)
            except (UnicodeDecodeError, json.JSONDecodeError):
                piece = json.loads(zlib.decompress(payload))
            record = out[source]
            record['files'] += 1
            measures = piece['measures']
            by_bar = [[] for _ in measures]
            durations = []
            for note in piece['notes']:
                if note.get('grace') or Fraction(note['dur']) <= 0:
                    continue
                by_bar[note['bar']].append(Fraction(note['on']) - Fraction(measures[note['bar']]['on']))
                durations.append(Fraction(note['dur']))
            count_piece(by_bar, durations, record['positions'], record['deltas'], record['durations'], record['unsnapped'])
    finally:
        db.close()
    return out


def finalize(counts: dict, size: int, seed: int, midi_per_source: int) -> dict:
    weighted = Counter()
    for source in MIX:
        record = counts[source]
        for field in ('deltas', 'durations', 'positions'):
            total = sum(record[field].values())
            for value, n in record[field].items():
                weighted[value] += MIX[source] * n / max(1, total) / 3
    ranked = sorted((v for v in weighted if v != 0), key=lambda v: (-weighted[v], v))
    chosen = {Fraction(0)} | set(ranked[:size - 1])
    coverage = {}
    for source in MIX:
        record = counts[source]
        coverage[source] = {'files': record['files'], 'unsnapped': dict(record['unsnapped'])}
        for field in ('deltas', 'durations', 'positions'):
            total = sum(record[field].values())
            coverage[source][field] = round(sum(n for v, n in record[field].items() if v in chosen) / max(1, total), 6)
    return {
        'schema': VOCAB_SCHEMA,
        'rule': {**rule(), 'note': 'scores: notated values with a preferred denominator stay exact, others snap to the '
                                   'simplest preferred fraction within tolerance. MIDI: chord spreading within the '
                                   'chord window joins the first onset and near-grid durations snap to simple values '
                                   'first. Vocabulary = most frequent resulting values (zero always included).'},
        'size': len(chosen), 'seed': seed, 'midiPerSource': midi_per_source, 'sourceMix': MIX,
        'builder': {'script': Path(__file__).name, 'sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
        'inputs': {'membershipSha256': hashlib.sha256(MEMBERSHIP.read_bytes()).hexdigest(),
                   'scoreIndexSha256': hashlib.sha256(SCORES.read_bytes()).hexdigest()},
        'coverage': coverage,
        'values': [str(v) for v in sorted(chosen)],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--size', type=int, default=384)
    parser.add_argument('--midi-per-source', type=int, default=1500)
    parser.add_argument('--seed', type=int, default=20261001)
    parser.add_argument('--root', type=Path, default=ROOT, help='training directory (default: this checkout)')
    args = parser.parse_args()
    global RAW, LOCAL, MEMBERSHIP, SCORES
    RAW, LOCAL, MEMBERSHIP, SCORES = paths(args.root.resolve())
    if args.output.exists():
        parser.error('refusing to overwrite an existing vocabulary')
    rows = json.loads(MEMBERSHIP.read_text())['rows']
    counts = {}
    for source, sample in sample_midi_rows(rows, random.Random(args.seed), args.midi_per_source).items():
        counts[source] = count_midi_rows(sample, empty_record())
    counts.update(score_counts())
    payload = finalize(counts, args.size, args.seed, args.midi_per_source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=1))
    print(json.dumps({'output': str(args.output), 'size': payload['size'], 'coverage': payload['coverage']}, indent=1))


if __name__ == '__main__':
    main()
