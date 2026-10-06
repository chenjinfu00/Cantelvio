#!/usr/bin/env python3
"""Synthetic four-stream phrases for pretraining the AIlegro joint Transformer.

Uses the project's existing rule system, not new hand-written music:
  A  melody grammar (train_melody.make_phrase): melody + one chord per bar, and
     the app's accompaniment planner (src/planner.js, archived since 2026-09-27 in
     archive/pre-joint-runtime-20260927/) for texture and bass
  B  harmony grammar (train_harmony.make_phrase) with a sampled harmonic rhythm,
     accompaniment from the same planner; melody marked unknown (no loss)
Output arrays use the same layout as build_joint_lieder.py.

Usage: python training/scripts/build_joint_synthetic.py training/data/joint/synthetic-joint.npz
"""
import argparse, importlib.util, json, random, subprocess, sys, tempfile, time
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent
sys.path.insert(0, str(ROOT / 'scripts'))
from build_joint_lieder import METERS, metrical_level  # noqa: E402


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod


TM, TH = load('train_melody'), load('train_harmony')
STYLES = ['pop', 'jazz', 'blues', 'classical', 'ambient', 'exploratory']
ACC = {  # style -> (accompaniment style, rhythm, texture, bass pattern, bass instrument)
    'pop': ('pop', 'syncopated', 'comping', 'root-fifth', 'electric-bass'),
    'jazz': ('jazz', 'swing', 'comping', 'walking', 'electric-bass'),
    'blues': ('rock', 'eighth', 'rock-strum', 'driving', 'electric-bass'),
    'classical': ('classical', 'eighth', 'alberti', 'root-fifth', 'piano'),
    'ambient': ('pop', 'quarter', 'block', 'pedal', 'synth-bass'),
}
RHYTHMS4 = ['quarter', 'eighth', 'syncopated', 'swing']
TEXTURES = ['rock-strum', 'comping', 'ascending', 'descending', 'updown', 'alberti', 'block', 'bass-chord']
BASSLINES = ['root-fifth', 'driving', 'walking', 'pedal']


def accompaniment(rng, style, meter):
    acc, rhythm, texture, bass, inst = ACC.get(style) or ACC[rng.choice(list(ACC))]
    if rng.random() < .35:
        which = rng.randrange(3)
        if which == 0: rhythm = rng.choice(RHYTHMS4)
        elif which == 1: texture = rng.choice(TEXTURES)
        else: bass = rng.choice(BASSLINES)
    if meter == 12:
        rhythm = 'waltz'
    return {'accStyle': acc, 'rhythm': rhythm, 'texture': texture, 'bassPattern': bass, 'bassInstrument': inst}


def melody_phrases(rng, count, motifs, progressions, split):
    out = []
    for i in range(count):
        rows, targets, durs, _ = TM.make_phrase(rng, motifs, progressions, i)
        meter = 16 if rows[0][12] == 0 else 12
        style = STYLES[rows[0][6]]
        bars = max(r[10] for r in rows) + 1
        # Drop a bar that the 96-event context truncated.
        last_end = rows[-1][9] + TM.DURS[durs[-1]]
        if last_end < meter:
            bars -= 1
        tonic = rng.randrange(12)
        chords, mel = [], []
        for r, tok, d in zip(rows, targets, durs):
            if r[10] >= bars:
                break
            if not chords or chords[-1]['bar'] != r[10]:
                chords.append({'bar': r[10], 'root': (r[2] + tonic) % 12, 'q': r[3], 'inv': r[4],
                               'startStep': r[10] * meter, 'lengthSteps': meter})
            mel.append((r[10] * meter + r[9], tok, TM.DURS[d]))
        spec = {'id': f'A-{split}-{i}', 'type': 'melody-grammar', 'split': split, 'meter': meter, 'bars': bars,
                'tonic': tonic, 'mode': rows[0][5], 'style': style, 'chords': chords, 'melody': mel,
                **accompaniment(rng, style, meter)}
        out.append(spec)
    return out


def harmony_phrases(rng, count, templates, split, seen=None):
    out = []
    names = ['pop', 'classical', 'jazz', 'exploratory']
    for i in range(count):
        seq, mode, hstyle = TH.make_phrase(rng, templates, i, coverage=False)
        style = names[hstyle]
        meter = 12 if rng.random() < .2 else 16
        tonic = rng.randrange(12)
        chords, step = [], 0
        for j, (token, inv) in enumerate(seq):
            q, root = divmod(token, 12)
            if j == len(seq) - 1:
                length = meter  # final chord: one full bar
            else:
                length = rng.choices([meter, 2 * meter, 8, 4], [.55, .15, .22, .08])[0]
            chords.append({'root': (root + tonic) % 12, 'q': q, 'inv': inv, 'startStep': step, 'lengthSteps': length})
            step += length
        # End on a barline.
        pad = (-step) % meter
        chords[-1]['lengthSteps'] += pad; step += pad
        spec = {'id': f'B-{split}-{i}', 'type': 'harmony-grammar', 'split': split, 'meter': meter, 'bars': step // meter,
                'tonic': tonic, 'mode': mode, 'style': style, 'chords': chords, 'melody': None,
                **accompaniment(rng, style, meter)}
        out.append(spec)
    return out


