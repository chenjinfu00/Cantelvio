#!/usr/bin/env python3
"""AIlegro Score -> AIlegro four-pillar v3.1 adapter (reference implementation).

Reads an `ailegro.compose-request/1` written by AIlegro Score, feeds the context bars to the
v3.1 composer through `feed_bar()` (exactly the generation path), writes the requested bars and
returns an `ailegro.compose-result/1` that AIlegro Score imports as reviewable suggestions.

Tasks (all five of the contract):

    continue            free continuation
    melody-from-chords  the score's chord symbols are locked; a bar without a symbol holds the chord
    accompany-melody    the material parts' notes are locked inside the generated bars and the model
                        writes the other parts around them; each bar is written --candidates times and
                        the version under which the given melody is most probable is kept
    orchestrate         the material parts' notes are locked, the model chooses the group and voice of
                        each note and may add octave/unison doublings (--doublings)
    develop-motif       each generated bar restates the motif bar (the last context bar holding material
                        notes, or the request's reference bar) through a reference: repeat, a diatonic
                        sequence, fragment, free bar, inversion, ... (see `four_pillar_v31_tasks`)

The locked-material tasks need AIlegro's `training/scripts/four_pillar_v31_tasks.py` (2026-10-02).
Context bars without chord symbols get chord changes from AIlegro's own chord tracker, as in training.

Run it from the AIlegro project root with AIlegro's own environment. Modes:

    # one request file -> one result file
    .venv-training/bin/python "<AIlegro Score>/integrations/ailegro/score_compose.py" \\
        --request request.json --checkpoint training/runs/<run>/weights.pt --output result.json

    # local server for the editor's "Generate" button (model loaded once, 127.0.0.1:8765)
    .venv-training/bin/python "<AIlegro Score>/integrations/ailegro/score_compose.py" \\
        --serve --checkpoint training/runs/<run>/weights.pt

    # conversion check against AIlegro's time vocabulary (no torch, no checkpoint)
    python3 "<AIlegro Score>/integrations/ailegro/score_compose.py" --request request.json --dry-run

    # placeholder music without AIlegro or torch, to test the editor round trip
    python3 "<AIlegro Score>/integrations/ailegro/score_compose.py" --serve --mock
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
from fractions import Fraction
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

REQUEST_SCHEMA = 'ailegro.compose-request/1'
RESULT_SCHEMA = 'ailegro.compose-result/1'
BASIC_TASKS = ('continue', 'melody-from-chords')
LOCKED_TASKS = ('accompany-melody', 'develop-motif', 'orchestrate')
SUPPORTED_TASKS = BASIC_TASKS + LOCKED_TASKS
# AIlegro's six native instrument groups (four_pillar_codec.GROUPS); used by --mock without AIlegro.
GROUPS_FALLBACK = ('woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings')
OUTSIDE_GROUPS = 6   # AIlegro's group index for parts outside the six groups (e.g. voices)
# Velocity used for given material that carries a score dynamic but no MIDI velocity.
DYNAMIC_VELOCITY = {'pppp': 20, 'ppp': 30, 'pp': 42, 'p': 56, 'mp': 70, 'mf': 84, 'f': 98, 'ff': 110, 'fff': 120,
                    'ffff': 127, 'sf': 108, 'sfz': 112, 'sffz': 118, 'fz': 108, 'fp': 98, 'sfp': 108, 'rf': 104,
                    'rfz': 108}
RESULT_NOTE_FIELDS = ('onset', 'duration', 'group', 'voice', 'pitch', 'drum', 'velocity', 'dynamic', 'accent',
                      'wedge')
DOUBLINGS = ('none', 'light', 'full')
MAX_BODY = 64 * 1024 * 1024


class AdapterError(Exception):
    """A request this adapter cannot run (reported as an error, not a crash)."""


def q(text: str) -> Fraction:
    return Fraction(text)


def qs(value: Fraction) -> str:
    return str(Fraction(value))


def load_ailegro(root: Path, need_model: bool, harmonizer: str = 'auto'):
    """AIlegro modules (and with need_model the torch-based ones). harmonizer: 'auto' loads AIlegro's
    melody -> chords model from its default run when present, 'none' never, otherwise a weights path."""
    scripts = root / 'training' / 'scripts'
    if not scripts.is_dir():
        raise AdapterError(f'not an AIlegro project root (missing {scripts}); pass --ailegro-root')
    sys.path.insert(0, str(scripts))
    from four_pillar_codec import DYNAMICS, GROUPS, WEDGES  # noqa: E402  (pure Python)
    from four_pillar_v31_time import TimeVocabulary  # noqa: E402  (pure Python)
    vocab = TimeVocabulary.load(root / 'training' / 'data' / 'four-pillar-v31-time-vocab.json')
    qualities = json.loads((root / 'training' / 'data' / 'chord-qualities.json').read_text())
    sample = tasks = tonal = None
    try:   # chord tracking for context bars without chord symbols (numpy only)
        import four_pillar_v31_tonal as tonal  # noqa: E402
        from score_events_v2 import ScoreEvents  # noqa: E402
    except ImportError:
        ScoreEvents = None
    if need_model:
        import four_pillar_v31_sample as sample  # noqa: E402  (needs torch)
        try:
            import four_pillar_v31_tasks as tasks  # noqa: E402  (locks, orchestration, references)
        except ImportError:
            tasks = None
    has_tasks = tasks is not None or (scripts / 'four_pillar_v31_tasks.py').is_file()
    chords_model = None
    if need_model and harmonizer != 'none':
        try:
            import harmonizer_v1  # noqa: E402  (melody -> chords, needs torch)
        except ImportError:
            harmonizer_v1 = None
        path = None
        if harmonizer_v1 is not None:
            path = harmonizer_v1.DEFAULT_WEIGHTS if harmonizer == 'auto' else Path(harmonizer)
        if path is not None and path.is_file():
            model, info = harmonizer_v1.load(path)
            chords_model = {'module': harmonizer_v1, 'model': model, 'info': info, 'path': str(path)}
        elif harmonizer not in ('auto', 'none'):
            raise AdapterError(f'harmonizer weights not found: {harmonizer}')
    return {'GROUPS': GROUPS, 'DYNAMICS': DYNAMICS, 'WEDGES': WEDGES, 'vocab': vocab,
            'quality_index': {qd['id']: i for i, qd in enumerate(qualities)}, 'qualities': qualities,
            'sample': sample, 'tasks': tasks, 'has_tasks': has_tasks,
            'tonal': tonal if ScoreEvents is not None else None, 'ScoreEvents': ScoreEvents,
            'harmonizer': chords_model}


def group_index(env: dict | None, group: str | None) -> int:
    groups = env['GROUPS'] if env is not None else GROUPS_FALLBACK
    return groups.index(group) if group in groups else OUTSIDE_GROUPS


def note_event(n: dict, start: Fraction, env: dict, stats: dict) -> dict:
    """One record note as a v3.1 feed event (onset relative to the bar start, vocabulary indices)."""
    dynamics, wedges, vocab = env['DYNAMICS'], env['WEDGES'], env['vocab']
    onset, remapped_on = vocab.lookup(q(n['on']) - start)
    duration, remapped_dur = vocab.lookup(q(n['dur']), positive=True)
    stats['remapped'] += remapped_on + remapped_dur
    unpitched = bool(n.get('unpitched')) or n.get('pitch') is None
    dyn = n.get('dynamic')
    wedge = n.get('wedge')
    velocity = n.get('velocity') or DYNAMIC_VELOCITY.get(dyn or '', 80)
    return {
        'kind': 'note',
        'onset': onset,
        'group': group_index(env, n.get('group')),
        'identity': (n['part'], str(n['staff']), str(n['voice'])),
        'pitch': 128 if unpitched else int(n['pitch']),
        'duration': duration,
        'velocity': max(1, min(127, int(velocity))),
        'dynamic': dynamics.index(dyn) + 1 if dyn in dynamics else 0,
        'accent': int(n.get('accent', 0)),
        'wedge': wedges.index(wedge) + 1 if wedge in wedges else 0,
        'drum': int(n.get('drum') or 38) if unpitched else None,  # GM snare when unknown
    }


def bar_events(record: dict, bar: int, env: dict, stats: dict, chords: list | None = None,
               current: list | None = None) -> list[dict]:
    """Feed events of one bar in AIlegro's commit order: per onset, chord changes first, then
    unpitched notes, then pitched notes from the lowest up. `chords` replaces the score's chord
    symbols ((offset, root, quality index), e.g. from the chord tracker); a change to the chord
    already in effect (`current[0]`, updated here) is skipped, as in training."""
    vocab = env['vocab']
    m = next(x for x in record['measures'] if x['number'] - 1 == bar)
    start = q(m['on'])
    rows = []
    if chords is None:
        chords = []
        for c in record.get('harmony', []):
            if c['bar'] != bar:
                continue
            quality = env['quality_index'].get(c['quality'])
            if quality is None:
                stats['unknownQualities'] += 1
                continue
            chords.append((q(c['on']) - start, int(c['root']) % 12, quality))
    for offset, root, quality in sorted(chords):
        if current is not None:
            if current[0] == (root, quality):
                stats['repeatedChords'] += 1
                continue
            current[0] = (root, quality)
        index, remapped = vocab.lookup(Fraction(offset))
        stats['remapped'] += remapped
        rows.append((start + Fraction(offset), 0, 0,
                     {'kind': 'chord', 'onset': index, 'root': root, 'quality': quality}))
    for n in record['notes']:
        if n['bar'] != bar or n.get('grace'):
            continue
        event = note_event(n, start, env, stats)
        rows.append((q(n['on']), 1, -1 if event['pitch'] == 128 else event['pitch'], event))
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    return [r[3] for r in rows]


def constraint(request: dict, kind: str, bar_on: Fraction | None = None):
    for c in request['constraints']:
        if c['kind'] != kind:
            continue
        if bar_on is None or q(c['timeSpan']['from']) <= bar_on < q(c['timeSpan']['to']):
            return c
    return None


def material_parts(request: dict, kind: str) -> list[str]:
    for m in request.get('material', []):
        if m.get('kind') == kind and m.get('parts'):
            return list(m['parts'])
    return []


def tracked_chords(record: dict, env: dict, bars: list[int], parts: list[str] | None, key_of) -> dict:
    """Chord changes per bar from AIlegro's chord tracker (the labeler used for v3.1's training data),
    over all notes of those bars or only `parts`. {bar: [(offset, root, quality index), ...]}"""
    tonal, ScoreEvents = env.get('tonal'), env.get('ScoreEvents')
    if tonal is None or not bars:
        return {}
    measures = {m['number'] - 1: m for m in record['measures']}
    order = sorted(set(bars))
    local = {bar: i for i, bar in enumerate(order)}
    notes = [dict(n, bar=local[n['bar']]) for n in record['notes']
             if n['bar'] in local and not n.get('grace') and (parts is None or n['part'] in parts)]
    if not notes:
        return {}
    view = {'scoreId': record.get('scoreId', 'request'), 'parts': record['parts'],
            'measures': [{'on': measures[b]['on'], 'dur': measures[b]['dur'], 'meter': measures[b]['meter']}
                         for b in order], 'notes': notes}
    score = ScoreEvents.from_candidate(view)
    keys = []
    for b in order:
        tonic, mode = key_of(b) or (0, 0)
        keys.append(tonal.key_id(tonic, mode))
    found = tonal.track_chords(score, keys, 0, len(order) - 1)
    return {order[i]: [(Fraction(o), int(r) % 12, int(qy)) for o, r, qy in found.get(i, ())] for i in range(len(order))}


def harmonized_chords(record: dict, env: dict, context: list[int], bars: list[int], parts: list[str],
                      in_effect) -> dict:
    """Chord changes for `bars` from AIlegro's harmonizer, read from the given melody (`parts`) over the context
    and generated bars. The chord in effect at the first generated bar is written there when it differs from
    the one the context left. {bar: [(offset, root, quality index), ...]}"""
    chords_model = env.get('harmonizer')
    if chords_model is None or not bars or not parts:
        return {}
    measures = {m['number'] - 1: m for m in record['measures']}
    order = [b for b in context + bars if b in measures]
    if any(b not in measures for b in bars) or not order:
        return {}
    t0 = q(measures[order[0]]['on'])
    shapes = [(q(measures[b]['dur']), tuple(measures[b]['meter']),
               (measures[b].get('key') or {}).get('fifths')) for b in order]
    notes = [(q(n['on']) - t0, q(n['dur']), int(n['pitch'])) for n in record['notes']
             if n['bar'] in measures and n['part'] in parts and not n.get('grace') and n.get('pitch') is not None
             and order[0] <= n['bar'] <= order[-1]]
    if not notes:
        return {}
    module = chords_model['module']
    changes, path = module.harmonize(chords_model['model'], chords_model['info'], notes, shapes)
    index = {b: i for i, b in enumerate(order)}
    out = {b: [(Fraction(o), int(r), int(qy)) for o, r, qy in changes.get(index[b], ())] for b in bars}
    first = bars[0]
    step = int(round(sum(shape[0] for shape in shapes[:index[first]]) * 4))
    start = int(path[min(step, len(path) - 1)])
    chord = (start % 12, start // 12)
    if (not out[first] or out[first][0][0] != 0) and chord != in_effect:
        out[first].insert(0, (Fraction(0), *chord))
    return out


def prepare(request: dict, env: dict | None) -> dict:
    """Validate a request and turn it into feeds (context bars) and a per-bar generation plan.
    `env` is None only for --mock without an AIlegro checkout (no context feeds then)."""
    if request.get('schema') != REQUEST_SCHEMA:
        raise AdapterError(f'expected {REQUEST_SCHEMA}, got {request.get("schema")}')
    task = request.get('task')
    if task not in SUPPORTED_TASKS:
        raise AdapterError(f'unknown task {task!r} (supported: {", ".join(SUPPORTED_TASKS)})')
    if task in LOCKED_TASKS and env is not None and not env.get('has_tasks'):
        raise AdapterError(f'task {task!r} needs AIlegro training/scripts/four_pillar_v31_tasks.py '
                           '(update the AIlegro folder)')
    record = request['score']
    gen = request['generate']
    first = gen['bars']['from']
    count = gen['bars']['count']
    context_from = first - gen.get('contextBars', first)
    stats = {'remapped': 0, 'unknownQualities': 0, 'contextBars': 0, 'contextEvents': 0, 'repeatedChords': 0,
             'trackedChordBars': 0, 'lockedNotes': 0, 'harmonizedBars': 0}
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

    given = material_parts(request, 'notes') if task in ('accompany-melody', 'orchestrate') else []
    motif_parts = material_parts(request, 'motif') if task == 'develop-motif' else []
    feeds = []
    current = [None]          # chord in effect while feeding
    context_bars = list(range(context_from, first))
    if env is not None:
        symbols = {c['bar'] for c in record.get('harmony', [])}
        tracked = {}
        if context_bars and not any(b in symbols for b in context_bars):
            tracked = tracked_chords(record, env, context_bars, None, key_of)
        for bar in context_bars:
            m = measures[bar]
            chords = tracked.get(bar) if tracked else None
            stats['trackedChordBars'] += chords is not None and bar in tracked
            events = bar_events(record, bar, env, stats, chords=chords, current=current)
            stats['contextBars'] += 1
            stats['contextEvents'] += len(events)
            feeds.append((bar, m, events))

    groups_c = constraint(request, 'groups')
    all_groups = list(env['GROUPS']) if env is not None else list(GROUPS_FALLBACK)
    allowed = list(groups_c['value']['allowed']) if groups_c else all_groups
    chord_mode = gen['chordMode']
    plan = []
    last = measures[max(measures)] if measures else {'dur': '4', 'meter': [4, 4], 'on': '0'}
    gen_bars = [first + k for k in range(count)]
    tracked_gen = {}
    if env is not None and task == 'orchestrate' and chord_mode != 'given':
        tracked_gen = tracked_chords(record, env, [b for b in gen_bars if b in measures], given, key_of)
    harmonized = {}
    if env is not None and task == 'accompany-melody' and chord_mode != 'given':
        harmonized = harmonized_chords(record, env, context_bars, gen_bars, given, current[0])
    in_effect = current[0]
    for k, bar in enumerate(gen_bars):
        m = measures.get(bar)
        meter_c = next((x for x in request['constraints'] if x['id'] == f'meter-{bar}'), None)
        meter = tuple(meter_c['value']) if meter_c else tuple((m or last)['meter'])
        length = q(m['dur']) if m else Fraction(4 * meter[0], meter[1])
        start = q(m['on']) if m else None
        chords, item_mode = (), chord_mode
        if chord_mode == 'given':
            symbols_here = [c for c in record.get('harmony', []) if c['bar'] == bar] if m else []
            found = []
            for c in sorted(symbols_here, key=lambda c: q(c['on'])):
                quality = c['quality'] if env is None else env['quality_index'].get(c['quality'])
                if quality is None:
                    stats['unknownQualities'] += 1
                    continue
                if (int(c['root']) % 12, quality) == in_effect:
                    stats['repeatedChords'] += 1
                    continue
                in_effect = (int(c['root']) % 12, quality)
                found.append((q(c['on']) - start, int(c['root']) % 12, quality))
            chords = tuple(found)
            item_mode = 'free' if chords else 'hold'    # no symbol in this bar: keep the chord in effect
        elif bar in tracked_gen:
            chords = tuple(tracked_gen[bar])
            item_mode = 'free' if chords else 'hold'
        elif bar in harmonized:
            chords = tuple(harmonized[bar])
            item_mode = 'free' if chords else 'hold'
            stats['harmonizedBars'] += 1
        locks = []
        if given and m:
            for n in record['notes']:
                if n['bar'] != bar or n['part'] not in given or n.get('grace'):
                    continue
                locks.append(n)
            stats['lockedNotes'] += len(locks)
        key = key_of(bar)
        plan.append({'bar': bar, 'length': length, 'meter': meter, 'chords': chords, 'chordMode': item_mode,
                     'start': start, 'locks': locks,
                     'key': key if key and not gen.get('modelKeys') else (None if gen.get('modelKeys') and k else 'keep')})
    motif = None
    if task == 'develop-motif':
        motif = find_motif(request, record, measures, context_bars, motif_parts)
    return {
        'request': request, 'record': record, 'gen': gen, 'first': first, 'count': count, 'task': task,
        'context_from': context_from, 'stats': stats, 'feeds': feeds, 'plan': plan, 'last': last,
        'allowed': allowed, 'request_groups': bool(groups_c and groups_c['value'].get('request')),
        'density': constraint(request, 'density'), 'style': constraint(request, 'style'),
        'reference': constraint(request, 'reference'), 'tempo': constraint(request, 'tempo'),
        'key_of': key_of, 'tempo_at': tempo_at, 'given_parts': given, 'motif': motif,
    }


def find_motif(request: dict, record: dict, measures: dict, context_bars: list[int], parts: list[str]) -> dict:
    """The motif bar: the request's reference bar, else the last context bar holding notes of the motif parts."""
    if not context_bars:
        raise AdapterError('develop-motif needs the motif in context bars before the generated range')
    ref = constraint(request, 'reference')
    if ref is not None:
        bar = int(ref['value']['bar'])
        if bar not in context_bars:
            raise AdapterError(f'reference bar {bar + 1} is not among the context bars')
    else:
        holding = [b for b in context_bars
                   if any(n['bar'] == b and (not parts or n['part'] in parts) and not n.get('grace')
                          for n in record['notes'])]
        if not holding:
            raise AdapterError('no motif notes in the context (choose the parts holding the motif)')
        bar = holding[-1]
    notes = [n for n in record['notes'] if n['bar'] == bar and not n.get('grace')]
    return {'bar': bar, 'start': q(measures[bar]['on']), 'length': q(measures[bar]['dur']),
            'parts': parts, 'notes': notes}


