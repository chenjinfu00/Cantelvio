#!/usr/bin/env python3
"""MIDI files -> compact note/bar arrays for the Cantelvio Compose orchestral model.

For every file: map each note to one of six instrument groups (groups.py), quantize
onsets and durations to 1/12 quarter, build bars from the time signatures, merge
notes that one group plays twice (same onset and pitch, e.g. violins I and II in
unison), and sort notes by bar, position, unpitched first, pitch. Files that are not
on the grid (performance recordings), too short, or have unusable meters are skipped
with a reason. Exact duplicates are removed; the split (train / validation / test) is
decided by a hash of the content.

Output (all little-endian raw arrays, read with numpy.memmap; see data.py):
  notes.<field>.bin   bar (int32, bar index in its piece), pos, group, pitch, drum, dur, vel (uint8)
  bars.<field>.bin    start (int32, grid steps), len, meter, tempo (uint8), first (int32, first note)
  pieces.json         per piece: name, split, note/bar offsets and counts, groups
  prepare.json        counts, skip reasons, settings

  python training/orchestra/prepare.py <midi folder> <output folder> [--workers 8] [--max-files N]
"""
import argparse, hashlib, json, os, sys, time
from collections import Counter
from multiprocessing import Pool
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import groups as G

NOTE_FIELDS = {'bar': np.int32, 'pos': np.uint8, 'group': np.uint8, 'pitch': np.uint8, 'drum': np.uint8,
               'dur': np.uint8, 'vel': np.uint8}
BAR_FIELDS = {'start': np.int32, 'len': np.uint8, 'meter': np.uint8, 'tempo': np.uint8, 'first': np.int32}
MIN_NOTES, MIN_BARS, MAX_OFF_GRID = 100, 8, 0.2
# Opt-in for local MIDI that is slightly humanized. Defaults above stay unchanged
# so the existing SymphonyNet corpus and five trained checkpoints remain reproducible.
RECOVER_MIN_NOTES = 60
RECOVER_MEAN_ROUND_MS = 15.0
RECOVER_P95_ROUND_MS = 35.0

_PROG_TABLE = np.array([G._PROGRAM.get(p, G.DROP) for p in range(128)], np.int16)
_DUR_EDGES = np.sqrt(np.array(G.DURATIONS[:-1], float) * np.array(G.DURATIONS[1:], float))  # geometric midpoints
_DRUM_TABLE = np.array([G.drum_class(x) for x in range(128)], np.int16)


