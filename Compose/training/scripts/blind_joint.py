#!/usr/bin/env python3
"""Blind A/B listening set: the same opening bar continued by two joint-model checkpoints.

Every example starts from the first bar of a validation window (OpenScore Lieder or a
synthetic style phrase); neither model trained on these windows. Both models then
generate the remaining bars per sixteenth step in the order R -> H -> B -> M under the
same sampling rules as the AIlegro app in Auto + Free mode (src/composer.js):
  * R: the model's distribution as is (temperature 1, no top-p); no HOLD after REST.
  * H: chords change only on beats; a chord lasts at most two bars; the current chord
    is not a "new" chord. B/M: melody A3-A5, bass E1-D4; HOLD only while a note sounds.
  * H/B/M two-stage sampling: whether an event happens (new chord / new note) is drawn
    from the model at temperature 1; the temperature (0.8, as in the Warm Piano scene)
    and top-p 0.95 act only on which chord or pitch.
Both models consume the same stream of random numbers (a fixed number of draws per step),
so where their distributions agree they write the same thing. The two continuations get
the labels A and B in a random order recorded in "answer"; the listening page hides it
until the listener reveals. The untouched window is kept as "reference".
--rules plain uses sample_joint.generate instead (plain temperature + top-p on every token).

  python training/scripts/blind_joint.py \
      training/runs/joint-v1/structured/model.pt training/runs/joint-v1/flat-params/model.pt \
      training/runs/joint-v1/blind/blind-data.json
"""
import argparse, copy, json, random, re, time
from pathlib import Path
import numpy as np
import torch
from joint_data import load_corpus, build_windows, collate, ONSET0, HOLD, REST, H_HOLD
from evaluate_joint import load_joint
from sample_joint import generate, refresh_chords
from demo_joint import choose, pack, meta

ROOT = Path(__file__).resolve().parents[1]
R_REST, R_HOLD, H_CHORD0 = 2, 3, 3
RANGES = {'B': (28, 62), 'M': (57, 81)}     # BASS_RANGE / MELODY_RANGE in src/composer.js


def pick(logits, ids, temperature, top_p, u):
    """sampleLogits of the app: softmax over ids, top-p over the sorted list, one uniform number."""
    v = logits[ids] / max(0.05, temperature)
    v = np.exp(v - v.max()); order = np.argsort(-v, kind='stable'); p = v[order] / v.sum()
    hit = np.nonzero(np.cumsum(p) >= top_p)[0]; kept = int(hit[0]) + 1 if len(hit) else len(p)
    c = np.cumsum(v[order[:kept]]); draw = min(max(u, 0.0), 1 - 1e-12) * c[-1]
    return int(ids[order[min(int(np.searchsorted(c, draw, side='right')), kept - 1)]])


def factored(logits, ids, is_event, temperature, top_p, u1, u2):
    """sampleFactored of the app: event or not at temperature 1, then which event at the temperature."""
    e = np.exp(logits[ids] - logits[ids].max()); ev, other = e[is_event].sum(), e[~is_event].sum()
    if min(max(u1, 0.0), 1 - 1e-12) * (ev + other) < ev:
        return pick(logits, ids[is_event], temperature, top_p, u2)
    return pick(logits, ids[~is_event], 1.0, 1.0, u2)


