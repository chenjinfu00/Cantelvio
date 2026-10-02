#!/usr/bin/env python3
"""AIlegro Score -> AIlegro four-pillar v3.1 adapter (reference implementation).

Reads an `ailegro.compose-request/1` written by AIlegro Score, feeds the context bars to the
v3.1 `Composer` through `feed_bar()` (exactly the generation path), generates the requested
bars with `next_bar()` and writes an `ailegro.compose-result/1` that AIlegro Score imports as
reviewable suggestions.

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
import threading
from fractions import Fraction
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

REQUEST_SCHEMA = 'ailegro.compose-request/1'
RESULT_SCHEMA = 'ailegro.compose-result/1'
SUPPORTED_TASKS = ('continue', 'melody-from-chords')
# AIlegro's six native instrument groups (four_pillar_codec.GROUPS); used by --mock without AIlegro.
GROUPS_FALLBACK = ('woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings')
# Velocity used for given material that carries a score dynamic but no MIDI velocity.
DYNAMIC_VELOCITY = {'pppp': 20, 'ppp': 30, 'pp': 42, 'p': 56, 'mp': 70, 'mf': 84, 'f': 98, 'ff': 110, 'fff': 120,
                    'ffff': 127, 'sf': 108, 'sfz': 112, 'sffz': 118, 'fz': 108, 'fp': 98, 'sfp': 108, 'rf': 104,
                    'rfz': 108}
MAX_BODY = 64 * 1024 * 1024


class AdapterError(Exception):
    """A request this adapter cannot run (reported as an error, not a crash)."""


def q(text: str) -> Fraction:
    return Fraction(text)


def qs(value: Fraction) -> str:
    return str(Fraction(value))


def load_ailegro(root: Path, need_model: bool):
    scripts = root / 'training' / 'scripts'
    if not scripts.is_dir():
        raise AdapterError(f'not an AIlegro project root (missing {scripts}); pass --ailegro-root')
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


def prepare(request: dict, env: dict | None) -> dict:
    """Validate a request and turn it into feeds (context bars) and a per-bar generation plan.
    `env` is None only for --mock without an AIlegro checkout (no context feeds then)."""
    if request.get('schema') != REQUEST_SCHEMA:
        raise AdapterError(f'expected {REQUEST_SCHEMA}, got {request.get("schema")}')
    if request.get('task') not in SUPPORTED_TASKS:
        raise AdapterError(f'task {request.get("task")!r} needs hard-locked material inside generated bars, '
                           f'which the v3.1 decoder does not support yet (supported: {", ".join(SUPPORTED_TASKS)})')
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
    if env is not None:
        for bar in range(context_from, first):
            m = measures[bar]
            events = bar_events(record, bar, env, stats)
            stats['contextBars'] += 1
            stats['contextEvents'] += len(events)
            feeds.append((bar, m, events))

    groups_c = constraint(request, 'groups')
    all_groups = list(env['GROUPS']) if env is not None else list(GROUPS_FALLBACK)
    allowed = list(groups_c['value']['allowed']) if groups_c else all_groups
    plan = []
    last = measures[max(measures)] if measures else {'dur': '4', 'meter': [4, 4], 'on': '0'}
    for k in range(count):
        bar = first + k
        m = measures.get(bar)
        meter_c = next((x for x in request['constraints'] if x['id'] == f'meter-{bar}'), None)
        meter = tuple(meter_c['value']) if meter_c else tuple((m or last)['meter'])
        length = q(m['dur']) if m else Fraction(4 * meter[0], meter[1])
        chords = ()
        if gen['chordMode'] == 'given' and m:
            given = [c for c in record.get('harmony', []) if c['bar'] == bar]
            if env is not None:
                chords = tuple((q(c['on']) - q(m['on']), int(c['root']) % 12, env['quality_index'][c['quality']])
                               for c in given)
            else:
                chords = tuple((q(c['on']) - q(m['on']), int(c['root']) % 12, c['quality']) for c in given)
        key = key_of(bar)
        plan.append({'bar': bar, 'length': length, 'meter': meter, 'chords': chords,
                     'key': key if key and not gen.get('modelKeys') else (None if gen.get('modelKeys') and k else 'keep')})
    return {
        'request': request, 'record': record, 'gen': gen, 'first': first, 'count': count,
        'context_from': context_from, 'stats': stats, 'feeds': feeds, 'plan': plan, 'last': last,
        'allowed': allowed, 'request_groups': bool(groups_c and groups_c['value'].get('request')),
        'density': constraint(request, 'density'), 'style': constraint(request, 'style'),
        'reference': constraint(request, 'reference'), 'tempo': constraint(request, 'tempo'),
        'key_of': key_of, 'tempo_at': tempo_at,
    }


def dry_run_report(prep: dict) -> dict:
    key_of = prep['key_of']
    return {'ok': True, 'task': prep['request']['task'], 'stats': prep['stats'], 'generate': len(prep['plan']),
            'allowedGroups': prep['allowed'], 'firstKey': key_of(prep['context_from']) or key_of(prep['first'])}


def result_document(prep: dict, model: dict, bars: list, warnings: list[str]) -> dict:
    stats = prep['stats']
    notes = list(warnings)
    if stats['remapped']:
        notes.append(f'{stats["remapped"]} context times were mapped to the nearest vocabulary value')
    return {
        'schema': RESULT_SCHEMA,
        'requestId': prep['request']['requestId'],
        'model': model,
        'seed': int(prep['gen']['sampling']['seed']),
        'startBar': prep['first'],
        'bars': bars,
        'warnings': notes,
    }


class Model:
    """A v3.1 checkpoint loaded once; `compose()` runs one request with a fresh, seeded Composer."""

    def __init__(self, env: dict, checkpoint: Path, threads: int):
        import torch  # noqa: E402
        torch.set_num_threads(threads)
        self.env = env
        self.checkpoint = checkpoint
        self.sha256 = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
        self.model, self.vocab, self.weights = env['sample'].load(checkpoint)
        self.name = 'four-pillar-v3.1'

    def describe(self) -> dict:
        return {'name': self.name, 'checkpoint': str(self.checkpoint), 'sha256': self.sha256,
                'step': self.weights.get('step')}

    def compose(self, prep: dict) -> dict:
        sample = self.env['sample']
        key_of, tempo_at, gen = prep['key_of'], prep['tempo_at'], prep['gen']
        sampling = gen['sampling']
        first_key = key_of(prep['context_from']) or key_of(prep['first']) or (0, 0)
        composer = sample.Composer(self.model, self.vocab, int(sampling['seed']), key=first_key)
        for bar, m, events in prep['feeds']:
            composer.feed_bar(events, length=q(m['dur']), meter=tuple(m['meter']), tempo=tempo_at(q(m['on'])),
                              key=key_of(bar) or 'keep')
        tempo_c, density_c, style_c, reference_c = prep['tempo'], prep['density'], prep['style'], prep['reference']
        qpm = float(tempo_c['value']['qpm']) if tempo_c else tempo_at(q(prep['last']['on']))
        reference = gen.get('referencePolicy', 'auto')
        bars = []
        for item in prep['plan']:
            ref = 'auto' if reference == 'auto' else None
            if reference_c is not None:
                ref = int(reference_c['value']['bar']) - prep['context_from']
            bars.append(composer.next_bar(
                length=item['length'], meter=item['meter'], tempo=qpm, groups=prep['allowed'],
                request_groups=prep['request_groups'], density=density_c['value'] if density_c else None,
                key=item['key'], chord_mode='free' if gen['chordMode'] == 'given' else gen['chordMode'],
                chords=item['chords'], style=style_c['value'] if style_c else None,
                max_notes=int(gen.get('maxNotesPerBar', 128)), temperature=float(sampling['temperature']),
                top_p=float(sampling['topP']), reference=ref))
        # next_bar() returns Fractions; the result document carries fraction strings.
        bars = json.loads(json.dumps(bars, default=str))
        return result_document(prep, self.describe(), bars, [])


# ------------------------------------------------------------------------------------------ mock

MAJOR = (0, 2, 4, 5, 7, 9, 11)
MINOR = (0, 2, 3, 5, 7, 8, 10)
MELODY_PREFERENCE = ('high_strings', 'woodwinds', 'keys', 'brass')
BASS_PREFERENCE = ('low_strings', 'keys', 'brass', 'woodwinds')


class MockModel:
    """Deterministic placeholder music (scales over a tonic bass) in AIlegro's result format.
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
        bars = []
        for k, item in enumerate(prep['plan']):
            if isinstance(item['key'], tuple):
                key = item['key']
            tonic, mode = key
            scale = MINOR if mode else MAJOR
            meter = item['meter']
            step = Fraction(1) if meter[1] <= 4 else Fraction(1, 2)
            notes = []
            if melody:
                t, i = Fraction(0), 0
                while t < item['length']:
                    dur = min(step, item['length'] - t)
                    degree = (seed + k * 2 + i) % 8
                    degree = degree if degree < 5 else 8 - degree
                    notes.append({'onset': qs(t), 'duration': qs(dur), 'group': melody, 'voice': 0,
                                  'pitch': 72 + tonic + scale[degree % 7] - (12 if tonic > 5 else 0), 'drum': None,
                                  'velocity': 76, 'dynamic': None, 'accent': 0, 'wedge': None})
                    t += dur
                    i += 1
            roots = [(on, root) for on, root, _ in item['chords']] or [(Fraction(0), tonic)]
            if bass:
                for j, (on, root) in enumerate(roots):
                    end = roots[j + 1][0] if j + 1 < len(roots) else item['length']
                    notes.append({'onset': qs(on), 'duration': qs(end - on), 'group': bass, 'voice': bass_voice,
                                  'pitch': 48 + root - (12 if root > 7 else 0), 'drum': None, 'velocity': 70,
                                  'dynamic': None, 'accent': 0, 'wedge': None})
            chords = [{'onset': qs(on), 'root': root % 12, 'quality': quality}
                      for on, root, quality in item['chords']] or [{'onset': '0', 'root': tonic, 'quality': 'min' if mode else 'maj'}]
            bars.append({'bar': item['bar'], 'length': qs(item['length']), 'meter': list(meter),
                         'key': {'tonic': tonic, 'mode': mode}, 'chords': chords, 'notes': notes})
        return result_document(prep, self.describe(), bars, ['mock generator: placeholder music, not AIlegro output'])


