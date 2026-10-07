#!/usr/bin/env python3
"""Build the four-stream (rhythm / harmony / bass / melody) Lieder corpus for the
Cantelvio Compose joint Transformer prototype.

Source: the pinned CC0 OpenScore Lieder tree (training/data/sources/*.tar.gz).
Only the MusicXML (.mxl) scores and the bundled AugmentedNet automatic
Roman-numeral analyses (analysis_automatic.rntxt) are read.

Per piece, a global sixteenth-note grid is built:
  melody  first (vocal) part, top-note skyline, onset / sustain / rest
  bass    lowest sounding pitch of the lowest accompaniment staff
  rhythm  articulation of the remaining accompaniment notes
          (REST, HOLD, one onset, two or more onsets)
  harmony AugmentedNet chords aligned by measure number and in-measure offset,
          reduced to Cantelvio Compose's 40 chord qualities; local key per step
Per bar: metre, position, off-grid onsets and chord-tone coverage (alignment QA).

Split = sha256(song directory) % 10: 0 validation (same rule as the current
Melody v5 corpus), 1 untouched test, otherwise train.

Usage (needs music21):
  python training/scripts/build_joint_lieder.py <extracted OpenScore-Lieder> \
      training/data/joint/lieder-joint.npz --workers 2
"""
import argparse, glob, hashlib, json, os, sys, time, traceback, warnings
from multiprocessing import Pool
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
QUALITIES = json.loads((ROOT / 'data/chord-qualities.json').read_text())
QSETS = [frozenset(q['intervals']) for q in QUALITIES]
VOCAL = ('voice', 'vocal', 'soprano', 'alto', 'tenor', 'baritone', 'bass', 'gesang', 'singstimme',
         'chant', 'sång', 'sang', 'mezzo', 'contralto', 'canto', 'stimme', 'solo')
KEYBOARD = ('piano', 'pianoforte', 'klavier', 'organ', 'harmonium', 'guitar', 'harp')
# Metre categories: (numerator, denominator) -> id. Steps per bar = 16 * n / d.
METERS = {(2, 4): 0, (3, 4): 1, (4, 4): 2, (2, 2): 3, (3, 8): 4, (6, 8): 5, (9, 8): 6, (12, 8): 7,
          (6, 4): 8, (3, 2): 9, (4, 8): 10, (5, 4): 11, (2, 8): 12}
COMPOUND = {(6, 8), (9, 8), (12, 8), (6, 4)}
MAX_BAR = 24


def split_for(work):
    h = int(hashlib.sha256(work.encode()).hexdigest()[:8], 16) % 10
    return 'validation' if h == 0 else 'test' if h == 1 else 'train'


def beat_steps(n, d):
    if (n, d) in COMPOUND:
        return 6 if d == 8 else 12
    return {4: 4, 2: 8, 8: 2, 16: 1}.get(d, 4)


def metrical_level(pos, bar_len, beat):
    if pos == 0:
        return 0
    if pos % beat == 0:
        return 1
    return 2 if pos % 2 == 0 else 3


def quality_of(root, pcs):
    ints = frozenset((p - root) % 12 for p in pcs)
    if ints in QSETS:
        return QSETS.index(ints), 1.0
    best, score = 0, -1.0
    for i, q in enumerate(QSETS):
        s = len(ints & q) / len(ints | q) + (0.01 if len(q) == len(ints) else 0)
        if s > score:
            best, score = i, s
    return best, score


_RN_CACHE = {}


def _key(token):
    from music21 import key as m21key
    name = token[0] + token[1:].replace('b', '-')
    return m21key.Key(name)


