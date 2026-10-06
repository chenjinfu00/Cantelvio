#!/usr/bin/env python3
"""AugmentedNet chord labels for v3.1 training (opt-in; four_pillar_v31_tonal.py is not touched).

v3.1 learned two chord conventions: the OpenScore Lieder carry AugmentedNet analyses, everything else the rule-based
ChordTracker (about 65-80% of the training windows). This module lets training read AugmentedNet chords for the other
scores too, from a sidecar file built by

    an_label.py (AugmentedNet, Python 3.9 / TF 2.5)  ->  python four_pillar_v31_chords_an.py build ...

Sidecar `data/chords-augmentednet-v1.json.gz`: {score_id: [[offset_quarters, root_pc, quality], ...]} for the
classical scores (string quartets, orchestral). `install()` swaps `four_pillar_v31_data.analyze` for a version that
replaces the tracker's chords by these where the score is in the sidecar (keys stay with KeyTracker); other scores
are unchanged. Call `install()` in the training process and in every data worker.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from bisect import bisect_right
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIDECAR = ROOT / 'data/chords-augmentednet-v1.json.gz'
_CACHE: dict = {}


def load(path: Path = SIDECAR) -> dict:
    if path not in _CACHE:
        _CACHE[path] = json.loads(gzip.open(path, 'rt').read()) if path.exists() else {}
    return _CACHE[path]


def chords_for_bars(score, spans, first: int, last: int) -> dict[int, list[tuple[Fraction, int, int]]]:
    """{bar: [(offset, root, quality)]} for bars first..last: changes only; the first bar's first entry (offset 0)
    holds the chord in effect, like four_pillar_v31_tonal.lieder_chords."""
    onsets = [float(m.onset) for m in score.measures]
    starts = [s[0] for s in spans]
    out: dict[int, list] = {}
    previous = None
    for bar in range(first, last + 1):
        m = score.measures[bar]
        a, b = onsets[bar], onsets[bar] + float(m.duration)
        inside = [s for s in spans[bisect_right(starts, a - 1e-6):bisect_right(starts, b - 1e-6)]]
        if previous is None and (not inside or inside[0][0] > a + 1e-6):
            i = bisect_right(starts, a - 1e-6) - 1
            lead = spans[i] if i >= 0 else (spans[0] if spans else None)
            if lead is None:
                continue
            inside = [(a, lead[1], lead[2])] + inside
        for t, root, quality in inside:
            if (root, quality) == previous:
                continue
            offset = min(max(Fraction(t - a).limit_denominator(8), Fraction(0)), m.duration - Fraction(1, 8))
            out.setdefault(bar, []).append((offset, int(root), int(quality)))
            previous = (root, quality)
    return out


def install(path: Path = SIDECAR):
    """Make four_pillar_v31_data use the sidecar chords (idempotent)."""
    import four_pillar_v31_data as D
    if getattr(D.analyze, 'augmentednet', False):
        return
    base, table = D.analyze, load(path)

    def analyze(score, source, labels=None, first=0, last=None):
        result = base(score, source, labels, first, last)
        spans = table.get(score.score_id)
        if spans and result.get('chordSource') != 'augmentednet':
            hi = len(score.measures) - 1 if last is None else last
            chords = chords_for_bars(score, spans, first, hi)
            if chords:
                result = {**result, 'chords': chords, 'chordSource': 'augmentednet-v1'}
        return result

    analyze.augmentednet = True
    D.analyze = analyze


def build(an_dirs_and_maps, out: Path):
    table, stats = {}, {'scores': 0, 'errors': 0, 'chords': 0}
    for an_dir, map_path in an_dirs_and_maps:
        names = json.loads(Path(map_path).read_text())
        for f in sorted(Path(an_dir).glob('*.json')):
            d = json.loads(f.read_text())
            if d.get('error') or not d['chords'] or f.stem not in names:
                stats['errors'] += 1
                continue
            spans = sorted((o, r, q) for o, r, q, *_ in d['chords'])
            table[names[f.stem]] = [[o, r, q] for o, r, q in spans]
            stats['scores'] += 1
            stats['chords'] += len(spans)
    with gzip.open(out, 'wt') as fh:
        json.dump(table, fh, separators=(',', ':'))
    print(json.dumps(stats))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('build')
    b.add_argument('--out', type=Path, default=SIDECAR)
    b.add_argument('pairs', nargs='+', help='an_output_dir:map.json ...')
    args = p.parse_args()
    build([tuple(x.split(':')) for x in args.pairs], args.out)