def dry_run_report(prep: dict) -> dict:
    key_of = prep['key_of']
    report = {'ok': True, 'task': prep['request']['task'], 'stats': prep['stats'], 'generate': len(prep['plan']),
              'allowedGroups': prep['allowed'], 'firstKey': key_of(prep['context_from']) or key_of(prep['first']),
              'chordModes': [item['chordMode'] for item in prep['plan']],
              'locksPerBar': [len(item['locks']) for item in prep['plan']]}
    if prep['motif']:
        report['motifBar'] = prep['motif']['bar']
    return report


def result_document(prep: dict, model: dict, bars: list, warnings: list[str]) -> dict:
    stats = prep['stats']
    notes = list(warnings)
    if stats['remapped']:
        notes.append(f'{stats["remapped"]} context times were mapped to the nearest vocabulary value')
    if stats.get('trackedChordBars'):
        notes.append(f'chords of {stats["trackedChordBars"]} context bars estimated by the AIlegro chord tracker')
    if stats.get('harmonizedBars'):
        notes.append(f'chords of {stats["harmonizedBars"]} bars from the AIlegro harmonizer (read from the given '
                     'melody); edit the chord symbols and generate with given chords to change them')
    return {
        'schema': RESULT_SCHEMA,
        'requestId': prep['request']['requestId'],
        'model': model,
        'seed': int(prep['gen']['sampling']['seed']),
        'startBar': prep['first'],
        'bars': bars,
        'warnings': notes,
    }