# ------------------------------------------------------------------------------------------ server

LOOPBACK = {'localhost', '127.0.0.1', '::1'}


def make_handler(model, env, allow_origins: set[str]):
    lock = threading.Lock()

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
                                 'tasks': list(SUPPORTED_TASKS), 'request': REQUEST_SCHEMA, 'result': RESULT_SCHEMA})

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
            env = load_ailegro(args.ailegro_root.resolve(), need_model=not (args.dry_run or args.mock))
        if args.serve:
            if args.mock:
                model = MockModel()
            elif not args.checkpoint:
                raise AdapterError('--serve needs --checkpoint (or --mock)')
            else:
                model = Model(env, args.checkpoint, args.threads)
            serve(model, env, args.host, args.port, set(args.allow_origin))
            return
        if not args.request:
            raise AdapterError('--request is required (or use --serve)')
        prep = prepare(json.loads(args.request.read_text()), env)
        if args.dry_run:
            print(json.dumps(dry_run_report(prep), indent=1))
            return
        if not args.output or (not args.checkpoint and not args.mock):
            raise AdapterError('--output and --checkpoint (or --mock) are required unless --dry-run')
        model = MockModel() if args.mock else Model(env, args.checkpoint, args.threads)
        result = model.compose(prep)
        args.output.write_text(json.dumps(result, indent=1, default=str))
        print(json.dumps({'bars': len(result['bars']), 'notes': sum(len(b['notes']) for b in result['bars']),
                          'output': str(args.output)}))
    except AdapterError as e:
        raise SystemExit(f'error: {e}') from None


if __name__ == '__main__':
    main()
