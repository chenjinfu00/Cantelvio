#!/usr/bin/env python3
"""Align explicit Lieder tempo marks to existing joint-model sixteenth steps.

The aligned QPM is a continuous conditional feature with a known-label mask,
not a unique 'correct BPM' class. No absent mark is filled with 120 BPM.
"""

import argparse
from collections import Counter, defaultdict
from fractions import Fraction
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np

from joint_data import load_corpus


ROOT = Path(__file__).resolve().parents[1]


def align_piece(piece, tempo_events):
    bars = piece['arrays']['bar']
    n = len(bars)
    values = np.full(n, np.nan, np.float32)
    known = np.zeros(n, np.bool_)
    change = np.zeros(n, np.bool_)
    starts = {int(bars[i]): i for i in range(n - 1, -1, -1) if bars[i] >= 0}
    conflicts = defaultdict(set)
    for event in tempo_events:
        conflicts[(event['bar'], event['offsetQuarter'])].add(event['value'])
    mapped = []
    skipped = Counter()
    for event in tempo_events:
        bar = event['bar']
        if len(conflicts[(bar, event['offsetQuarter'])]) > 1:
            skipped['conflicting position'] += 1
            continue
        if bar not in starts:
            skipped['bar absent from joint corpus'] += 1
            continue
        exact = starts[bar] + Fraction(event['offsetQuarter']) * 4
        step = (exact.numerator + exact.denominator - 1) // exact.denominator
        if not 0 <= step < n:
            skipped['mark beyond joint timeline'] += 1
            continue
        if step > starts[bar] and int(bars[step - 1]) != bar:
            skipped['mark beyond source measure'] += 1
            continue
        mapped.append((step, float(event['value'])))
    # Multiple directions in different parts may report the same tempo.
    for step, qpm in sorted(set(mapped)):
        if change[step] and values[step] != qpm:
            skipped['different tempi in one sixteenth step'] += 1
            known[step:] = False
            change[step] = False
            continue
        values[step:] = qpm
        known[step:] = True
        change[step] = True
    return values, known, change, dict(skipped)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def build(sidecar, corpus, output):
    if output.exists() or output.with_suffix('.json').exists():
        raise FileExistsError(f'will not overwrite tempo features: {output}')
    records = {}
    with gzip.open(sidecar, 'rt', encoding='utf-8') as stream:
        for line in stream:
            record = json.loads(line)
            if record['source'] == 'OpenScore Lieder':
                if record['scoreId'] in records:
                    raise ValueError(f'duplicate tempo score: {record["scoreId"]}')
                records[record['scoreId']] = record
    pieces = load_corpus(corpus)
    if len(records) != len(pieces):
        raise ValueError('tempo sidecar and joint corpus have different piece counts')
    offsets = [0]
    qpm, known, change = [], [], []
    skipped = Counter()
    for piece in pieces:
        meta = piece['meta']
        row = records.get(meta['scoreId'])
        if row is None or row['workId'] != meta['workId'] or row['split'] != meta['split']:
            raise ValueError(f'tempo source identity/split mismatch: {meta["scoreId"]}')
        events = [e for e in row['events'] if e['kind'] == 'tempo-qpm']
        v, k, c, issues = align_piece(piece, events)
        qpm.append(v)
        known.append(k)
        change.append(c)
        offsets.append(offsets[-1] + len(v))
        skipped.update(issues)
    data = {'offsets': np.asarray(offsets, np.int64),
            'qpm': np.concatenate(qpm), 'known': np.concatenate(known),
            'change': np.concatenate(change)}
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output, **data)
    audit = {'schema': 'ailegro-joint-tempo-features-v1',
             'corpusSha256': digest(corpus), 'sidecarSha256': digest(sidecar),
             'pieces': len(pieces), 'steps': int(offsets[-1]),
             'knownSteps': int(data['known'].sum()), 'changeSteps': int(data['change'].sum()),
             'skipped': dict(skipped),
             'notes': ['qpm is NaN when no explicit mark is active',
                       'known masks the tempo supervision, not the music tokens',
                       'at non-grid marks the next sixteenth step receives the new QPM',
                       'original Lieder work-level split is preserved by piece order']}
    output.with_suffix('.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(audit, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--sidecar', type=Path, default=ROOT / 'data/performance-labels-v1/score-events.jsonl.gz')
    ap.add_argument('--corpus', type=Path, default=ROOT / 'data/joint/lieder-joint.npz')
    ap.add_argument('--output', type=Path, default=ROOT / 'data/performance-labels-v1/lieder-joint-tempo.npz')
    args = ap.parse_args()
    build(args.sidecar, args.corpus, args.output)