def result_bar(bar: dict, keep) -> dict:
    """A generated bar in the result schema (only the contract's fields)."""
    out = {k: bar[k] for k in ('bar', 'length', 'meter', 'key', 'chords', 'resourceClosure') if k in bar}
    out['reference'] = bar['reference'] if isinstance(bar.get('reference'), int) else None
    out['notes'] = [{k: n[k] for k in RESULT_NOTE_FIELDS} for n in bar['notes'] if keep(n)]
    return out


class Model:
    """A v3.1 checkpoint loaded once; `compose()` runs one request with a fresh, seeded composer."""

    def __init__(self, env: dict, checkpoint: Path, threads: int, candidates: int = 16, doublings: str = 'light'):
        import torch  # noqa: E402
        torch.set_num_threads(threads)
        self.env = env
        self.checkpoint = checkpoint
        self.sha256 = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
        self.model, self.vocab, self.weights = env['sample'].load(checkpoint)
        self.name = 'four-pillar-v3.1'
        self.candidates = max(1, int(candidates))
        if doublings not in DOUBLINGS:
            raise AdapterError(f'--doublings must be one of {", ".join(DOUBLINGS)}')
        self.doublings = doublings

    def describe(self) -> dict:
        return {'name': self.name, 'checkpoint': str(self.checkpoint), 'sha256': self.sha256,
                'step': self.weights.get('step')}

    def lock(self, n: dict, start: Fraction, orchestrate: bool):
        env = self.env
        unpitched = bool(n.get('unpitched')) or n.get('pitch') is None
        dyn, wedge = n.get('dynamic'), n.get('wedge')
        return env['tasks'].Lock(
            onset=q(n['on']) - start, pitch=None if unpitched else int(n['pitch']), duration=q(n['dur']),
            group=None if orchestrate else group_index(env, n.get('group')),
            identity=None if orchestrate else (n['part'], str(n['staff']), str(n['voice'])),
            unpitched=unpitched, drum=int(n.get('drum') or 38) if unpitched else None,
            velocity=max(1, min(127, int(n.get('velocity') or DYNAMIC_VELOCITY.get(dyn or '', 80)))),
            dynamic=env['DYNAMICS'].index(dyn) + 1 if dyn in env['DYNAMICS'] else 0,
            accent=int(n.get('accent', 0)), wedge=env['WEDGES'].index(wedge) + 1 if wedge in env['WEDGES'] else 0,
            tag=n.get('id'))

    def motif_reference(self, prep: dict, how: str, steps: int, composer):
        """('reference' argument for the bar, description)."""
        tasks, motif = self.env['tasks'], prep['motif']
        bank_index = motif['bar'] - prep['context_from']
        label = {'repeat': 'restates', 'sequence': f'sequence {steps:+d} step(s) of', 'fragment': 'fragments',
                 'invert': 'inverts', 'diminish': 'diminution of', 'free': 'free bar after'}[how]
        if how == 'repeat':
            return bank_index, f'{label} bar {motif["bar"] + 1}'
        if how == 'free':
            return 'auto', f'{label} bar {motif["bar"] + 1}'
        tonic, mode = prep['key_of'](motif['bar']) or (0, 0)
        notes = [{'onset': q(n['on']) - motif['start'], 'duration': q(n['dur']),
                  'pitch': None if n.get('unpitched') or n.get('pitch') is None else int(n['pitch']),
                  'group': group_index(self.env, n.get('group')), 'part': n['part']} for n in motif['notes']]
        line = [n for n in notes if not motif['parts'] or n['part'] in motif['parts']]
        if how == 'invert':
            moved = tasks.transform_motif(line, motif['length'], tonic=tonic, mode=mode, how='invert')[0]
            pitched = [n['pitch'] for n in moved if n['pitch'] is not None]
            low = min(pitched) if pitched else 0
            rest = [n for n in notes if n not in line and (n['pitch'] is None or n['pitch'] < low)]
            texture = moved + rest
        else:   # time transformations and sequences move the whole texture
            texture = tasks.transform_motif(notes, motif['length'], tonic=tonic, mode=mode, how=how, steps=steps)[0]
        reference = tasks.reference_from_notes(texture, self.vocab, tonic=tonic, length=motif['length'])
        return reference, f'{label} bar {motif["bar"] + 1}'

    def compose(self, prep: dict) -> dict:
        env, task = self.env, prep['task']
        sample, tasks = env['sample'], env['tasks']
        if task in LOCKED_TASKS and tasks is None:
            raise AdapterError(f'task {task!r} needs AIlegro training/scripts/four_pillar_v31_tasks.py')
        key_of, tempo_at, gen = prep['key_of'], prep['tempo_at'], prep['gen']
        sampling = gen['sampling']
        first_key = key_of(prep['context_from']) or key_of(prep['first']) or (0, 0)
        cls = tasks.TaskComposer if tasks is not None else sample.Composer
        composer = cls(self.model, self.vocab, int(sampling['seed']), key=first_key)
        for bar, m, events in prep['feeds']:
            composer.feed_bar(events, length=q(m['dur']), meter=tuple(m['meter']), tempo=tempo_at(q(m['on'])),
                              key=key_of(bar) or 'keep')
        tempo_c, density_c, style_c, reference_c = prep['tempo'], prep['density'], prep['style'], prep['reference']
        qpm = float(tempo_c['value']['qpm']) if tempo_c else tempo_at(q(prep['last']['on']))
        reference = gen.get('referencePolicy', 'auto')
        allowed = prep['allowed']
        plan = tasks.development_plan(len(prep['plan'])) if task == 'develop-motif' else None
        bars, warnings, described, scores = [], [], [], []
        for k, item in enumerate(prep['plan']):
            ref = 'auto' if reference == 'auto' else None
            if reference_c is not None and task != 'develop-motif':
                ref = int(reference_c['value']['bar']) - prep['context_from']
            common = dict(length=item['length'], meter=item['meter'], tempo=qpm, groups=allowed,
                          request_groups=prep['request_groups'], density=density_c['value'] if density_c else None,
                          key=item['key'], chord_mode=item['chordMode'], chords=item['chords'],
                          style=style_c['value'] if style_c else None, max_notes=int(gen.get('maxNotesPerBar', 128)),
                          temperature=float(sampling['temperature']), top_p=float(sampling['topP']))
            keep = lambda n: True  # noqa: E731
            if tasks is None:
                bar = composer.next_bar(reference=ref, **common)
            elif task == 'accompany-melody':
                locks = [self.lock(n, item['start'], False) for n in item['locks']]
                outside = any(lk.group == OUTSIDE_GROUPS for lk in locks)
                common['request_groups'] = common['request_groups'] and not outside   # as in training
                bar = composer.best_of(self.candidates, reference=ref, locks=locks, **common)
                if locks:
                    scores.append(bar['lockScore'] / len(locks))
                keep = lambda n: not n.get('locked')  # noqa: E731   the melody is already in the score
            elif task == 'orchestrate':
                locks = [self.lock(n, item['start'], True) for n in item['locks']]
                filt, cap = None, 0
                if self.doublings != 'none' and locks:
                    spans = [(lk.onset, lk.onset + lk.duration, lk.pitch % 12) for lk in locks if lk.pitch is not None]
                    filt = lambda pos, g, p, spans=spans: p is not None and any(  # noqa: E731
                        a <= pos < b and p % 12 == pc for a, b, pc in spans)
                    cap = len(locks) // 2 if self.doublings == 'light' else common['max_notes']
                common['max_notes'] = cap
                common['request_groups'] = True    # the user chose these groups to orchestrate for
                bar = composer.next_bar_locked(reference=ref, locks=locks, free_notes=cap > 0, free_filter=filt,
                                               **common)
            elif task == 'develop-motif':
                how, steps = plan[k]
                ref, text = self.motif_reference(prep, how, steps, composer)
                described.append(f'{item["bar"] + 1}: {text}')
                bar = composer.next_bar_locked(reference=ref, **common)
            else:
                bar = composer.next_bar_locked(reference=ref, **common)
            bars.append(result_bar(bar, keep))
        if task == 'develop-motif' and described:
            warnings.append('motif development (bar: plan): ' + '; '.join(described))
        if task == 'accompany-melody':
            warnings.append(f'accompaniment: best of {self.candidates} per bar; melody log-probability per note '
                            f'{sum(scores) / max(1, len(scores)):.2f}')
        if task == 'orchestrate':
            warnings.append(f'orchestration: groups chosen per given note; doublings {self.doublings}')
        # next_bar() returns Fractions; the result document carries fraction strings.
        bars = json.loads(json.dumps(bars, default=str))
        return result_document(prep, self.describe(), bars, warnings)