def parse(path, *, recover=False):
    """-> (arrays, info) or (None, reason)."""
    from symusic import Score
    try:
        s = Score(str(path))
    except Exception as e:  # corrupt or unsupported file
        return None, 'unreadable'
    tpq = s.ticks_per_quarter
    if tpq <= 0:
        return None, 'unreadable'
    cols = []
    for tr in s.tracks:
        a = tr.notes.numpy()
        n = len(a['time'])
        if n == 0:
            continue
        pitch = a['pitch'].astype(np.int16)
        if tr.is_drum:
            grp = np.full(n, G.PERC, np.int16); drum = np.ones(n, np.int16)
        else:
            grp = np.full(n, _PROG_TABLE[int(tr.program) % 128], np.int16); drum = np.zeros(n, np.int16)
            split = grp == G.SPLIT
            grp[split] = np.where(pitch[split] >= G.SPLIT_PITCH, G.HIGH, G.LOW)
        cols.append((a['time'].astype(np.int64), a['duration'].astype(np.int64), pitch, a['velocity'].astype(np.int16), grp, drum))
    if not cols:
        return None, 'no notes'
    time_, dur, pitch, vel, grp, drum = (np.concatenate([c[i] for c in cols]) for i in range(6))
    keep = (grp >= 0) & ((drum == 1) | ((pitch >= G.PITCH_LO) & (pitch <= G.PITCH_HI)))
    time_, dur, pitch, vel, grp, drum = time_[keep], dur[keep], pitch[keep], vel[keep], grp[keep], drum[keep]
    if len(time_) < (RECOVER_MIN_NOTES if recover else MIN_NOTES):
        return None, 'too few notes'
    on = time_ * G.GRID / tpq
    q = np.rint(on).astype(np.int64)
    off_grid = float(np.mean(np.abs(on - q) > 0.25))
    rounded_ms = None
    if off_grid > MAX_OFF_GRID:
        if not recover:
            return None, 'not on grid'
        # Measure each onset against the tempo active at that note. A small
        # fraction of a grid step is not necessarily a small audible error at
        # slow tempos; never accept an arbitrary off-grid performance by fiat.
        tempos = sorted((int(t.time), float(t.qpm)) for t in s.tempos)
        tempo_ticks = np.array([t for t, _ in tempos], np.int64)
        tempo_qpm = np.array([qpm for _, qpm in tempos], float)
        active = np.searchsorted(tempo_ticks, time_, side='right') - 1
        qpm = np.full(len(time_), 120.0)
        present = active >= 0
        qpm[present] = tempo_qpm[active[present]]
        qpm = np.where(np.isfinite(qpm) & (qpm > 0), qpm, 120.0)
        rounded_ms = np.abs(on - q) * 60000.0 / (qpm * G.GRID)
        if (float(rounded_ms.mean()) > RECOVER_MEAN_ROUND_MS or
                float(np.percentile(rounded_ms, 95)) > RECOVER_P95_ROUND_MS):
            return None, 'not on grid'
    d = np.maximum(1, np.rint(dur * G.GRID / tpq)).astype(np.int64)
    # bars from time signatures (changes only; a change inside a bar shortens that bar)
    sigs = []
    for t in sorted(s.time_signatures, key=lambda x: x.time):
        g = int(round(t.time * G.GRID / tpq))
        if sigs and (t.numerator, t.denominator) == sigs[-1][1:]:
            continue
        if sigs and g == sigs[-1][0]:
            sigs[-1] = (g, t.numerator, t.denominator); continue
        sigs.append((g, t.numerator, t.denominator))
    if not sigs or sigs[0][0] > 0:
        sigs.insert(0, (0, 4, 4))
    end = int((q + d).max())
    starts, lens, meters = [], [], []
    for k, (t0, num, den) in enumerate(sigs):
        L = G.bar_steps(num, den)
        if L is None:
            return None, 'unusable meter'
        t1 = sigs[k + 1][0] if k + 1 < len(sigs) else max(end, t0 + 1)
        t = t0
        while t < t1:
            starts.append(t); lens.append(min(L, t1 - t) if k + 1 < len(sigs) else L); meters.append(G.meter_index(num, den))
            t += L
    starts = np.array(starts, np.int64); lens = np.array(lens, np.int64)
    if len(starts) < MIN_BARS:
        return None, 'too short'
    tempos = sorted((int(round(t.time * G.GRID / tpq)), t.qpm) for t in s.tempos) or [(0, 120.0)]
    tt = np.array([x[0] for x in tempos]); tq = [x[1] for x in tempos]
    bar_tempo = np.array([G.tempo_bucket(tq[max(0, int(np.searchsorted(tt, b, side='right')) - 1)]) for b in starts], np.int64)
    bar = np.searchsorted(starts, q, side='right') - 1
    pos = q - starts[bar]
    if (pos >= lens[bar]).any() or (bar < 0).any():
        return None, 'bar mapping'
    pf = np.where(drum == 1, _DRUM_TABLE[np.clip(pitch, 0, 127)], pitch)
    velb = np.minimum(G.N_VEL - 1, np.maximum(0, (vel - 1) // 16))
    durb = np.searchsorted(_DUR_EDGES, d)
    # merge the same note played twice by one group: keep the longest and loudest
    order = np.lexsort((-velb, -durb, grp, pf, 1 - drum, pos, bar))
    bar, pos, pf, drum, grp, durb, velb = (x[order] for x in (bar, pos, pf, drum, grp, durb, velb))
    key = np.stack([bar, pos, drum, pf, grp], 1)
    first = np.ones(len(key), bool); first[1:] = (key[1:] != key[:-1]).any(1)
    bar, pos, pf, drum, grp, durb, velb = (x[first] for x in (bar, pos, pf, drum, grp, durb, velb))
    counts = np.bincount(grp, minlength=G.N_GROUPS)
    bar_first = np.searchsorted(bar, np.arange(len(starts)))
    notes = {'bar': bar, 'pos': pos, 'group': grp, 'pitch': pf, 'drum': drum, 'dur': durb, 'vel': velb}
    bars = {'start': starts, 'len': lens, 'meter': np.array(meters), 'tempo': bar_tempo, 'first': bar_first}
    h = hashlib.md5()
    for f in ('bar', 'pos', 'group', 'pitch'):
        h.update(np.ascontiguousarray(notes[f][:4000]).astype(np.int32).tobytes())
    h.update(str(len(bar)).encode())
    info = {'notes': int(len(bar)), 'bars': int(len(starts)), 'groups': counts.tolist(), 'offGrid': round(off_grid, 4),
            'merged': int((~first).sum()), 'hash': h.hexdigest()}
    if recover:
        info['recovery'] = ('onsets rounded' if rounded_ms is not None else
                            'short piece' if len(time_) < MIN_NOTES else 'none')
        if rounded_ms is not None:
            info['roundMeanMs'] = round(float(rounded_ms.mean()), 2)
            info['roundP95Ms'] = round(float(np.percentile(rounded_ms, 95)), 2)
    return ({k: v.astype(NOTE_FIELDS[k]) for k, v in notes.items()}, {k: v.astype(BAR_FIELDS[k]) for k, v in bars.items()}), info


def _work(path, recover=False):
    try:
        return str(path), *parse(path, recover=recover)
    except Exception as e:
        return str(path), None, f'error: {type(e).__name__}'


def split_of(digest, holdout=1):
    """holdout percent each for validation and test, by content hash."""
    h = int(digest[:8], 16) % 100
    return 'validation' if h < holdout else 'test' if h < 2 * holdout else 'train'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('midi_dir', type=Path); ap.add_argument('out_dir', type=Path)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--max-files', type=int, default=0)
    ap.add_argument('--holdout', type=int, default=1, help='percent of pieces each for validation and test')
    ap.add_argument('--recover', action='store_true',
                    help='opt in to gentle timing rounding and 60-note minimum for local MIDI; originals are untouched')
    a = ap.parse_args(); t0 = time.time()
    files = sorted(p for p in a.midi_dir.rglob('*') if p.suffix.lower() in ('.mid', '.midi') and p.is_file())
    if a.max_files:
        files = files[:a.max_files]
    a.out_dir.mkdir(parents=True, exist_ok=True)
    fh = {f'notes.{k}': open(a.out_dir / f'notes.{k}.bin', 'wb') for k in NOTE_FIELDS}
    fh.update({f'bars.{k}': open(a.out_dir / f'bars.{k}.bin', 'wb') for k in BAR_FIELDS})
    pieces, reasons, recovered, seen = [], Counter(), Counter(), set()
    n_notes = n_bars = 0
    from functools import partial
    with Pool(a.workers, maxtasksperchild=200) as pool:
        for i, (path, arrays, info) in enumerate(pool.imap(partial(_work, recover=a.recover), files, chunksize=8)):
            if arrays is None:
                reasons[info] += 1
            elif info['hash'] in seen:
                reasons['duplicate'] += 1
            else:
                seen.add(info['hash'])
                notes, bars = arrays
                for k, v in notes.items():
                    v.tofile(fh[f'notes.{k}'])
                for k, v in bars.items():
                    v.tofile(fh[f'bars.{k}'])
                piece_info = {k: info[k] for k in ('notes', 'bars', 'groups', 'offGrid', 'merged')}
                if a.recover:
                    piece_info.update({k: info[k] for k in ('recovery', 'roundMeanMs', 'roundP95Ms') if k in info})
                    recovered[info['recovery']] += 1
                pieces.append({'name': str(Path(path).relative_to(a.midi_dir)), 'split': split_of(info['hash'], a.holdout),
                               'noteOffset': n_notes, 'barOffset': n_bars, **piece_info})
                n_notes += info['notes']; n_bars += info['bars']
            if (i + 1) % 500 == 0 or i + 1 == len(files):
                print(json.dumps({'files': i + 1, 'of': len(files), 'kept': len(pieces), 'notes': n_notes,
                                  'seconds': round(time.time() - t0)}), flush=True)
    for f in fh.values():
        f.close()
    (a.out_dir / 'pieces.json').write_text(json.dumps(pieces))
    by_split = Counter(p['split'] for p in pieces)
    group_notes = np.sum([p['groups'] for p in pieces], 0).tolist() if pieces else [0] * G.N_GROUPS
    summary = {'source': str(a.midi_dir), 'files': len(files), 'kept': len(pieces), 'skipped': dict(reasons),
               'splits': dict(by_split), 'notes': n_notes, 'bars': n_bars,
               'groupNotes': dict(zip(G.GROUPS, group_notes)), 'grid': G.GRID, 'seconds': round(time.time() - t0),
               'recovery': {'enabled': a.recover, 'minNotes': RECOVER_MIN_NOTES if a.recover else MIN_NOTES,
                            'meanRoundMs': RECOVER_MEAN_ROUND_MS if a.recover else None,
                            'p95RoundMs': RECOVER_P95_ROUND_MS if a.recover else None,
                            'acceptedByMode': dict(recovered) if a.recover else {}},
               'fields': {'notes': {k: np.dtype(v).name for k, v in NOTE_FIELDS.items()},
                          'bars': {k: np.dtype(v).name for k, v in BAR_FIELDS.items()}}}
    (a.out_dir / 'prepare.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