def generate_app(model, seed, start, temperature=0.8, top_p=0.95, seed_rng=0):
    w = copy.deepcopy(seed); n = int(w['valid'].sum()); rng = np.random.default_rng(seed_rng)
    bl = int(w['barlen'][0]); base = {'B': w['info']['bassBase'], 'M': w['info']['melodyBase']}
    last_change = max([t for t in range(start) if int(w['H'][t]) >= H_CHORD0], default=0)
    for t in range(start, n):
        for s in 'RHBM':
            if s == 'H' and int(w['level'][t]) > 1:          # Free mode: chords change on beats only
                w['H'][t] = H_HOLD; refresh_chords(w); continue
            with torch.no_grad():
                lg = model(collate([w]))[s][0, t - 1].double().numpy()
            ids = np.arange(2, len(lg))                      # never PAD / UNK
            if s == 'R':
                if int(w['R'][t - 1]) == R_REST:
                    ids = ids[ids != R_HOLD]
                w['R'][t] = pick(lg, ids, 1.0, 1.0, rng.random())
            elif s == 'H':
                current = H_CHORD0 + int(w['chord'][t - 1])
                must = t - last_change >= 2 * bl
                ids = ids[(ids != current) & ((ids >= H_CHORD0) | (not must))]
                w['H'][t] = factored(lg, ids, ids >= H_CHORD0, temperature, top_p, rng.random(), rng.random())
                if w['H'][t] >= H_CHORD0:
                    last_change = t
                refresh_chords(w)
            else:
                lo, hi = RANGES[s]; prev = [int(x) for x in w[s][:t]]
                k = len(prev) - 1
                while k >= 0 and prev[k] == HOLD:
                    k -= 1
                sounding = k >= 0 and prev[k] >= ONSET0
                pitch_ok = (ids >= ONSET0) & (base[s] + ids - ONSET0 >= lo) & (base[s] + ids - ONSET0 <= hi)
                ids = ids[(ids == REST) | ((ids == HOLD) & sounding) | pitch_ok]
                w[s][t] = factored(lg, ids, ids >= ONSET0, temperature, top_p, rng.random(), rng.random())
    return w


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('structured', type=Path); ap.add_argument('generic', type=Path); ap.add_argument('output', type=Path)
    ap.add_argument('--temperature', type=float, default=0.8); ap.add_argument('--top-p', type=float, default=0.95)
    ap.add_argument('--rules', choices=['app', 'plain'], default='app')
    ap.add_argument('--seed', type=int, default=20260928); ap.add_argument('--threads', type=int, default=1)
    ap.add_argument('--limit', type=int, default=0, help='only the first N examples (smoke test)')
    a = ap.parse_args(); torch.set_num_threads(a.threads); t0 = time.time()
    models = {'structured': load_joint(a.structured)[0], 'generic': load_joint(a.generic)[0]}
    params = {k: sum(p.numel() for p in m.parameters()) for k, m in models.items()}
    rng = random.Random(a.seed)
    def singing(w, min_seed=2, min_total=16):
        # a melody to continue: sung notes in the given first bar and throughout the source window (no piano intros)
        n, bl = int(w['valid'].sum()), int(w['barlen'][0]); M = w['M'][:n]
        return int((M[:bl] >= ONSET0).sum()) >= min_seed and int((M >= ONSET0).sum()) >= min_total

    lieder = [w for w in build_windows(load_corpus(ROOT / 'data/joint/lieder-joint.npz'), 'validation') if singing(w)]
    syn = build_windows(load_corpus(ROOT / 'data/joint/synthetic-joint.npz'), 'validation')

    used = set()

    def lied(meter, mode, min_steps=112):
        for _ in range(50):  # a different song for every example
            try:
                w = choose(lieder, rng, meter, mode, min_steps)
            except IndexError:
                return None
            if w['info']['scoreId'] not in used:
                used.add(w['info']['scoreId']); return w
        return None

    def synthetic(style_id):
        cands = [x for x in syn if x['style'] == style_id and x['info']['melodyBase'] is not None and x['info']['bassBase'] is not None
                 and int(x['meter'][0]) == 2 and int(x['valid'].sum()) >= 112 and int(x['pos'][0]) == 0]
        return rng.choice(cands) if cands else None

    works = {r['scoreId']: r['workId'] for r in json.loads((ROOT / 'data/joint/lieder-joint.json').read_text())['records']}

    def work_title(score_id):
        parts = works.get(score_id, '').split('/')
        if len(parts) < 2:
            return '艺术歌曲'
        composer = parts[0].split(',')[0].replace('_', ' ')
        title = re.sub(r'^\d+[_ .-]*', '', parts[-1]).replace('_', ' ')
        return f'{composer} · {title}'

    specs = [  # (window, title or None for the Lieder work title, bpm, kind)
        (lied(2, 0), None, 76, 'lieder'),
        (lied(2, 1), None, 72, 'lieder'),
        (synthetic(0), '流行风格乐句', 100, 'style'),
        (lied(1, 0, 108), None, 96, 'lieder'),
        (lied(2, 0), None, 72, 'lieder'),
        (synthetic(1), '爵士风格乐句', 112, 'style'),
        (lied(1, 1, 108), None, 92, 'lieder'),
        (lied(0, 0, 96), None, 84, 'lieder'),
    ]
    specs = [(w, title or work_title(w['info']['scoreId']), bpm, kind) for w, title, bpm, kind in specs if w is not None]
    if a.limit:
        specs = specs[:a.limit]
    examples = []
    for k, (w, title, bpm, kind) in enumerate(specs):
        n = int(w['valid'].sum())
        m = meta(w, title, '', bpm, kind)
        seed = a.seed + 1000 * (k + 1)
        out = {}
        for name, model in models.items():
            gen = generate_app if a.rules == 'app' else generate
            g = gen(model, w, int(w['barlen'][0]), temperature=a.temperature, top_p=a.top_p, seed_rng=seed)
            out[name] = pack(g, name)
        def events(tokens, s):  # (step, token) of every chord change / note onset after the given bar
            return {(t, x) for t, x in enumerate(tokens[s]) if t >= m['seedSteps'] and (x >= 3 if s == 'H' else x >= ONSET0)}
        shared = {}
        for s in 'HBM':
            ea, eb = events(out['structured']['tokens'], s), events(out['generic']['tokens'], s)
            shared[s] = round(len(ea & eb) / max(1, len(ea | eb)), 3)
        first = 'structured' if rng.random() < .5 else 'generic'
        second = 'generic' if first == 'structured' else 'structured'
        m.update(id=f'ex{len(examples) + 1}', samplingSeed=seed, work=works.get(m['source']), lkey=w['lkey'][:n].astype(int).tolist(),
                 versions=[dict(out[first], label='A'), dict(out[second], label='B')],
                 reference=pack(w, '原曲' if kind == 'lieder' else '规则原句'),
                 answer={'A': first, 'B': second},
                 sharedEvents=shared)
        examples.append(m)
        print(json.dumps({'done': m['id'], 'title': title, 'source': m['source'], 'A': first,
                          'sharedEvents': shared, 'seconds': round(time.time() - t0)}, ensure_ascii=False), flush=True)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps({'models': {'structured': str(a.structured), 'generic': str(a.generic)}, 'parameters': params,
                                    'rules': a.rules, 'temperature': a.temperature, 'topP': a.top_p, 'seed': a.seed, 'examples': examples},
                                   ensure_ascii=False))
    print(json.dumps({'examples': len(examples), 'seconds': round(time.time() - t0)}))


if __name__ == '__main__':
    main()
