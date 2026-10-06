#!/usr/bin/env python3
"""Compare AugmentedNet chords (an_label.py output) with the ChordTracker chords of four_pillar_v31_tonal.

Per beat of every score: agreement of (root, quality) and of the root, and how much of the sounding pitch-class
mass of the beat each labelling covers (chord tones), plus how often the lowest sounding note is the chord root.
    python compare_chord_labels.py <an-output-dir> <map.json> [--db PATH] [--limit N]
"""
from __future__ import annotations

import argparse
import json
import sys
from bisect import bisect_right
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from four_pillar_score_index import get_score, open_index                      # noqa: E402
from four_pillar_v31_tonal import (NoteTable, QUALITIES, beat_segments, track_chords, track_keys)  # noqa: E402

TONES = [np.zeros(12, bool) for _ in QUALITIES]
for q, t in zip(QUALITIES, TONES):
    for i in q['intervals']:
        t[i % 12] = True
ROOT_DB = Path(__file__).resolve().parents[1] / 'data/four-pillar-score-all-train-v1.sqlite'


def chords_at_beats(spans, segments, bar_onset):
    """Chord in effect at the start of every beat from absolute-offset spans [(offset, root, quality)]."""
    starts = [s[0] for s in spans]
    out = []
    for bar, off, length, _ in segments:
        t = bar_onset[bar] + float(off)
        i = bisect_right(starts, t + 1e-6) - 1
        out.append(spans[max(i, 0)][1:] if spans else (-1, -1))
    return out


def tracker_spans(score, keys, table):
    chords = track_chords(score, keys, 0, len(score.measures) - 1, table)
    spans = []
    for bar in sorted(chords):
        for off, root, quality in chords[bar]:
            spans.append((float(table.bar_onset[bar]) + float(off), root, quality))
    return sorted(spans)


def beat_masses(table, segments):
    masses, lows = [], []
    for bar, off, length, _ in segments:
        a = table.bar_onset[bar] + float(off)
        b = a + float(length)
        sel = table.sounding & (table.onset < b - 1e-9) & (table.onset + table.duration > a + 1e-9)
        w = np.zeros(12)
        low = None
        for p, o, d in zip(table.pitch[sel], table.onset[sel], table.duration[sel]):
            w[p % 12] += min(o + d, b) - max(o, a)
            low = p if low is None or p < low else low
        masses.append(w)
        lows.append(None if low is None else low % 12)
    return masses, lows


def score_chords(spans_by_beat, masses, lows):
    cov, cov_n, bass = 0., 0., [0, 0]
    for (root, q), w, low in zip(spans_by_beat, masses, lows):
        if root < 0 or w.sum() <= 0:
            continue
        tones = np.roll(TONES[q], root)
        cov += float((w * tones).sum())
        cov_n += float(w.sum())
        if low is not None:
            bass[0] += int(low == root)
            bass[1] += 1
    return cov / max(cov_n, 1e-9), bass[0] / max(bass[1], 1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('an_dir', type=Path)
    p.add_argument('map', type=Path)
    p.add_argument('--db', type=Path, default=ROOT_DB)
    p.add_argument('--limit', type=int, default=0)
    args = p.parse_args()
    names = json.loads(args.map.read_text())
    db = open_index(args.db)
    tot = dict(beats=0, same=0, root=0, covA=0., covT=0., bassA=0., bassT=0., n=0, an_changes=0, tr_changes=0, bars=0)
    per = []
    for f in sorted(args.an_dir.glob('*.json')):
        d = json.loads(f.read_text())
        key = f.stem
        if d.get('error') or not d['chords'] or key not in names:
            continue
        try:
            score = get_score(db, names[key])
        except KeyError:
            continue
        table = NoteTable(score)
        keys = track_keys(score, table)
        segs = beat_segments(score, 0, len(score.measures) - 1)
        an = sorted((o, r, q) for o, r, q, *_ in d['chords'])
        tr = tracker_spans(score, keys, table)
        a_beats = chords_at_beats(an, segs, table.bar_onset)
        t_beats = chords_at_beats(tr, segs, table.bar_onset)
        masses, lows = beat_masses(table, segs)
        ca, ba = score_chords(a_beats, masses, lows)
        ct, bt = score_chords(t_beats, masses, lows)
        same = sum(a == t for a, t in zip(a_beats, t_beats))
        rt = sum(a[0] == t[0] for a, t in zip(a_beats, t_beats))
        n = len(segs)
        tot['beats'] += n; tot['same'] += same; tot['root'] += rt
        tot['covA'] += ca; tot['covT'] += ct; tot['bassA'] += ba; tot['bassT'] += bt; tot['n'] += 1
        tot['an_changes'] += len({(round(o, 3)) for o, *_ in an}); tot['tr_changes'] += len(tr); tot['bars'] += len(score.measures)
        per.append((names[key].split('/')[-1], n, round(same / n, 3), round(rt / n, 3), round(ca, 3), round(ct, 3)))
        if args.limit and tot['n'] >= args.limit:
            break
    n = max(tot['n'], 1)
    print(json.dumps({'scores': tot['n'], 'beats': tot['beats'],
                      'agreeRootAndQuality': round(tot['same'] / max(tot['beats'], 1), 4),
                      'agreeRoot': round(tot['root'] / max(tot['beats'], 1), 4),
                      'chordToneCoverage': {'augmentednet': round(tot['covA'] / n, 4), 'tracker': round(tot['covT'] / n, 4)},
                      'bassIsRoot': {'augmentednet': round(tot['bassA'] / n, 4), 'tracker': round(tot['bassT'] / n, 4)},
                      'chordsPerBar': {'augmentednet': round(tot['an_changes'] / max(tot['bars'], 1), 3),
                                       'tracker': round(tot['tr_changes'] / max(tot['bars'], 1), 3)}}, indent=1))
    for row in per[:12]:
        print(row)


if __name__ == '__main__':
    main()