# ------------------------------------------------------------------------------------------ mock

MAJOR = (0, 2, 4, 5, 7, 9, 11)
MINOR = (0, 2, 3, 5, 7, 8, 10)
MELODY_PREFERENCE = ('high_strings', 'woodwinds', 'keys', 'brass')
BASS_PREFERENCE = ('low_strings', 'keys', 'brass', 'woodwinds')


class MockModel:
    """Deterministic placeholder music in AIlegro's result format (scales over a tonic bass; given notes copied
    for orchestrate, the motif bar repeated for develop-motif, a bass line only for accompany-melody).
    It is NOT AIlegro output; it exists to test the editor <-> adapter round trip anywhere."""

    name = 'mock'

    def describe(self) -> dict:
        return {'name': self.name}

    def compose(self, prep: dict) -> dict:
        allowed = [g for g in prep['allowed'] if g != 'percussion']
        melody = next((g for g in MELODY_PREFERENCE if g in allowed), None)
        # bass in another group, or a second voice of the same group (e.g. piano left hand)
        bass = next((g for g in BASS_PREFERENCE if g in allowed and g != melody), melody)
        bass_voice = 1 if bass == melody else 0
        key = prep['key_of'](prep['first']) or prep['key_of'](prep['context_from']) or (0, 0)
        seed = int(prep['gen']['sampling']['seed'])
        task = prep['task']
        bars = []
        for k, item in enumerate(prep['plan']):
            if isinstance(item['key'], tuple):
                key = item['key']
            tonic, mode = key
            scale = MINOR if mode else MAJOR
            meter = item['meter']
            step = Fraction(1) if meter[1] <= 4 else Fraction(1, 2)
            notes = []

            def note(onset, duration, group, voice, pitch):
                return {'onset': qs(onset), 'duration': qs(duration), 'group': group, 'voice': voice, 'pitch': pitch,
                        'drum': None, 'velocity': 76, 'dynamic': None, 'accent': 0, 'wedge': None}

            if task == 'orchestrate' and item['start'] is not None:
                for n in item['locks']:
                    if n.get('pitch') is None:
                        continue
                    group = (melody if n['pitch'] >= 60 else bass) or allowed[0]
                    notes.append(note(q(n['on']) - item['start'], q(n['dur']), group, 0 if n['pitch'] >= 60 else 1,
                                      int(n['pitch'])))
            elif task == 'develop-motif' and prep['motif'] and melody:
                for n in prep['motif']['notes']:
                    if n.get('pitch') is not None and q(n['on']) - prep['motif']['start'] < item['length']:
                        notes.append(note(q(n['on']) - prep['motif']['start'], q(n['dur']), melody, 0, int(n['pitch'])))
            elif melody and task != 'accompany-melody':
                t, i = Fraction(0), 0
                while t < item['length']:
                    dur = min(step, item['length'] - t)
                    degree = (seed + k * 2 + i) % 8
                    degree = degree if degree < 5 else 8 - degree
                    notes.append(note(t, dur, melody, 0, 72 + tonic + scale[degree % 7] - (12 if tonic > 5 else 0)))
                    t += dur
                    i += 1
            roots = [(on, root) for on, root, _ in item['chords']] or [(Fraction(0), tonic)]
            if bass and task != 'orchestrate':
                for j, (on, root) in enumerate(roots):
                    end = roots[j + 1][0] if j + 1 < len(roots) else item['length']
                    notes.append(note(on, end - on, bass, bass_voice, 48 + root - (12 if root > 7 else 0)))
            chords = [{'onset': qs(on), 'root': root % 12, 'quality': quality}
                      for on, root, quality in item['chords']] or [{'onset': '0', 'root': tonic, 'quality': 'min' if mode else 'maj'}]
            bars.append({'bar': item['bar'], 'length': qs(item['length']), 'meter': list(meter),
                         'key': {'tonic': tonic, 'mode': mode}, 'chords': chords, 'notes': notes})
        return result_document(prep, self.describe(), bars, ['mock generator: placeholder music, not AIlegro output'])


