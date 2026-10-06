#!/usr/bin/env python3
"""Evaluate joint R/H/B/M prototypes and compare them with the current models.

1. Per-stream cross-entropy on the Lieder validation split (used for checkpoint
   selection) and on the untouched test split.
2. Melody: conditional pitch cross-entropy per note/rest event on validation works
   (same split rule as Melody v5, which never trained on them). Windows as v5 was
   trained: 3/4 or 4/4, starting on a 4-bar boundary, first 8 full bars, events
   fitting v5's two-octave window; event = genuine onset or start of a rest.
   Joint model: p(token | a new event starts) over the non-HOLD tokens.
3. Harmony: next-chord cross-entropy / top-1 at every chord change of the same
   windows, current chord excluded, against Harmony v2 (history of up to 24
   chords, inversions derived from the bass, style = classical).
The Lieder test split is used only in (1); v5 was trained on some test works.

  python training/scripts/evaluate_joint.py training/runs/joint-v1
"""
import argparse, importlib.util, json, math, sys
from pathlib import Path
import numpy as np
import torch
from torch.nn import functional as F
from joint_data import (load_corpus, build_windows, collate, STREAMS, H_HOLD, HOLD, REST, ONSET0, PAD, UNK)
from joint_model import StructuredJoint, FlatJoint, loss_and_metrics, WEIGHTS

ROOT = Path(__file__).resolve().parents[1]
QUALITIES = json.loads((ROOT / 'data/chord-qualities.json').read_text())


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod


def load_joint(path):
    ck = torch.load(path, map_location='cpu', weights_only=False)
    cfg = dict(ck['config']); kind = cfg.pop('kind')
    if kind == 'flat' and 'controls' not in cfg:
        cfg['controls'] = 'basic'  # checkpoints from before the flat model received all controls
    model = (StructuredJoint if kind == 'structured' else FlatJoint)(**cfg)
    model.load_state_dict(ck['state_dict']); model.eval()
    return model, kind


def stream_ce(model, windows, batch=32):
    sums = {s: 0.0 for s in STREAMS}; counts = {s: 0 for s in STREAMS}
    with torch.no_grad():
        for i in range(0, len(windows), batch):
            _, m = loss_and_metrics(model, collate(windows[i:i + batch]))
            for s, (ce, n) in m.items():
                sums[s] += ce * n; counts[s] += n
    out = {s: round(sums[s] / counts[s], 4) for s in STREAMS if counts[s]}
    out['weighted'] = round(sum(WEIGHTS[s] * out[s] for s in STREAMS if s in out), 4)
    out['tokens'] = counts
    return out


def logprobs(model, windows, batch=32, lag_key=False):
    """Per-window log-probabilities for M and H at every position (predicting t+1).

    lag_key: feed the local key of step t instead of t+1 (no advance knowledge of a
    key change; the local key comes from the same analysis as the harmony labels).
    """
    out = []
    with torch.no_grad():
        for i in range(0, len(windows), batch):
            b = collate(windows[i:i + batch])
            if lag_key:
                b['lkey'] = torch.cat([b['lkey'][:, :1], b['lkey'][:, :-1]], 1)
            lg = model(b)
            lm, lh = F.log_softmax(lg['M'], -1), F.log_softmax(lg['H'], -1)
            for j in range(lm.shape[0]):
                out.append((lm[j].numpy(), lh[j].numpy()))
    return out


def melody_pitches(w):
    """Absolute melody pitch per step (-1 rest) and attack flags, from the window tokens."""
    n = int(w['valid'].sum()); base = w['info']['melodyBase']
    pitch = np.full(n, -1); attack = np.zeros(n, bool); cur = -1
    for t in range(n):
        tok = int(w['M'][t])
        if tok >= ONSET0:
            cur = base + tok - ONSET0; pitch[t] = cur; attack[t] = True
        elif tok == HOLD and cur >= 0:
            pitch[t] = cur
        else:
            cur = -1
    return pitch, attack


