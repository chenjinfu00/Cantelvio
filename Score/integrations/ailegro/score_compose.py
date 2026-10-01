#!/usr/bin/env python3
"""AIlegro Score -> AIlegro four-pillar v3.1 adapter (reference implementation).

Reads an `ailegro.compose-request/1` written by AIlegro Score, feeds the context bars to the
v3.1 `Composer` through `feed_bar()` (exactly the generation path), generates the requested
bars with `next_bar()` and writes an `ailegro.compose-result/1` that AIlegro Score imports as
reviewable suggestions.

Run it from the AIlegro project root with AIlegro's own environment, e.g.

    .venv-training/bin/python "<AIlegro Score>/integrations/ailegro/score_compose.py" \\
        --request request.json --checkpoint training/runs/<run>/weights.pt --output result.json

`--dry-run` converts and checks the request against AIlegro's time vocabulary without torch or
a checkpoint (useful in CI and when changing either side of the contract).

Status: the conversion layer is tested (dry run) against AIlegro's real time vocabulary and score
reader. Generation itself has NOT been run against trained weights from this repository — verify
in the AIlegro environment. Tasks that need hard-locked user material inside generated bars
(accompany-melody, develop-motif, orchestrate) are rejected until AIlegro's decoder supports them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from fractions import Fraction
from pathlib import Path

REQUEST_SCHEMA = 'ailegro.compose-request/1'
RESULT_SCHEMA = 'ailegro.compose-result/1'
SUPPORTED_TASKS = ('continue', 'melody-from-chords')
# Velocity used for given material that carries a score dynamic but no MIDI velocity.
DYNAMIC_VELOCITY = {'pppp': 20, 'ppp': 30, 'pp': 42, 'p': 56, 'mp': 70, 'mf': 84, 'f': 98, 'ff': 110, 'fff': 120,
                    'ffff': 127, 'sf': 108, 'sfz': 112, 'sffz': 118, 'fz': 108, 'fp': 98, 'sfp': 108, 'rf': 104,
                    'rfz': 108}


def q(text: str) -> Fraction:
    return Fraction(text)


def load_ailegro(root: Path, need_model: bool):
    scripts = root / 'training' / 'scripts'
    if not scripts.is_dir():
        raise SystemExit(f'not an AIlegro project root (missing {scripts}); pass --ailegro-root')
    sys.path.insert(0, str(scripts))
    from four_pillar_codec import DYNAMICS, GROUPS, WEDGES  # noqa: E402  (pure Python)
    from four_pillar_v31_time import TimeVocabulary  # noqa: E402  (pure Python)
    vocab = TimeVocabulary.load(root / 'training' / 'data' / 'four-pillar-v31-time-vocab.json')
    qualities = json.loads((root / 'training' / 'data' / 'chord-qualities.json').read_text())
    sample = None
    if need_model:
        import four_pillar_v31_sample as sample  # noqa: E402  (needs torch)
    return {'GROUPS': GROUPS, 'DYNAMICS': DYNAMICS, 'WEDGES': WEDGES, 'vocab': vocab,
            'quality_index': {qd['id']: i for i, qd in enumerate(qualities)}, 'sample': sample}


def bar_events(record: dict, bar: int, env: dict, stats: dict) -> list[dict]:
    """Feed events of one bar in AIlegro's commit order: per onset, chord changes first, then
    unpitched notes, then pitched notes from the lowest up."""
    groups, dynamics, wedges, vocab = env['GROUPS'], env['DYNAMICS'], env['WEDGES'], env['vocab']
    m = next(x for x in record['measures'] if x['number'] - 1 == bar)
    start = q(m['on'])
    rows = []
    for c in record.get('harmony', []):
        if c['bar'] != bar:
            continue
        index, remapped = vocab.lookup(q(c['on']) - start)
        stats['remapped'] += remapped
        quality = env['quality_index'].get(c['quality'])
        if quality is None:
            stats['unknownQualities'] += 1
            continue
        rows.append((q(c['on']), 0, 0, {'kind': 'chord', 'onset': index, 'root': int(c['root']) % 12,
                                         'quality': quality}))
    for n in record['notes']:
        if n['bar'] != bar or n.get('grace'):
            continue
        onset, remapped_on = vocab.lookup(q(n['on']) - start)
        duration, remapped_dur = vocab.lookup(q(n['dur']), positive=True)
        stats['remapped'] += remapped_on + remapped_dur
        unpitched = bool(n.get('unpitched')) or n.get('pitch') is None
        dyn = n.get('dynamic')
        wedge = n.get('wedge')
        velocity = n.get('velocity') or DYNAMIC_VELOCITY.get(dyn or '', 80)
        rows.append((q(n['on']), 1, -1 if unpitched else int(n['pitch']), {
            'kind': 'note',
            'onset': onset,
            'group': groups.index(n['group']) if n.get('group') in groups else 6,
            'identity': (n['part'], str(n['staff']), str(n['voice'])),
            'pitch': 128 if unpitched else int(n['pitch']),
            'duration': duration,
            'velocity': max(1, min(127, int(velocity))),
            'dynamic': dynamics.index(dyn) + 1 if dyn in dynamics else 0,
            'accent': int(n.get('accent', 0)),
            'wedge': wedges.index(wedge) + 1 if wedge in wedges else 0,
            'drum': int(n.get('drum') or 38) if unpitched else None,  # GM snare when unknown
        }))
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    return [r[3] for r in rows]


def constraint(request: dict, kind: str, bar_on: Fraction | None = None):
    for c in request['constraints']:
        if c['kind'] != kind:
            continue
        if bar_on is None or q(c['timeSpan']['from']) <= bar_on < q(c['timeSpan']['to']):
            return c
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--request', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--ailegro-root', type=Path, default=Path.cwd())
    parser.add_argument('--threads', type=int, default=1)
    parser.add_argument('--dry-run', action='store_true', help='convert and validate only (no torch)')
    args = parser.parse_args()

    request = json.loads(args.request.read_text())
    if request.get('schema') != REQUEST_SCHEMA:
        raise SystemExit(f'expected {REQUEST_SCHEMA}, got {request.get("schema")}')
    if request['task'] not in SUPPORTED_TASKS:
        raise SystemExit(f'task {request["task"]!r} needs hard-locked material inside generated bars, '
                         f'which the v3.1 decoder does not support yet (supported: {", ".join(SUPPORTED_TASKS)})')
    env = load_ailegro(args.ailegro_root.resolve(), need_model=not args.dry_run)
    record = request['score']
    gen = request['generate']
    first = gen['bars']['from']
    count = gen['bars']['count']
    context_from = first - gen.get('contextBars', first)
    stats = {'remapped': 0, 'unknownQualities': 0, 'contextBars': 0, 'contextEvents': 0}
    measures = {m['number'] - 1: m for m in record['measures']}

    def key_of(bar: int):
        m = measures.get(bar)
        c = next((x for x in request['constraints'] if x['id'] == f'key-{bar}'), None)
        if c is None and m:
            c = constraint(request, 'key', q(m['on']))
        if c:
            return int(c['value']['tonic']), int(c['value']['mode'])
        if m and m.get('key') is not None:
            # notated key signature of a context bar -> (tonic pitch class, mode)
            fifths = int(m['key']['fifths'])
            minor = m['key'].get('mode') == 'minor'
            return ((fifths * 7 + (9 if minor else 0)) % 12, 1 if minor else 0)
        return None

    def tempo_at(on: Fraction) -> float:
        qpm = 100.0
        for t in record.get('tempo', []):
            if q(t['on']) <= on:
                qpm = float(t['qpm'])
        return qpm

    feeds = []
    for bar in range(context_from, first):
        m = measures[bar]
        events = bar_events(record, bar, env, stats)
        stats['contextBars'] += 1
        stats['contextEvents'] += len(events)
        feeds.append((bar, m, events))

    groups_c = constraint(request, 'groups')
    allowed = list(groups_c['value']['allowed']) if groups_c else list(env['GROUPS'])
    request_groups = bool(groups_c and groups_c['value'].get('request'))
    density_c = constraint(request, 'density')
    style_c = constraint(request, 'style')
    reference_c = constraint(request, 'reference')
    tempo_c = constraint(request, 'tempo')
    sampling = gen['sampling']
    plan = []
    last = measures[max(measures)] if measures else {'dur': '4', 'meter': [4, 4], 'on': '0'}
    for k in range(count):
        bar = first + k
        m = measures.get(bar)
        meter_c = next((x for x in request['constraints'] if x['id'] == f'meter-{bar}'), None)
        meter = tuple(meter_c['value']) if meter_c else tuple((m or last)['meter'])
        length = q(m['dur']) if m else Fraction(4 * meter[0], meter[1])
        chords = ()
        if gen['chordMode'] == 'given':
            chords = tuple((q(c['on']) - q(m['on']), int(c['root']) % 12, env['quality_index'][c['quality']])
                           for c in record.get('harmony', []) if m and c['bar'] == bar)
        key = key_of(bar)
        plan.append({'bar': bar, 'length': length, 'meter': meter, 'chords': chords,
                     'key': key if key and not gen.get('modelKeys') else (None if gen.get('modelKeys') and k else 'keep')})

    if args.dry_run:
        print(json.dumps({'ok': True, 'task': request['task'], 'stats': stats, 'generate': len(plan),
                          'allowedGroups': allowed, 'firstKey': key_of(context_from) or key_of(first)}, indent=1))
        return

    if not args.checkpoint or not args.output:
        raise SystemExit('--checkpoint and --output are required unless --dry-run')
    import torch  # noqa: E402
    torch.set_num_threads(args.threads)
    sample = env['sample']
    model, vocab, weights = sample.load(args.checkpoint)
    first_key = key_of(context_from) or key_of(first) or (0, 0)
    composer = sample.Composer(model, vocab, int(sampling['seed']), key=first_key)
    for bar, m, events in feeds:
        composer.feed_bar(events, length=q(m['dur']), meter=tuple(m['meter']), tempo=tempo_at(q(m['on'])),
                          key=key_of(bar) or 'keep')
    qpm = float(tempo_c['value']['qpm']) if tempo_c else tempo_at(q(last['on']))
    reference = gen.get('referencePolicy', 'auto')
    bars = []
    for item in plan:
        ref = 'auto' if reference == 'auto' else None
        if reference_c is not None:
            ref = int(reference_c['value']['bar']) - context_from
        bars.append(composer.next_bar(
            length=item['length'], meter=item['meter'], tempo=qpm, groups=allowed, request_groups=request_groups,
            density=density_c['value'] if density_c else None, key=item['key'],
            chord_mode='free' if gen['chordMode'] == 'given' else gen['chordMode'], chords=item['chords'],
            style=style_c['value'] if style_c else None, max_notes=int(gen.get('maxNotesPerBar', 128)),
            temperature=float(sampling['temperature']), top_p=float(sampling['topP']), reference=ref))
    result = {
        'schema': RESULT_SCHEMA,
        'requestId': request['requestId'],
        'model': {'name': 'four-pillar-v3.1', 'checkpoint': str(args.checkpoint),
                  'sha256': hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(), 'step': weights.get('step')},
        'seed': int(sampling['seed']),
        'startBar': first,
        'bars': bars,
        'warnings': ([f'{stats["remapped"]} context times were mapped to the nearest vocabulary value']
                     if stats['remapped'] else []),
    }
    args.output.write_text(json.dumps(result, indent=1, default=str))
    print(json.dumps({'bars': len(bars), 'notes': sum(len(b['notes']) for b in bars), 'output': str(args.output)}))


if __name__ == '__main__':
    main()