def parse_rntxt(path, default_ts='4/4'):
    """Light RomanText reader: (measure, offset in quarters, root pc, pcs, key tonic pc, minor).

    music21's reader treats 3/8 as one beat, while some AugmentedNet files count
    eighth-note beats there; per time-signature section, if beats exceed the bar
    under the music21 convention, the denominator note is used as the beat unit.
    """
    import re
    from music21 import meter, roman
    lines = Path(path).read_text(encoding='utf-8').splitlines()
    cur = {'ts': default_ts, 'measures': []}  # RomanText default when no metre line precedes
    sections = [cur]
    for line in lines:
        if line.startswith('Time Signature:'):
            cur = {'ts': line.split(':', 1)[1].strip(), 'measures': []}
            sections.append(cur)
            continue
        m = re.match(r'^m(\d+)\S*\s+(.*)$', line.strip())
        if m and cur is not None:
            cur['measures'].append((int(m.group(1)), m.group(2).split()))
    out, key = [], None
    for sec in sections:
        try:
            ts = meter.TimeSignature(sec['ts'])
        except Exception:
            continue
        bar = float(ts.barDuration.quarterLength)
        unit = float(ts.beatDuration.quarterLength)
        beats = [float(t[1:]) for _, toks in sec['measures'] for t in toks if re.fullmatch(r'b\d+(\.\d+)?', t)]
        if beats and max(beats) >= ts.beatCount + 1 - 1e-6:
            unit = 4.0 / ts.denominator
        for number, toks in sec['measures']:
            offset = 0.0
            for t in toks:
                if re.fullmatch(r'b\d+(\.\d+)?', t):
                    offset = (float(t[1:]) - 1) * unit
                    continue
                if t.endswith(':') and len(t) >= 2:
                    try:
                        key = _key(t[:-1])
                    except Exception:
                        pass
                    continue
                if key is None or offset >= bar - 1e-6:
                    continue
                ck = (t, key.tonic.name, key.mode)
                if ck not in _RN_CACHE:
                    try:
                        rn = roman.RomanNumeral(t, key)
                        _RN_CACHE[ck] = (rn.root().pitchClass, sorted(set(rn.pitchClasses)))
                    except Exception:
                        _RN_CACHE[ck] = None
                if _RN_CACHE[ck] is None:
                    continue
                root_pc, pcs = _RN_CACHE[ck]
                out.append((number, offset, root_pc, pcs, key.tonic.pitchClass, int(key.mode == 'minor')))
    return out


def events(part, skip_grace=True):
    """(onset_q, dur_q, [midi...]) for notes/chords, ties merged, chord symbols excluded."""
    from music21 import note, chord, harmony
    flat = part.flatten().stripTies()
    out = []
    for el in flat.notes:
        if isinstance(el, harmony.Harmony):
            continue
        if skip_grace and (el.duration.isGrace or el.duration.quarterLength <= 0):
            continue
        if isinstance(el, note.Note):
            ps = [el.pitch.midi]
        elif isinstance(el, chord.Chord):
            ps = [p.midi for p in el.pitches]
        else:
            continue
        out.append((float(el.offset), float(el.duration.quarterLength), ps))
    return out


