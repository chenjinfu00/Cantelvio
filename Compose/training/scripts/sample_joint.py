#!/usr/bin/env python3
"""Generate listening examples from a joint R/H/B/M checkpoint (MIDI + simple WAV).

Examples (seed windows come from the validation splits):
  lieder-joint     first bar of a real Lieder window as context, all four streams generated
  pop-joint        first bar of a synthetic pop phrase as context, all four streams generated
  lieder-melody    real accompaniment (R/H/B) kept, only the melody generated after bar 1
  lieder-real      the untouched real window, for comparison
Sampling follows the training order: per sixteenth step R -> H -> B -> M.

  python training/scripts/sample_joint.py training/runs/joint-v1/structured/model.pt training/runs/joint-v1/samples
"""
import argparse, copy, json, math, random, wave
from pathlib import Path
import numpy as np
import torch
from torch.nn import functional as F
from joint_data import (load_corpus, build_windows, collate, chord_features_from_H, STREAMS, H_HOLD, HOLD, REST, ONSET0, PAD, UNK)
from evaluate_joint import load_joint, QUALITIES

ROOT = Path(__file__).resolve().parents[1]


def refresh_chords(w):
    chord, since, change = chord_features_from_H(torch.as_tensor(w['H'].astype(np.int64)))
    w['chord'], w['since'], w['change'] = chord.numpy().astype(np.int16), since.numpy().astype(np.int16), change.numpy()


def sample_token(logits, stream, prev_tok, cur_chord, temperature, top_p, rng):
    lg = logits.clone() / temperature
    lg[[PAD, UNK]] = -float('inf')
    if stream == 'H':
        lg[3 + cur_chord] = -float('inf')           # a new chord must differ (otherwise HOLD)
    if stream in ('B', 'M') and prev_tok < ONSET0 and prev_tok != HOLD:
        lg[HOLD] = -float('inf')                     # nothing sounding to hold
    p = F.softmax(lg, -1).numpy().astype(np.float64)
    order = np.argsort(-p); cum = np.cumsum(p[order]); keep = order[:max(1, int(np.searchsorted(cum, top_p)) + 1)]
    q = p[keep] / p[keep].sum()
    return int(keep[rng.choice(len(keep), p=q)])


def generate(model, seed, start, clamp=(), temperature=0.9, top_p=0.95, seed_rng=0):
    w = copy.deepcopy(seed); n = int(w['valid'].sum()); rng = np.random.default_rng(seed_rng)
    for t in range(start, n):
        for s in STREAMS:
            if s in clamp:
                continue
            with torch.no_grad():
                logits = model(collate([w]))[s][0, t - 1]
            w[s][t] = sample_token(logits, s, int(w[s][t - 1]), int(w['chord'][t - 1]), temperature, top_p, rng)
            if s == 'H':
                refresh_chords(w)
    return w


def notes_from(w, bpm):
    """(start_sec, dur_sec, midi, velocity, instrument) from window tokens."""
    n = int(w['valid'].sum()); sec = 60.0 / bpm / 4; tonic = w['info']['refTonic']
    out = []
    for s, base, inst in (('M', w['info']['melodyBase'], 'melody'), ('B', w['info']['bassBase'], 'bass')):
        if base is None:
            continue
        cur = None
        for t in range(n + 1):
            tok = int(w[s][t]) if t < n else REST
            if cur and (tok != HOLD):
                out.append((cur[0] * sec, (t - cur[0]) * sec, cur[1], 0.8 if s == 'M' else 0.7, inst)); cur = None
            if t < n and tok >= ONSET0:
                cur = (t, base + tok - ONSET0)
    # accompaniment: voice the current chord at R onsets
    arp, cur = 0, None
    for t in range(n + 1):
        tok = int(w['R'][t]) if t < n else 2
        if cur and tok != 3:
            for m in cur[1]:
                out.append((cur[0] * sec, (t - cur[0]) * sec, m, 0.45, 'chords'))
            cur = None
        if t < n and tok in (4, 5):
            c = int(w['chord'][t]); root = (c % 12 + tonic) % 12
            pcs = [(root + iv) % 12 for iv in QUALITIES[c // 12]['intervals']][:4]
            voiced = sorted(55 + (pc - 55) % 12 for pc in pcs)
            if tok == 4:
                voiced = [voiced[arp % len(voiced)]]; arp += 1
            cur = (t, voiced)
    return sorted(out)


def write_midi(notes, path, bpm):
    import mido
    mid = mido.MidiFile(ticks_per_beat=480)
    programs = {'melody': (0, 71), 'chords': (1, 0), 'bass': (2, 32)}
    for inst, (ch, prog) in programs.items():
        tr = mido.MidiTrack(); mid.tracks.append(tr)
        tr.append(mido.MetaMessage('track_name', name=inst, time=0))
        if ch == 0:
            tr.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(bpm), time=0))
        tr.append(mido.Message('program_change', channel=ch, program=prog, time=0))
        ev = []
        for st, du, m, vel, i in notes:
            if i == inst:
                a = int(round(st * bpm / 60 * 480)); b = max(a + 1, int(round((st + du) * bpm / 60 * 480)) - 10)
                ev += [(a, 1, m, int(vel * 110)), (b, 0, m, 0)]
        now = 0
        for tick, on, m, v in sorted(ev, key=lambda e: (e[0], e[1])):
            tr.append(mido.Message('note_on' if on else 'note_off', channel=ch, note=int(m), velocity=v, time=tick - now)); now = tick
    mid.save(path)