# ------------------------------------------------------------------------------------------ server

LOOPBACK = {'localhost', '127.0.0.1', '::1'}


def make_handler(model, env, allow_origins: set[str]):
    lock = threading.Lock()
    tasks = list(SUPPORTED_TASKS if isinstance(model, MockModel) or (env and env.get('tasks')) else BASIC_TASKS)

    class Handler(BaseHTTPRequestHandler):
        server_version = 'AIlegroScoreAdapter/1'

        def log_message(self, fmt, *args):  # quieter than the default, still on stderr
            sys.stderr.write('[adapter] ' + (fmt % args) + '\n')

        def origin_allowed(self) -> str | None:
            origin = self.headers.get('Origin')
            if not origin:
                return None
            host = urlsplit(origin).hostname or ''
            return origin if host in LOOPBACK or origin in allow_origins else None

        def send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, default=str).encode()
            self.send_response(status)
            origin = self.origin_allowed()
            if origin:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):  # CORS preflight
            self.send_response(204)
            origin = self.origin_allowed()
            if origin:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type')
                self.send_header('Access-Control-Max-Age', '600')
                if self.headers.get('Access-Control-Request-Private-Network') == 'true':
                    self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.end_headers()

        def do_GET(self):
            if urlsplit(self.path).path != '/health':
                self.send_json(404, {'error': 'not found'})
                return
            self.send_json(200, {'ok': True, 'model': model.name, 'mock': isinstance(model, MockModel),
                                 'tasks': tasks, 'request': REQUEST_SCHEMA, 'result': RESULT_SCHEMA})

        def do_POST(self):
            if urlsplit(self.path).path != '/compose':
                self.send_json(404, {'error': 'not found'})
                return
            if self.headers.get('Origin') and not self.origin_allowed():
                self.send_json(403, {'error': 'origin not allowed (use --allow-origin)'})
                return
            size = int(self.headers.get('Content-Length') or 0)
            if size <= 0 or size > MAX_BODY:
                self.send_json(400, {'error': 'missing or oversized request body'})
                return
            try:
                request = json.loads(self.rfile.read(size))
                prep = prepare(request, env)
                with lock:  # one generation at a time
                    result = model.compose(prep)
                self.send_json(200, result)
            except AdapterError as e:
                self.send_json(422, {'error': str(e)})
            except (ValueError, KeyError, TypeError) as e:
                self.send_json(400, {'error': f'invalid request: {e!r}'})
            except Exception as e:  # noqa: BLE001  report generation failures to the editor
                self.send_json(500, {'error': f'generation failed: {e!r}'})

    return Handler


