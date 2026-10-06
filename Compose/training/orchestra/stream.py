#!/usr/bin/env python3
"""Generate a four-bar continuation, preserving model context and RNG between calls."""
import argparse
import json
from pathlib import Path

import numpy as np
import torch

import groups as G
from sample import Generator, load, write_midi


def save_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, separators=(',', ':')))
    temporary.replace(path)


def bar_dict(token, start):
    num, den = G.METERS[token['meter']]
    return {'quarter': round(token['t'] - start, 6), 'meter': f'{num}/{den}',
            'bpm': round(G.tempo_of_bucket(token['tempo']), 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('state', type=Path)
    parser.add_argument('midi', type=Path)
    parser.add_argument('events', type=Path)
    parser.add_argument('--seed', type=int, required=True)
    parser.add_argument('--bars', type=int, default=4)
    parser.add_argument('--tempo', type=int, default=96)
    parser.add_argument('--temperature', type=float, default=0.9)
    parser.add_argument('--top-p', type=float, default=0.95)
    parser.add_argument('--groups', required=True)
    args = parser.parse_args()
    if not 1 <= args.bars <= 16:
        raise ValueError('bars must be between 1 and 16')

    model = load(args.checkpoint, torch.device('cpu'))
    config_path = args.checkpoint.parent / 'config.json'
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    max_len = config.get('train', {}).get('max_len', 1024)
    rng = np.random.default_rng(args.seed)
    gen = Generator(model, torch.device('cpu'), max_len, rng, args.temperature, args.top_p)
    if args.state.exists():
        state = json.loads(args.state.read_text())
        if state['checkpoint'] != args.checkpoint.parent.name or state['seed'] != args.seed:
            raise ValueError('session model or seed changed')
        gen.tokens = state['tokens']
        gen.bar_len = state['barLen']
        gen.rng.bit_generator.state = state['rng']
        next_bar = state['nextBar']
    else:
        next_bar = 0
        gen.tokens = [{'type': G.BAR, 'meter': G.meter_index(4, 4),
                       'tempo': G.tempo_bucket(args.tempo), 'prog': 0,
                       'mask': (1 << G.HIGH) | (1 << G.LOW), 't': 0.0}]
        gen.bar_len = [G.bar_steps(4, 4)]

    groups = dict(item.split('=') for item in args.groups.split(','))
    if set(groups) != set(G.GROUPS) or set(groups.values()) - {'on', 'auto', 'off'}:
        raise ValueError('invalid group settings')
    current = gen.tokens[-1]
    if current['type'] != G.BAR:
        raise ValueError('session does not end on a barline')
    current['tempo'] = G.tempo_bucket(args.tempo)
    current['mask'] = sum((1 << i) for i, name in enumerate(G.GROUPS)
                          if groups[name] == 'on' or (groups[name] == 'auto' and current['mask'] & (1 << i)))
    if current['mask'] == 0:
        # Auto may select silence. Keep a requested auto string group available.
        fallback = next(i for i, name in enumerate(G.GROUPS) if groups[name] != 'off')
        current['mask'] = 1 << fallback
    start = current['t']
    bars = [current.copy()]
    notes = []
    finished = 0
    while finished < args.bars:
        # The model's finite piece-position condition cycles over 32-bar phrases.
        progression = min(G.N_PROG - 1, ((next_bar + finished) % 32) * G.N_PROG // 32)
        kind = gen.step(progression, [groups[name] for name in G.GROUPS],
                        G.meter_index(4, 4), G.tempo_bucket(args.tempo), False)
        token = gen.tokens[-1]
        if kind == G.BAR:
            finished += 1
            if finished < args.bars:
                bars.append(token.copy())
        elif kind == G.NOTE:
            notes.append((round(token['t'] - start, 6), G.DURATIONS[token['dur']] / G.GRID,
                          token['group'], token['pitch'], token['drum'], G.vel_of_bucket(token['vel'])))

    midi_bars = [(bar['t'] - start, bar['meter'], bar['tempo']) for bar in bars]
    write_midi(notes, midi_bars, args.midi)
    payload = {
        'format': 'ailegro-orchestra-preview-v1', 'seed': args.seed, 'bars': args.bars,
        'firstBar': next_bar, 'totalQuarters': round(gen.tokens[-1]['t'] - start, 6),
        'barEvents': [bar_dict(bar, start) for bar in bars],
        'notes': [{'quarter': on, 'duration': duration, 'group': G.GROUPS[group],
                   'pitch': G.drum_note(pitch) if drum else pitch, 'drum': drum, 'velocity': velocity}
                  for on, duration, group, pitch, drum, velocity in notes],
    }
    save_json(args.events, payload)
    save_json(args.state, {'checkpoint': args.checkpoint.parent.name, 'seed': args.seed,
                           'nextBar': next_bar + args.bars, 'tokens': gen.tokens,
                           'barLen': [gen.bar_len[-1]], 'rng': gen.rng.bit_generator.state})
    print(json.dumps({'bars': args.bars, 'firstBar': next_bar, 'notes': len(notes)}))


if __name__ == '__main__':
    main()