def melody_events_v5(w, TM, piece):
    """Melody v5 inputs for the first 8 full bars of a window, plus the events to score."""
    n = int(w['valid'].sum()); L = int(w['barlen'][0]); meter = int(w['meter'][0])
    if (w['info']['melodyBase'] is None or meter not in (1, 2) or (w['meter'][:n] != meter).any()
            or (w['pos'][:n] != np.arange(n) % L).any() or int(w['phrase'][0]) % 4 != 0):
        return None  # v5 trained on 3/4 and 4/4 windows that start on a 4-bar boundary
    bars = min(8, n // L)
    if bars < 2:
        return None
    n = bars * L
    pitch, attack = melody_pitches(w)
    pitch, attack = pitch[:n], attack[:n]
    tonic, mode = w['info']['refTonic'], w['info']['refMode']
    rel = [p - tonic for p in pitch if p >= 0]
    if len(rel) < 8:
        return None
    shifts = [12 * k for k in range(3, 8) if min(rel) - 12 * k >= 0 and max(rel) - 12 * k <= 23]
    if not shifts:
        return None
    shift = min(shifts, key=lambda k: abs(sum(rel) / len(rel) - k - 12))
    grid = [TM.REST if p < 0 else p - tonic - shift for p in pitch]
    scale = TM.MIN if mode else TM.MAJ
    rows, ys, hs, events = [], [], [], []
    theme = [[], []]; previous, prevdur = TM.BOS, 3
    for bar in range(bars):
        c = int(w['chord'][bar * L]); root, q = c % 12, c // 12
        if (bar + 1) * L < int(w['valid'].sum()):
            nc = int(w['chord'][(bar + 1) * L])
        else:  # next bar lies beyond the window: read it from the piece, as v5 was trained
            A = piece['arrays']; at = w['info']['start'] + (bar + 1) * L
            nc = (int(A['ch_q'][at]) * 12 + (int(A['ch_root'][at]) - w['info']['refTonic']) % 12) if at < len(A['ch_root']) else c
        npcs = {(nc % 12 + iv) % 12 for iv in QUALITIES[nc // 12]['intervals']}
        slot = 0
        while slot < L:
            s0 = bar * L + slot; token = grid[s0]; length = 1
            while slot + length < L and grid[s0 + length] == token and not attack[s0 + length]:
                length += 1
            length = max(d for d in TM.DURS if d <= length); di = TM.DURS.index(length)
            ref, refdur = TM.motif_reference(theme, bar, slot, root, scale)
            rows.append([previous, prevdur, root, q, 0, mode, 3, 0, 0, slot, bar, 1, 0 if L == 16 else 1, ref, refdur])
            ys.append(token); hs.append([float(p in npcs) for p in range(12)])
            genuine = (token != TM.REST and attack[s0]) or (token == TM.REST and (s0 == 0 or grid[s0 - 1] != TM.REST))
            if genuine and s0 > 0:
                events.append((len(rows) - 1, s0, token))
            if bar < 2:
                theme[bar].append((slot, token, di, root))
            previous, prevdur = token, di; slot += length
    return {'rows': rows, 'targets': ys, 'next': hs, 'events': events}


def compare_melody(joint_lp, windows, TM, v5, pieces):
    stats = {'v5': [0.0, 0, 0], 'joint': [0.0, 0, 0]}; n_windows = 0
    with torch.no_grad():
        for w, (lm, _) in zip(windows, joint_lp):
            ev = melody_events_v5(w, TM, pieces[w['info']['scoreId']])
            if not ev or not ev['events']:
                continue
            n_windows += 1
            x = torch.tensor([ev['rows']]); nxt = torch.tensor([ev['next']], dtype=torch.float32)
            pitch_logits, _, _, _ = v5(x, nxt)
            lp_v5 = F.log_softmax(pitch_logits[0], -1).numpy()
            for i, s0, token in ev['events']:
                # v5
                stats['v5'][0] -= lp_v5[i, token]; stats['v5'][1] += 1; stats['v5'][2] += int(lp_v5[i].argmax() == token)
                # joint: position s0-1 predicts step s0, conditioned on an event starting there
                tok = int(w['M'][s0]); cand = lm[s0 - 1].copy(); cand[[PAD, UNK, HOLD]] = -np.inf
                stats['joint'][0] -= cand[tok] - np.logaddexp.reduce(cand[np.isfinite(cand)]); stats['joint'][1] += 1
                stats['joint'][2] += int(cand.argmax() == tok)
    return {k: {'pitchCE': round(float(v[0]) / v[1], 4), 'top1': round(v[2] / v[1], 4), 'events': v[1]} for k, v in stats.items()} | {'windows': n_windows}


def compare_harmony(joint_lp, windows, TH, v2):
    stats = {'v2': [0.0, 0, 0], 'joint': [0.0, 0, 0]}
    with torch.no_grad():
        for w, (_, lh) in zip(windows, joint_lp):
            n = int(w['valid'].sum()); H = w['H'][:n].astype(int)
            base = w['info']['bassBase']; B = w['B'][:n].astype(int)
            # bass pitch class (relative to the reference tonic) sounding at each step
            bass_rel = np.full(n, -1); cur = -1
            for t in range(n):
                if B[t] >= ONSET0 and base is not None:
                    cur = (base + B[t] - ONSET0 - w['info']['refTonic']) % 12
                elif B[t] != HOLD:
                    cur = -1
                bass_rel[t] = cur
            changes = [t for t in range(n) if H[t] >= 3]
            for k, t in enumerate(changes):
                if k == 0:
                    continue
                hist = changes[max(0, k - 24):k]
                chords = [H[s] - 3 for s in hist]
                target, current = H[t] - 3, chords[-1]
                invs = []
                for s, c in zip(hist, chords):
                    ints = QUALITIES[c // 12]['intervals']
                    iv = (bass_rel[s] - c % 12) % 12 if bass_rel[s] >= 0 else -1
                    invs.append(ints.index(iv) if iv in ints else 0)
                logits, _, _, _ = v2(torch.tensor([chords]), torch.tensor([invs]), torch.tensor([w['info']['refMode']]), torch.tensor([1]))
                lv = logits[0, -1].clone(); lv[current] = -float('inf')
                lpv = F.log_softmax(lv, -1)
                stats['v2'][0] -= float(lpv[target]); stats['v2'][1] += 1; stats['v2'][2] += int(int(lpv.argmax()) == target)
                row = lh[t - 1][3:].copy(); row[current] = -np.inf
                row = row - np.logaddexp.reduce(row[np.isfinite(row)])
                stats['joint'][0] -= row[target]; stats['joint'][1] += 1; stats['joint'][2] += int(row.argmax() == target)
    return {k: {'nextChordCE': round(float(v[0]) / v[1], 4), 'top1': round(v[2] / v[1], 4), 'changes': v[1]} for k, v in stats.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('run_dir', type=Path)
    ap.add_argument('--lieder', type=Path, default=ROOT / 'data/joint/lieder-joint.npz')
    ap.add_argument('--limit', type=int, default=0, help='quick check on the first N windows')
    ap.add_argument('--threads', type=int, default=2)
    ap.add_argument('--models', nargs='*', help='only these subdirectories; results are merged into an existing evaluation.json')
    a = ap.parse_args(); torch.set_num_threads(a.threads)
    lieder = load_corpus(a.lieder)
    val, test = build_windows(lieder, 'validation'), build_windows(lieder, 'test')
    if a.limit:
        val, test = val[:a.limit], test[:a.limit]
    TM, TH = load_module('train_melody'), load_module('train_harmony')
    v5 = TM.MelodyTransformer(); v5.load_state_dict(torch.load(ROOT / 'checkpoints/melody-v5.pt', map_location='cpu', weights_only=True)); v5.eval()
    v2 = TH.HarmonyTransformer(); v2.load_state_dict(torch.load(ROOT / 'checkpoints/harmony-from-browser-v2.pt', map_location='cpu', weights_only=True)); v2.eval()
    pieces = {p['meta']['scoreId']: p for p in lieder}
    out = a.run_dir / 'evaluation.json'
    report = {'validationWindows': len(val), 'testWindows': len(test), 'models': {}}
    if a.models and out.exists() and not a.limit:
        report['models'] = json.loads(out.read_text())['models']
    subs = sorted(p for p in a.run_dir.iterdir() if (p / 'model.pt').exists() and (not a.models or p.name in a.models))
    for sub in subs:
        model, kind = load_joint(sub / 'model.pt')
        lp, lp_lag = logprobs(model, val), logprobs(model, val, lag_key=True)
        entry = {'kind': kind, 'config': model.config, 'parameters': sum(p.numel() for p in model.parameters()),
                 'validation': stream_ce(model, val), 'test': stream_ce(model, test),
                 'melodyVsV5': compare_melody(lp, val, TM, v5, pieces),
                 'melodyVsV5_keyLagged': compare_melody(lp_lag, val, TM, v5, pieces),
                 'harmonyVsV2': compare_harmony(lp, val, TH, v2),
                 'harmonyVsV2_keyLagged': compare_harmony(lp_lag, val, TH, v2)}
        report['models'][sub.name] = entry
        print(json.dumps({sub.name: entry}), flush=True)
    (out if not a.limit else a.run_dir / 'evaluation-limit.json').write_text(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