def write_wav(notes, path, sr=22050):
    """Very plain additive rendering, only for quick listening."""
    end = max(st + du for st, du, *_ in notes) + 1.0
    buf = np.zeros(int(end * sr))
    shapes = {'melody': [1, .5, .25, .12], 'chords': [1, .35, .15], 'bass': [1, .6, .3]}
    for st, du, m, vel, inst in notes:
        f = 440 * 2 ** ((m - 69) / 12); n = int((du + 0.25) * sr); t = np.arange(n) / sr
        tone = sum(a * np.sin(2 * np.pi * f * (k + 1) * t) for k, a in enumerate(shapes[inst]))
        env = np.minimum(1, t / 0.01) * np.exp(-t * (2.5 if inst == 'chords' else 1.5)) * np.where(t < du, 1, np.exp(-(t - du) * 20))
        i0 = int(st * sr); buf[i0:i0 + n] += vel * 0.18 * tone * env
    buf = np.tanh(buf / max(1e-6, np.abs(buf).max()) * 1.5) * 0.8
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(sr); f.writeframes((buf * 32767).astype(np.int16).tobytes())


def pick(windows, rng, meter=2, mode=0, min_steps=128):
    cands = [w for w in windows if int(w['meter'][0]) == meter and w['info']['refMode'] == mode and int(w['valid'].sum()) >= min_steps
             and (w['meter'][:int(w['valid'].sum())] == meter).all() and w['info']['melodyBase'] is not None and w['info']['bassBase'] is not None
             and int(w['pos'][0]) == 0]
    return rng.choice(cands)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('checkpoint', type=Path); ap.add_argument('output', type=Path)
    ap.add_argument('--seed', type=int, default=2026); ap.add_argument('--temperature', type=float, default=0.9)
    a = ap.parse_args(); torch.set_num_threads(2)
    model, kind = load_joint(a.checkpoint)
    rng = random.Random(a.seed)
    lieder = build_windows(load_corpus(ROOT / 'data/joint/lieder-joint.npz'), 'validation')
    syn = [w for w in build_windows(load_corpus(ROOT / 'data/joint/synthetic-joint.npz'), 'validation') if w['style'] == 0]
    real = pick(lieder, rng); pop = pick(syn, rng)
    a.output.mkdir(parents=True, exist_ok=True)
    L = int(real['barlen'][0]); Lp = int(pop['barlen'][0])
    examples = {
        'lieder-real': (real, 76),
        'lieder-melody': (generate(model, real, L, clamp=('R', 'H', 'B'), temperature=a.temperature, seed_rng=a.seed), 76),
        'lieder-joint': (generate(model, real, L, temperature=a.temperature, seed_rng=a.seed + 1), 76),
        'pop-joint': (generate(model, pop, Lp, temperature=a.temperature, seed_rng=a.seed + 2), 100),
    }
    meta = {'checkpoint': str(a.checkpoint), 'kind': kind, 'temperature': a.temperature, 'examples': {}}
    for name, (w, bpm) in examples.items():
        notes = notes_from(w, bpm)
        write_midi(notes, a.output / f'{name}.mid', bpm); write_wav(notes, a.output / f'{name}.wav')
        n = int(w['valid'].sum())
        meta['examples'][name] = {'source': w['info'], 'bpm': bpm, 'steps': n, 'notes': len(notes),
                                  'tokens': {s: w[s][:n].astype(int).tolist() for s in STREAMS}}
    (a.output / 'samples.json').write_text(json.dumps(meta))
    print(json.dumps({k: {'source': v['source']['scoreId'], 'notes': v['notes']} for k, v in meta['examples'].items()}))


if __name__ == '__main__':
    main()