def to_arrays(spec):
    L = spec['meter']; N = spec['bars'] * L
    mid = METERS[(4, 4)] if L == 16 else METERS[(3, 4)]
    st = np.arange(N)
    arrays = {
        'bar': (st // L).astype(np.int32), 'pos': (st % L).astype(np.int16), 'barlen': np.full(N, L, np.int16),
        'meter': np.full(N, mid, np.int16), 'level': np.array([metrical_level(p, L, 4) for p in st % L], np.int8),
        'key_tonic': np.full(N, spec['tonic'], np.int8), 'key_mode': np.full(N, spec['mode'], np.int8),
        'cover': np.full(N, -1, np.float16),
    }
    # Melody (unknown for harmony-grammar phrases).
    mel_pitch = np.full(N, -2 if spec['melody'] is None else -1, np.int16); mel_on = np.zeros(N, np.int8)
    if spec['melody'] is not None:
        base = 60 + ((spec['tonic'] + 6) % 12 - 6)
        for s0, tok, length in spec['melody']:
            if s0 >= N:
                continue
            s1 = min(N, s0 + length)
            if tok == TM.REST:
                mel_pitch[s0:s1] = -1
            else:
                mel_pitch[s0:s1] = base + tok; mel_on[s0] = 1
    arrays['mel_pitch'] = mel_pitch; arrays['mel_on'] = mel_on
    # Bass skyline and accompaniment rhythm from the planner's events.
    low = np.full(N, 999, np.int16); low_start = np.full(N, -1, np.int32)
    onset = np.zeros(N, np.int16); sounding = np.zeros(N, bool)
    for ev in spec['events']:
        s0 = int(round(ev['beat'] * 4)); s1 = max(s0 + 1, int(round((ev['beat'] + ev['beats']) * 4)))
        if s0 >= N:
            continue
        s1 = min(s1, N)
        if ev['role'] == 'bass':
            for t in range(s0, s1):
                if ev['midi'] < low[t] or (ev['midi'] == low[t] and s0 > low_start[t]):
                    low[t] = ev['midi']; low_start[t] = s0
        else:
            onset[s0] += 1; sounding[s0:s1] = True
    arrays['bass_pitch'] = np.where(low < 999, low, -1).astype(np.int16)
    arrays['bass_on'] = ((low_start == st) & (low < 999)).astype(np.int8)
    arrays['rhythm'] = np.where(onset >= 2, 3, np.where(onset == 1, 2, np.where(sounding, 1, 0))).astype(np.int8)
    ch_root = np.full(N, -1, np.int8); ch_q = np.full(N, -1, np.int8)
    for c in spec['chords']:
        s0, s1 = c['startStep'], min(N, c['startStep'] + c['lengthSteps'])
        ch_root[s0:s1] = c['root']; ch_q[s0:s1] = c['q']
    change = np.ones(N, np.int8)
    change[1:] = ((ch_root[1:] != ch_root[:-1]) | (ch_q[1:] != ch_q[:-1])).astype(np.int8)
    arrays.update({'ch_root': ch_root, 'ch_q': ch_q, 'ch_change': change})
    return arrays


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('output'); ap.add_argument('--seed', type=int, default=930117)
    ap.add_argument('--melody', type=int, default=4500); ap.add_argument('--harmony', type=int, default=4800)
    ap.add_argument('--melody-valid', type=int, default=300); ap.add_argument('--harmony-valid', type=int, default=512)
    a = ap.parse_args(); t0 = time.time()
    rng = random.Random(a.seed)
    specs = (melody_phrases(rng, a.melody, TM.TRAIN_MOTIFS, TM.TRAIN_PROGRESSIONS, 'train')
             + melody_phrases(rng, a.melody_valid, TM.VALID_MOTIFS, TM.VALID_PROGRESSIONS, 'validation')
             + harmony_phrases(rng, a.harmony, TH.TRAIN, 'train')
             + harmony_phrases(rng, a.harmony_valid, TH.VALID, 'validation'))
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / 'specs.json', Path(tmp) / 'rendered.json'
        src.write_text(json.dumps(specs))
        subprocess.run(['node', str(ROOT / 'scripts/render_joint_accompaniment.mjs'), str(src), str(dst)], check=True, cwd=PROJECT)
        specs = json.loads(dst.read_text())
    per = [to_arrays(s) for s in specs]
    keys = list(per[0].keys())
    offsets = np.cumsum([0] + [len(p['bar']) for p in per]).astype(np.int64)
    out = Path(a.output); out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, offsets=offsets, **{k: np.concatenate([p[k] for p in per]) for k in keys})
    records = [{'scoreId': s['id'], 'workId': s['id'], 'split': s['split'], 'reject': None, 'type': s['type'],
                'style': s['style'], 'N': int(len(p['bar'])), 'bars': s['bars'], 'accompaniment': {k: s[k] for k in ('accStyle', 'rhythm', 'texture', 'bassPattern')}}
               for s, p in zip(specs, per)]
    summary = {'source': 'AIlegro rule system: train_melody/train_harmony grammars + src/planner.js accompaniment',
               'seed': a.seed, 'phrases': len(specs), 'steps': int(offsets[-1]), 'seconds': round(time.time() - t0),
               'splits': {s: sum(1 for r in records if r['split'] == s) for s in ('train', 'validation')}, 'records': records}
    out.with_suffix('.json').write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != 'records'}, indent=1))


if __name__ == '__main__':
    main()