def extract(args):
    mxl, root = args
    warnings.simplefilter('ignore')
    from music21 import converter
    song_dir = str(Path(mxl).parent.relative_to(Path(root) / 'scores'))
    rn_path = Path(mxl).parent / 'analysis_automatic.rntxt'
    rec = {'scoreId': Path(mxl).stem, 'workId': song_dir, 'split': split_for(song_dir)}
    try:
        if not rn_path.exists():
            return {**rec, 'reject': 'no_analysis'}
        score = converter.parse(mxl)
        parts = list(score.parts)
        if len(parts) < 2:
            return {**rec, 'reject': 'no_accompaniment'}
        name = (parts[0].partName or '').lower()
        inst = parts[0].getInstrument(returnDefault=False)
        iname = (inst.instrumentName or '').lower() if inst else ''
        if any(k in name for k in KEYBOARD) or not any(k in name + ' ' + iname for k in VOCAL):
            return {**rec, 'reject': 'not_vocal', 'detail': name + ' | ' + iname}
        # Measure table from the first part.
        measures = list(parts[0].getElementsByClass('Measure'))
        if not measures:
            return {**rec, 'reject': 'no_measures'}
        first_ts = next(iter(parts[0].recurse().getElementsByClass('TimeSignature')), None) or \
            next(iter(score.recurse().getElementsByClass('TimeSignature')), None)
        if first_ts is None:
            return {**rec, 'reject': 'no_time_signature'}
        ts = first_ts
        bars = []
        for i, m in enumerate(measures):
            if m.timeSignature is not None:
                ts = m.timeSignature
            n, d = ts.numerator, ts.denominator
            nominal = float(ts.barDuration.quarterLength)
            actual = float(m.duration.quarterLength) or nominal
            off = float(m.offset)
            bars.append({'number': m.number, 'offset': off, 'nominal': nominal, 'actual': actual, 'meter': (n, d)})
        # Harmony analysis: raw (measure number, offset in the analysed bar, chord); the
        # mapping to score measures is chosen below by chord-tone coverage, because
        # AugmentedNet numbers a pickup bar m1 while music21 numbers it 0.
        raw = []
        for m, o, root_pc, pcs, kt, km in parse_rntxt(rn_path, first_ts.ratioString):
            q, qscore = quality_of(root_pc, pcs)
            raw.append((m, o, root_pc, q, qscore, kt, km))
        if not raw:
            return {**rec, 'reject': 'no_chords'}
        by_number = {}
        for b in bars:
            by_number.setdefault(b['number'], b)
        def place(b, off):
            if b is bars[0] and b['actual'] < b['nominal']:
                off -= b['nominal'] - b['actual']
            return b['offset'] + max(0.0, off)
        mappings = {
            'number': lambda m, o: (by_number.get(m), o),
            'number-1': lambda m, o: (by_number.get(m - 1), o),
            'sequential': lambda m, o: (bars[m - 1] if 1 <= m <= len(bars) else None, o),
        }
        candidates = {}
        for mname, fn in mappings.items():
            out, missing = [], 0
            for m, o, r, q, qs, kt, km in raw:
                b, off = fn(m, o)
                if b is None:
                    missing += 1
                    continue
                out.append((place(b, off), r, q, qs, kt, km))
            if out:
                out.sort(key=lambda c: c[0])
                candidates[mname] = (out, missing)
        if not candidates:
            return {**rec, 'reject': 'no_chords'}
        # Global sixteenth grid.
        end_q = bars[-1]['offset'] + bars[-1]['actual']
        N = int(round(end_q * 4))
        if N < 32:
            return {**rec, 'reject': 'short'}
        bar_idx = np.full(N, -1, np.int32); pos = np.zeros(N, np.int16); blen = np.zeros(N, np.int16)
        meter = np.zeros(N, np.int16); level = np.zeros(N, np.int8)
        unsupported = 0
        for bi, b in enumerate(bars):
            s0 = int(round(b['offset'] * 4)); s1 = int(round((b['offset'] + b['actual']) * 4))
            n, d = b['meter']; L = int(round(b['nominal'] * 4))
            mid = METERS.get((n, d), -1)
            if mid < 0 or L > MAX_BAR or L <= 0:
                unsupported += s1 - s0
                mid = -1
            shift = (L - (s1 - s0)) if (bi == 0 and s1 - s0 < L) else 0  # pickup ends at the barline
            beat = beat_steps(n, d)
            for j, st in enumerate(range(s0, min(s1, N))):
                p = min(j + shift, max(L - 1, 0))
                bar_idx[st] = bi; pos[st] = p; blen[st] = L; meter[st] = mid
                level[st] = metrical_level(p, L, beat)
        # Melody: top-note skyline of the vocal part.
        def grid(evts, lowest=False):
            pitch = np.full(N, -1, np.int16); start = np.full(N, -1, np.int32)
            off_grid = 0
            for on, du, ps in evts:
                if abs(on * 4 - round(on * 4)) > 0.1:
                    off_grid += 1
                s0 = int(round(on * 4)); s1 = max(s0 + 1, int(round((on + du) * 4)))
                p = min(ps) if lowest else max(ps)
                for st in range(max(s0, 0), min(s1, N)):
                    cur = pitch[st]
                    better = cur < 0 or (p < cur if lowest else p > cur) or (p == cur and s0 > start[st])
                    # A later onset replaces an earlier sustained note in the melody.
                    if not lowest and cur >= 0 and s0 > start[st]:
                        better = True
                    if better:
                        pitch[st] = p; start[st] = s0
            return pitch, start, off_grid
        mel_ev = events(parts[0])
        if len(mel_ev) < 32:
            return {**rec, 'reject': 'short_melody'}
        mel_pitch, mel_start, mel_off = grid(mel_ev)
        acc_parts = parts[1:]
        lh_ev = events(acc_parts[-1])
        acc_ev = [e for p in acc_parts for e in events(p)]
        bass_pitch, bass_start, _ = grid([(on, du, [p]) for on, du, ps in lh_ev for p in ps], lowest=True)
        # Accompaniment rhythm: all accompaniment notes except the bass-line notes.
        onset_count = np.zeros(N, np.int16); sounding = np.zeros(N, bool); acc_off = 0
        pc_weight = np.zeros((N, 12), np.float32)
        for on, du, ps in acc_ev:
            if abs(on * 4 - round(on * 4)) > 0.1:
                acc_off += 1
            s0 = int(round(on * 4)); s1 = max(s0 + 1, int(round((on + du) * 4)))
            for p in ps:
                is_bass = 0 <= s0 < N and bass_pitch[s0] == p and bass_start[s0] == s0
                for st in range(max(s0, 0), min(s1, N)):
                    pc_weight[st, p % 12] += 1
                if is_bass:
                    continue
                if 0 <= s0 < N:
                    onset_count[s0] += 1
                sounding[max(s0, 0):min(s1, N)] = True
        for on, du, ps in mel_ev:
            s0 = int(round(on * 4)); s1 = max(s0 + 1, int(round((on + du) * 4)))
            for st in range(max(s0, 0), min(s1, N)):
                pc_weight[st, max(ps) % 12] += 0.5
        rhythm = np.where(onset_count >= 2, 3, np.where(onset_count == 1, 2, np.where(sounding, 1, 0))).astype(np.int8)
        w = pc_weight.sum(1)
        def harmony_arrays(chords):
            ch_root = np.full(N, -1, np.int8); ch_q = np.full(N, -1, np.int8)
            key_tonic = np.full(N, -1, np.int8); key_mode = np.zeros(N, np.int8)
            for i, (t, r, q, qs, kt, km) in enumerate(chords):
                s0 = int(round(t * 4)); s1 = int(round(chords[i + 1][0] * 4)) if i + 1 < len(chords) else N
                s0 = max(0, min(s0, N)); s1 = max(s0, min(s1, N))
                ch_root[s0:s1] = r; ch_q[s0:s1] = q; key_tonic[s0:s1] = kt; key_mode[s0:s1] = km
            if not (ch_root >= 0).any():
                return None
            first = int(np.argmax(ch_root >= 0))
            ch_root[:first] = ch_root[first]; ch_q[:first] = ch_q[first]
            key_tonic[:first] = key_tonic[first]; key_mode[:first] = key_mode[first]
            tones = np.zeros((N, 12), bool)
            for q in range(len(QUALITIES)):
                sel = ch_q == q
                if sel.any():
                    for iv in QUALITIES[q]['intervals']:
                        tones[np.where(sel)[0], (ch_root[sel].astype(int) + iv) % 12] = True
            cover = np.where(w > 0, (pc_weight * tones).sum(1) / np.maximum(w, 1e-6), np.nan)
            return ch_root, ch_q, key_tonic, key_mode, cover
        best = None
        coverages = {}
        for mname, (chords, missing) in candidates.items():
            arrs = harmony_arrays(chords)
            if arrs is None:
                continue
            c = float(np.nanmean(arrs[4])) if np.isfinite(arrs[4]).any() else 0.0
            coverages[mname] = round(c, 4)
            if best is None or c > best[0] + 1e-9:
                best = (c, mname, chords, missing, arrs)
        if best is None:
            return {**rec, 'reject': 'no_chords'}
        coverage, mapping, chords, missing, (ch_root, ch_q, key_tonic, key_mode, cover) = best
        ch_change = np.zeros(N, np.int8)
        change_at = np.ones(N, bool)
        change_at[1:] = (ch_root[1:] != ch_root[:-1]) | (ch_q[1:] != ch_q[:-1])
        ch_change[change_at] = 1
        qscores = [c[3] for c in chords]
        rec.update({
            'reject': None, 'N': N, 'bars': len(bars), 'melodyOffGrid': mel_off, 'accompOffGrid': acc_off,
            'melodyNotes': len(mel_ev), 'accompNotes': len(acc_ev), 'unsupportedSteps': int(unsupported),
            'missingChordMeasures': missing, 'chords': len(chords), 'meanQualityMatch': float(np.mean(qscores)),
            'chordToneCoverage': coverage, 'alignment': mapping, 'alignmentCoverages': coverages,
            'arrays': {
                'bar': bar_idx, 'pos': pos, 'barlen': blen, 'meter': meter, 'level': level,
                'mel_pitch': mel_pitch, 'mel_on': (mel_start == np.arange(N)).astype(np.int8) & (mel_pitch >= 0),
                'bass_pitch': bass_pitch, 'bass_on': ((bass_start == np.arange(N)) & (bass_pitch >= 0)).astype(np.int8),
                'rhythm': rhythm, 'ch_root': ch_root, 'ch_q': ch_q, 'ch_change': ch_change,
                'key_tonic': key_tonic, 'key_mode': key_mode,
                'cover': np.nan_to_num(cover, nan=-1).astype(np.float16),
            }})
        return rec
    except Exception as e:  # keep going; record the reason
        return {**rec, 'reject': 'error:' + type(e).__name__, 'detail': str(e)[:200]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('lieder_root'); ap.add_argument('output')
    ap.add_argument('--workers', type=int, default=2); ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    files = sorted(glob.glob(os.path.join(a.lieder_root, 'scores', '**', '*.mxl'), recursive=True))
    if a.limit:  # quick checks: only analysed scores, spread over the corpus
        files = [f for f in files if (Path(f).parent / 'analysis_automatic.rntxt').exists()]
        files = files[::max(1, len(files) // a.limit)][:a.limit]
    t0 = time.time(); results = []
    with Pool(a.workers) as pool:
        for i, r in enumerate(pool.imap(extract, [(f, a.lieder_root) for f in files], chunksize=4)):
            results.append(r)
            if (i + 1) % 50 == 0:
                print(json.dumps({'done': i + 1, 'of': len(files), 'seconds': round(time.time() - t0)}), flush=True)
    kept = [r for r in results if r['reject'] is None]
    rejects = {}
    for r in results:
        if r['reject']:
            rejects[r['reject']] = rejects.get(r['reject'], 0) + 1
    # Concatenate arrays with offsets.
    keys = list(kept[0]['arrays'].keys()) if kept else []
    offsets = np.cumsum([0] + [r['N'] for r in kept]).astype(np.int64)
    arrays = {k: np.concatenate([r['arrays'][k] for r in kept]) for k in keys}
    meta = [{k: v for k, v in r.items() if k != 'arrays'} for r in results]
    out = Path(a.output); out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, offsets=offsets, **arrays)
    summary = {'source': 'https://github.com/OpenScore/Lieder', 'commit': '38c5db510224d9facdc4b08d741fc788cfb58ea8',
               'license': 'CC0-1.0', 'harmony': 'AugmentedNet v1.9.1 automatic analyses bundled with the corpus',
               'pieces': len(files), 'kept': len(kept), 'rejected': rejects,
               'splits': {s: sum(1 for r in kept if r['split'] == s) for s in ('train', 'validation', 'test')},
               'steps': int(offsets[-1]), 'seconds': round(time.time() - t0), 'records': meta}
    out.with_suffix('.json').write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != 'records'}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
