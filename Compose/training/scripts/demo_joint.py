#!/usr/bin/env python3
"""Listening-demo data for the joint R/H/B/M model (tokens, chord labels, metadata).

For every example the first bar comes from a real Lieder window or a synthetic seed
phrase; the rest is generated per sixteenth step in the order R -> H -> B -> M.
Each example keeps the source ("原曲" / "规则原句") next to three model versions.

  python training/scripts/demo_joint.py training/runs/joint-v1/structured/model.pt training/runs/joint-v1/demo-data.json
"""
import argparse, json, random, time
from pathlib import Path
import numpy as np
import torch
from joint_data import load_corpus, build_windows, STREAMS, HOLD, ONSET0
from evaluate_joint import load_joint, QUALITIES
from sample_joint import generate

ROOT = Path(__file__).resolve().parents[1]
FLATS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']
SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
SHARP_KEYS = {(t, 0) for t in (7, 2, 9, 4, 11, 6)} | {(t, 1) for t in (4, 11, 6, 1, 8)}
METER_NAME = {0: '2/4', 1: '3/4', 2: '4/4', 3: '2/2', 5: '6/8'}


def names_for(tonic, mode):
    return SHARPS if (tonic, mode) in SHARP_KEYS else FLATS


def chord_labels(w):
    """[(step, label)] at every chord change; slash bass when the bass plays another chord tone."""
    n = int(w['valid'].sum()); tonic, mode = w['info']['refTonic'], w['info']['refMode']
    nm = names_for(tonic, mode); base = w['info']['bassBase']; out = []; cur_bass = None
    for t in range(n):
        b = int(w['B'][t])
        if b >= ONSET0 and base is not None:
            cur_bass = (base + b - ONSET0) % 12
        elif b != HOLD:
            cur_bass = None
        h = int(w['H'][t])
        if h >= 3:
            c = h - 3; root = (c % 12 + tonic) % 12; q = QUALITIES[c // 12]
            label = nm[root] + q['suffix']
            pcs = [(root + iv) % 12 for iv in q['intervals']]
            if cur_bass is not None and cur_bass != root and cur_bass in pcs:
                label += '/' + nm[cur_bass]
            out.append([t, label])
    return out


def pack(w, label):
    n = int(w['valid'].sum())
    return {'label': label, 'tokens': {s: w[s][:n].astype(int).tolist() for s in STREAMS}, 'chords': chord_labels(w),
            'chordRoot': [int(c) for c in w['chord'][:n]]}


def meta(w, title, blurb, bpm, kind):
    n = int(w['valid'].sum()); tonic, mode = w['info']['refTonic'], w['info']['refMode']
    return {'title': title, 'blurb': blurb, 'bpm': bpm, 'kind': kind, 'steps': n,
            'barlen': int(w['barlen'][0]), 'pos0': int(w['pos'][0]), 'meter': METER_NAME.get(int(w['meter'][0]), '?'),
            'key': names_for(tonic, mode)[tonic] + (' 小调' if mode else ' 大调'), 'refTonic': tonic,
            'melodyBase': w['info']['melodyBase'], 'bassBase': w['info']['bassBase'], 'source': w['info']['scoreId'],
            'seedSteps': int(w['barlen'][0]) - int(w['pos'][0])}


def choose(windows, rng, meter, mode, min_steps=112):
    c = [w for w in windows if int(w['meter'][0]) == meter and w['info']['refMode'] == mode and int(w['valid'].sum()) >= min_steps
         and (w['meter'][:int(w['valid'].sum())] == meter).all() and int(w['pos'][0]) == 0
         and w['info']['melodyBase'] is not None and w['info']['bassBase'] is not None
         and len(set(int(x) for x in w['H'][:int(w['valid'].sum())] if x >= 3)) >= 3]
    return rng.choice(c)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('checkpoint', type=Path); ap.add_argument('output', type=Path)
    ap.add_argument('--versions', type=int, default=3); ap.add_argument('--temperature', type=float, default=0.9)
    ap.add_argument('--seed', type=int, default=2026); ap.add_argument('--threads', type=int, default=2)
    a = ap.parse_args(); torch.set_num_threads(a.threads); t0 = time.time()
    model, kind = load_joint(a.checkpoint)
    rng = random.Random(a.seed)
    lieder = build_windows(load_corpus(ROOT / 'data/joint/lieder-joint.npz'), 'validation')
    syn = build_windows(load_corpus(ROOT / 'data/joint/synthetic-joint.npz'), 'validation')
    examples = []
    k = 0

    def versions(seed_w, clamp=()):
        nonlocal k
        out = []
        for v in range(a.versions):
            k += 1
            g = generate(model, seed_w, int(seed_w['barlen'][0]), clamp=clamp, temperature=a.temperature, seed_rng=a.seed + 101 * k)
            out.append(pack(g, f'模型 {v + 1}'))
        return out

    specs = [
        (choose(lieder, rng, 2, 0), '艺术歌曲续写', '第 1 小节来自验证集里的一首艺术歌曲，后面四轨全部由模型生成。', 76, 'lieder'),
        (choose(lieder, rng, 2, 1), '艺术歌曲续写 · 小调', '小调作品，第 1 小节来自原曲，后面四轨全部由模型生成。', 72, 'lieder'),
        (choose(lieder, rng, 1, 0, 108), '艺术歌曲续写 · 3/4 拍', '三拍子作品，第 1 小节来自原曲，后面四轨全部由模型生成。', 96, 'lieder'),
    ]
    for w, title, blurb, bpm, kind_ in specs:
        m = meta(w, title, blurb, bpm, kind_)
        m['versions'] = [pack(w, '原曲')] + versions(w)
        examples.append(m); print(json.dumps({'done': title, 'seconds': round(time.time() - t0)}), flush=True)
    # melody over the real accompaniment (same window as the first example)
    w = specs[0][0]
    m = meta(w, '只生成旋律', '节奏、和声、低音保留原曲，模型只生成第 2 小节起的旋律。可以和原曲旋律对比。', 76, 'melody')
    m['versions'] = [pack(w, '原曲旋律')] + versions(w, clamp=('R', 'H', 'B'))
    examples.append(m); print(json.dumps({'done': 'melody', 'seconds': round(time.time() - t0)}), flush=True)
    styles = [(0, '流行', 100), (1, '爵士', 112), (2, '布鲁斯', 96), (3, '古典', 88), (4, '氛围', 70)]
    for sid, name, bpm in styles:
        cands = [x for x in syn if x['style'] == sid and x['info']['melodyBase'] is not None and x['info']['bassBase'] is not None
                 and int(x['meter'][0]) == 2 and int(x['valid'].sum()) >= 112 and int(x['pos'][0]) == 0]
        w = rng.choice(cands)
        m = meta(w, f'风格续写 · {name}', f'第 1 小节取自规则系统生成的{name}乐句，后面四轨由模型生成（合成数据风格条件）。', bpm, 'style')
        m['versions'] = [pack(w, '规则原句')] + versions(w)
        examples.append(m); print(json.dumps({'done': name, 'seconds': round(time.time() - t0)}), flush=True)
    a.output.write_text(json.dumps({'model': str(a.checkpoint), 'temperature': a.temperature, 'examples': examples}, ensure_ascii=False))
    print(json.dumps({'examples': len(examples), 'seconds': round(time.time() - t0)}))


if __name__ == '__main__':
    main()