def serve(model, env, host: str, port: int, allow_origins: set[str]) -> None:
    if host not in LOOPBACK:
        print(f'warning: listening on {host}; anyone on the network can use this model', file=sys.stderr)
    httpd = ThreadingHTTPServer((host, port), make_handler(model, env, allow_origins))
    print(f'AIlegro adapter ({model.name}) on http://{host}:{port}  — POST /compose, GET /health', file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--request', type=Path, help='compose request file (file mode)')
    parser.add_argument('--output', type=Path, help='result file to write (file mode)')
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--ailegro-root', type=Path, default=Path.cwd())
    parser.add_argument('--threads', type=int, default=1)
    parser.add_argument('--candidates', type=int, default=16,
                        help='accompany-melody: versions written per bar; the one fitting the melody best is kept')
    parser.add_argument('--harmonizer', default='auto',
                        help="accompany-melody without given chords: 'auto' uses AIlegro's melody -> chords model "
                             "when its weights are present, 'none' lets v3.1 choose, or a weights path")
    parser.add_argument('--doublings', choices=DOUBLINGS, default='light',
                        help='orchestrate: octave/unison doublings the model may add (light: at most half as '
                             'many as the given notes)')
    parser.add_argument('--dry-run', action='store_true', help='convert and validate only (no torch)')
    parser.add_argument('--mock', action='store_true', help='placeholder music instead of the model (testing)')
    parser.add_argument('--serve', action='store_true', help='run a local HTTP server for the editor')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--allow-origin', action='append', default=[],
                        help='extra browser origin allowed to call the server (loopback origins always are)')
    args = parser.parse_args()

    try:
        env = None
        if not args.mock or (args.ailegro_root / 'training' / 'scripts').is_dir():
            env = load_ailegro(args.ailegro_root.resolve(), need_model=not (args.dry_run or args.mock),
                               harmonizer=args.harmonizer)
        if args.serve:
            if args.mock:
                model = MockModel()
            elif not args.checkpoint:
                raise AdapterError('--serve needs --checkpoint (or --mock)')
            else:
                model = Model(env, args.checkpoint, args.threads, args.candidates, args.doublings)
            serve(model, env, args.host, args.port, set(args.allow_origin))
            return
        if not args.request:
            raise AdapterError('--request is required (or use --serve)')
        prep = prepare(json.loads(args.request.read_text()), env)
        if args.dry_run:
            print(json.dumps(dry_run_report(prep), indent=1, default=str))
            return
        if not args.output or (not args.checkpoint and not args.mock):
            raise AdapterError('--output and --checkpoint (or --mock) are required unless --dry-run')
        model = MockModel() if args.mock else Model(env, args.checkpoint, args.threads, args.candidates,
                                                    args.doublings)
        result = model.compose(prep)
        args.output.write_text(json.dumps(result, indent=1, default=str))
        print(json.dumps({'bars': len(result['bars']), 'notes': sum(len(b['notes']) for b in result['bars']),
                          'output': str(args.output)}))
    except AdapterError as e:
        raise SystemExit(f'error: {e}') from None


if __name__ == '__main__':
    main()
