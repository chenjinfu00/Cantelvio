#!/usr/bin/env python3
"""Four-pillar v3.1 training (new versioned runs; never touches v2 or v3 runs).

Differences from v3: key-relative pitch (every bar has a tracked local key),
explicit chord-change events (AugmentedNet chords for aligned Lieder, tracked
chords elsewhere), musical-time rotary attention, batches of whole windows, a
loss at every event of the window (each with its own bar plan), a time-based
cosine schedule, random transposition, learned bar controls with random dropout
and the frozen musical time vocabulary. Examples are prepared by worker
processes from deterministic plans drawn by the main process, so results and
exact resume do not depend on worker timing. Strict resume refuses any change
of code, data, vocabulary or configuration.
"""
from __future__ import annotations

import argparse
import json
import math
import multiprocessing
import os
import random
import signal
import statistics
import sys
import time
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import torch

from four_pillar_midi_data import ROOT, sha256, source_path, verify_manifest
from four_pillar_score_index import get_score, index_rows, open_index
from four_pillar_v2_examples import JOINT, LABELS, SourceLabels
from four_pillar_v2_integrity import FINGERPRINTS, SourceIntegrity
from four_pillar_v2_runtime import StopAtBoundary, exclusive_run, save_checkpoint
from four_pillar_v31_data import CONTROL_DROP, build_example, collate
from four_pillar_v31_model import CONFIG, FourPillarV31
from four_pillar_v31_time import DEFAULT_VOCAB, TimeVocabulary
from four_pillar_v31_tonal import rule as tonal_rule
from train_four_pillar_v1_all_data import SourceCycler

MIX = {'symphony-classical': .20, 'symphony-contemporary': .35, 'curated-midi': .10, 'Lieder': .20,
       'classical-scores': .15}
SCORE_SOURCES = ('Lieder', 'classical-scores')
MEMBERSHIP = ROOT / 'data/four-pillar-midi-all-train-v1.json'
INDEX = ROOT / 'data/four-pillar-score-all-train-v1.sqlite'
CODE = ('four_pillar_v31_model.py', 'four_pillar_v31_data.py', 'four_pillar_v31_time.py', 'four_pillar_v31_sample.py',
        'train_four_pillar_v31.py', 'build_four_pillar_v31_time_vocab.py', 'orchestra_midi_groups.py')
STATE_SCHEMA, WEIGHTS_SCHEMA = 'four-pillar-v31-state-1', 'four-pillar-v31-weights-1'


def code_hashes() -> dict:
    """SHA-256 of the v3.1 files and of every repository module this process has imported."""
    scripts = (ROOT / 'scripts').resolve()
    names = set(CODE)
    for module in list(sys.modules.values()):
        path = getattr(module, '__file__', None)
        if path and Path(path).suffix == '.py' and Path(path).resolve().parent == scripts:
            names.add(Path(path).name)
    return {name: sha256(scripts / name) for name in sorted(names)}


# ==================================================================== example preparation (main or worker)
def load_midi(row):
    """One parse of an approved MIDI: the same ScoreEvents, velocities, meter flags and bar tempos as the v2
    loader (four_pillar_midi_data._load_midi_score; tests compare them field by field) plus the original drum
    keys. Faster: integer-tick sorting and bisection, and one Fraction per distinct tick."""
    from bisect import bisect_right
    from fractions import Fraction
    from symusic import Score
    from orchestra_midi_groups import group_of
    from score_events_v2 import Measure, NoteEvent, Part, ScoreEvents
    path = source_path(row)
    midi = Score(str(path))
    tpq = int(midi.ticks_per_quarter)
    if tpq <= 0:
        raise ValueError('MIDI has invalid ticks per quarter')
    raw, part_info, drums = [], {}, {}
    for ti, track in enumerate(midi.tracks):
        program, is_drum = int(track.program), bool(track.is_drum)
        for note in track.notes:
            pitch = int(note.pitch)
            group = group_of(program, pitch, is_drum)
            if group is None or note.duration <= 0:
                continue
            part_id = f'track-{ti}-{group}'
            part_info.setdefault(part_id, (ti, program, group))
            if is_drum:
                drums[len(raw)] = pitch
            raw.append((int(note.time), int(note.duration), pitch, int(note.velocity), part_id, is_drum, group))
    if not raw:
        raise ValueError('MIDI has no mapped notes')
    last_tick = max(t + d for t, d, *_ in raw)
    signatures = {int(x.time): (int(x.numerator), int(x.denominator)) for x in midi.time_signatures if x.time >= 0}
    if 0 not in signatures:
        signatures[0] = (4, 4)
    ordered = sorted(signatures.items())
    starts, measures = [], []
    for si, (tick, meter) in enumerate(ordered):
        if tick >= last_tick:
            break
        end = ordered[si + 1][0] if si + 1 < len(ordered) else last_tick
        length = Fraction(meter[0] * 4 * tpq, meter[1])
        if length <= 0:
            raise ValueError('invalid MIDI time signature')
        cursor = Fraction(tick)
        while cursor < end:
            actual = min(length, end - cursor) if si + 1 < len(ordered) else length
            starts.append(cursor)
            measures.append(Measure(len(measures), cursor / tpq, actual / tpq, meter, actual != length, None))
            cursor += length
    if not measures:
        raise ValueError('MIDI has no measures')
    parts = tuple(Part(key, i, key, '', group, program, 'midi-gm') for i, (key, (_, program, group)) in enumerate(
        sorted(part_info.items(), key=lambda item: (item[1][0], item[0]))))
    float_starts = [s.numerator / s.denominator for s in starts]   # exact order for integer ticks
    ends = [float(s + m.duration * tpq) for s, m in zip(starts, measures)]
    times: dict[int, Fraction] = {}
    events, velocities = [], {}
    for source_index, (tick, duration, pitch, velocity, part, drum, group) in enumerate(raw):
        bar = bisect_right(float_starts, tick) - 1
        if bar < 0 or tick >= ends[bar]:
            raise ValueError('MIDI note lies outside derived measure')
        onset = times.get(tick)
        if onset is None:
            onset = times[tick] = Fraction(tick, tpq)
        length = times.get(-duration - 1)
        if length is None:
            length = times[-duration - 1] = Fraction(duration, tpq)
        events.append((tick, part, -1 if drum else pitch, source_index,
                       NoteEvent(source_index, onset, length, bar, part, '1', '1', None if drum else pitch, None, group,
                                 None, None, None, None, 0, False, drum)))
        velocities[source_index] = velocity
    order = {part.id: part.index for part in parts}
    events.sort(key=lambda item: (item[0], order[item[1]], item[2], item[3]))
    first_explicit = min((int(x.time) for x in midi.time_signatures), default=None)
    meter_known = tuple(first_explicit is not None and m.onset * tpq >= first_explicit for m in measures)
    tempos = sorted((Fraction(int(x.time), tpq), float(x.qpm)) for x in midi.tempos if x.qpm > 0)
    tempo_times = [time for time, _ in tempos]
    bar_tempos = tuple((tempos[j][1] if (j := bisect_right(tempo_times, m.onset) - 1) >= 0 else None) for m in measures)
    score = ScoreEvents('midi:' + row['source'] + ':' + row['name'], row['source'], None, None, None, row['familyId'],
                        row.get('sha256'), parts, tuple(measures), tuple(item[4] for item in events))
    return score, velocities, drums, bar_tempos, meter_known


def choose_shift(score, rng: random.Random, spread: int) -> int:
    pitches = [n.pitch for n in score.events if n.pitch is not None]
    if not pitches or spread <= 0:
        return 0
    low, high = min(pitches), max(pitches)
    options = [s for s in range(-spread + 1, spread + 1) if 0 <= low + s and high + s <= 127]
    return rng.choice(options) if options else 0


def build_pool(sources, db, frozen) -> dict:
    rows = frozen['rows'] if frozen is not None else []
    pool = {'symphony-classical': [r for r in rows if r['source'] == 'SymphonyNet' and '/classical/' in r['name']],
            'symphony-contemporary': [r for r in rows if r['source'] == 'SymphonyNet' and '/contemporary/' in r['name']],
            'curated-midi': [r for r in rows if r['source'] == 'MIDI-Library']}
    pool.update({s: index_rows(db, source=s, split='train') for s in SCORE_SOURCES})
    return {s: pool[s] for s in sources}


_WORKER: dict = {}


def init_worker(sources, vocab_path, context, shift, worker=False):
    if worker:
        torch.set_num_threads(1)
        signal.signal(signal.SIGINT, signal.SIG_IGN)   # Ctrl-C stops the trainer at a step boundary, not the workers
    db = open_index(INDEX)
    frozen = json.loads(MEMBERSHIP.read_text()) if any(s not in SCORE_SOURCES for s in sources) else None
    _WORKER.update(vocab=TimeVocabulary.load(vocab_path), db=db, labels=SourceLabels(), context=context, shift=shift,
                   pool=build_pool(sources, db, frozen),
                   integrity=SourceIntegrity(frozen, verify_all=False) if frozen is not None else None)


def example_from_plan(plan: dict) -> dict:
    """Pure function of the plan (source, member index, seed) and the frozen inputs."""
    w = _WORKER
    rng = random.Random(plan['seed'])
    source, row = plan['source'], w['pool'][plan['source']][plan['index']]
    try:
        if source in SCORE_SOURCES:
            score = get_score(w['db'], row[0])
            velocities, drums, meter_known = {}, {}, None
            tempos = w['labels'].expression(score)[1]
        else:
            w['integrity'].check(row)     # a changed file raises RuntimeError and stops training
            score, velocities, drums, tempos, meter_known = load_midi(row)
        if not score.measures:
            raise ValueError('score without bars')
        shift = choose_shift(score, rng, w['shift'])
        end_bar = rng.randrange(len(score.measures))
        # Keys (tracked) and chords (AugmentedNet for aligned Lieder, tracked otherwise) come from
        # four_pillar_v31_tonal inside build_example; both follow the transposition.
        example = build_example(score, end_bar, w['vocab'], source=source, rng=rng, velocities=velocities, drums=drums,
                                tempos=tempos, meter_known=meter_known, labels=w['labels'], shift=shift,
                                context=w['context'])
        example['source'] = source
        return example
    except (ValueError, IndexError, OverflowError, KeyError) as error:
        return {'error': str(error)[:120], 'source': source}


# ==================================================================== training
def to_device(batch: dict, device: torch.device) -> dict:
    """Move a collated batch; MPS has no float64, so the rotary phase inputs (relative to the window start, a few
    hundred quarters at most) move as float32 there. CPU batches are returned unchanged."""
    if device.type == 'cpu':
        return batch
    return {k: (v.float() if v.dtype == torch.float64 else v).to(device) for k, v in batch.items()}


def synchronize(device: torch.device):
    if device.type == 'mps':
        torch.mps.synchronize()
    elif device.type == 'cuda':
        torch.cuda.synchronize()


def forward_backward(model, batch: dict, device: torch.device, repeats: int):
    """Loss, objectives and the seconds of each of `repeats` forward+backward passes (same weights)."""
    seconds = []
    for _ in range(max(1, repeats)):
        model.zero_grad(set_to_none=True)
        synchronize(device)
        started = time.perf_counter()
        loss, objectives = model.loss(batch)
        loss.backward()
        synchronize(device)
        seconds.append(time.perf_counter() - started)
    return loss, objectives, seconds


def gradient_norm(model) -> float:
    return math.sqrt(sum(float(p.grad.detach().double().pow(2).sum().cpu()) for p in model.parameters()
                         if p.grad is not None))


def learning_rate(args, step: int, elapsed: float, schedule_seconds: float) -> float:
    """Linear warmup by step, cosine by saved training time over the run's first budget, then the floor."""
    warm = min(1., (step + 1) / max(1, args.warmup_steps))
    progress = min(1., elapsed / schedule_seconds)
    cosine = args.min_lr_ratio + (1 - args.min_lr_ratio) * .5 * (1 + math.cos(math.pi * progress))
    return args.lr * warm * cosine


class Examples:
    """Ordered pipeline of example plans; workers only change speed, never content or order."""

    def __init__(self, pool, mix, rng, cycler, workers, depth, init_args, pending=()):
        self.pool, self.mix, self.rng, self.cycler, self.depth = pool, mix, rng, cycler, depth
        self.executor = None
        if workers:
            self.executor = ProcessPoolExecutor(workers, mp_context=multiprocessing.get_context('spawn'),
                                                initializer=init_worker, initargs=tuple(init_args) + (True,))
        else:
            init_worker(*init_args)
        self.queue = deque()
        for plan in pending:
            self._submit(plan)

    def _draw(self) -> dict:
        source = self.rng.choices(tuple(self.pool), weights=[self.mix[s] for s in self.pool])[0]
        return {'source': source, 'index': self.cycler.next_index(source), 'seed': self.rng.getrandbits(32)}

    def _submit(self, plan):
        self.queue.append((plan, self.executor.submit(example_from_plan, plan) if self.executor else None))

    def fill(self):
        while len(self.queue) < self.depth:
            self._submit(self._draw())

    def next(self, rejected: dict) -> dict:
        failures = 0
        while True:
            self.fill()
            plan, future = self.queue.popleft()
            result = future.result() if future is not None else example_from_plan(plan)
            if 'error' not in result:
                return result
            rejected[result['error']] = rejected.get(result['error'], 0) + 1
            failures += 1
            if failures > 200:
                raise ValueError('200 consecutive rejected examples; ' + json.dumps(rejected)[:2000])

    def pending(self) -> list:
        return [plan for plan, _ in self.queue]

    def close(self):
        if self.executor is not None:
            self.executor.shutdown(wait=False, cancel_futures=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--init-checkpoint', type=Path, help='v3.1 weights.pt to start a new run from (default: '
                                                                  'random initialization)')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--initialize-only', action='store_true', help='write the step-zero run without training')
    parser.add_argument('--preflight', action='store_true',
                        help='one batch with every source, forward+backward only (no weight update, no run directory); '
                             'with --device mps/cuda also times the CPU and reports CPU/device parity')
    parser.add_argument('--preflight-repeats', type=int, default=4,
                        help='timed forward+backward passes in --preflight (the first is excluded from the median)')
    parser.add_argument('--max-seconds', type=float, default=39600)
    parser.add_argument('--steps', type=int, default=0, help='optional limit on additional optimizer steps')
    parser.add_argument('--threads', type=int, default=4, help='torch threads of the training process')
    parser.add_argument('--workers', type=int, default=max(1, min(6, (os.cpu_count() or 4) - 2)),
                        help='example-preparation processes (0 = in-process; default: CPU cores - 2, at most 6)')
    parser.add_argument('--device', choices=('cpu', 'mps', 'cuda'), default='cpu',
                        help='mps/cuda only after --preflight shows CPU/device loss parity')
    parser.add_argument('--sources', default=','.join(MIX), help='comma-separated subset of ' + ','.join(MIX))
    parser.add_argument('--seed', type=int, default=20261002)
    parser.add_argument('--lr', type=float, default=1e-3)
    parser.add_argument('--min-lr-ratio', type=float, default=.1)
    parser.add_argument('--warmup-steps', type=int, default=300)
    parser.add_argument('--batch', type=int, default=8)
    parser.add_argument('--context', type=int, default=512)
    parser.add_argument('--shift', type=int, default=6, help='random transposition within (-shift, shift]')
    parser.add_argument('--checkpoint-seconds', type=float, default=300)
    parser.add_argument('--vocab', type=Path, default=DEFAULT_VOCAB)
    args = parser.parse_args()
    sources = [s for s in args.sources.split(',') if s]
    if args.resume and (args.preflight or args.init_checkpoint or args.initialize_only):
        parser.error('resume is separate from initialization and preflight')
    if (not sources or len(set(sources)) != len(sources) or any(s not in MIX for s in sources) or args.threads < 1
            or args.workers < 0 or args.steps < 0 or args.batch < 1 or not 16 <= args.context <= CONFIG['window']
            or args.preflight_repeats < 1
            or not 0 <= args.min_lr_ratio <= 1 or args.warmup_steps < 0 or args.shift < 0
            or any(not math.isfinite(x) or x <= 0 for x in (args.lr, args.max_seconds, args.checkpoint_seconds))):
        parser.error('invalid configuration')
    if not args.output_dir.resolve().is_relative_to((ROOT / 'runs').resolve()):
        parser.error('output must be under training/runs')
    if args.init_checkpoint and args.init_checkpoint.resolve().is_relative_to(args.output_dir.resolve()):
        parser.error('the parent checkpoint must live outside the new run')
    device = torch.device(args.device)
    if device.type == 'mps' and not torch.backends.mps.is_available():
        parser.error('MPS is not available on this machine')
    if device.type == 'cuda' and not torch.cuda.is_available():
        parser.error('CUDA is not available on this machine')
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed + 1)
    vocab = TimeVocabulary.load(args.vocab)
    uses_midi = any(s not in SCORE_SOURCES for s in sources)
    frozen = None
    if uses_midi:
        frozen = json.loads(MEMBERSHIP.read_text())
        verify_manifest(frozen)
        SourceIntegrity(frozen)          # verifies every approved MIDI file once at startup
    db = open_index(INDEX)
    pool = build_pool(sources, db, frozen)
    db.close()
    mix = {s: MIX[s] for s in sources}
    cycler = SourceCycler(pool, rng)
    model = FourPillarV31()
    transfer = None
    if args.init_checkpoint:
        state = torch.load(args.init_checkpoint, map_location='cpu', weights_only=False)
        if state.get('schema') == WEIGHTS_SCHEMA:
            if state['architecture'] != CONFIG or state['vocabSha256'] != sha256(args.vocab):
                raise ValueError('v3.1 parent architecture or time vocabulary differs')
            model.load_state_dict(state['model'], strict=True)
            transfer = {'parentStep': int(state['step']), 'copiedParameters': sum(p.numel() for p in model.parameters()),
                        'totalParameters': sum(p.numel() for p in model.parameters()), 'optimizerReset': True,
                        'strictResumeCompatible': False, 'initializationKind': 'v3.1 weights only; new run'}
        else:
            raise ValueError('only v3.1 weights.pt can start a v3.1 run (v2/v3 checkpoints are not compatible)')
        if not all(torch.isfinite(t).all() for t in model.state_dict().values()):
            raise FloatingPointError('nonfinite parent weights')
        transfer.update(parentCheckpointSha256=sha256(args.init_checkpoint), parentPath=str(args.init_checkpoint.resolve()))
    model.to(device)
    init_args = (sources, args.vocab, args.context, args.shift)
    if args.preflight:
        init_worker(*init_args)
        report_rows, examples, started = {}, [], time.perf_counter()
        # Every source at least once, then round-robin up to one training batch (representative timing).
        while len(examples) < max(len(sources), args.batch):
            source = sources[len(examples) % len(sources)]
            for _ in range(30):
                example = example_from_plan({'source': source, 'index': cycler.next_index(source),
                                             'seed': rng.getrandbits(32)})
                if 'error' not in example:
                    examples.append(example)
                    break
                report_rows[example['error']] = report_rows.get(example['error'], 0) + 1
            else:
                raise ValueError('30 rejected examples from ' + source)
        data_seconds = time.perf_counter() - started
        batch = collate(examples, len(vocab))
        loss, objectives, seconds = forward_backward(model, to_device(batch, device), device, args.preflight_repeats)
        if not all(torch.isfinite(p.grad).all() for p in model.parameters() if p.grad is not None):
            raise FloatingPointError('nonfinite preflight gradient')
        timed = seconds[1:] or seconds
        parity = None
        if device.type != 'cpu':
            reference = FourPillarV31()
            reference.load_state_dict({k: v.detach().cpu() for k, v in model.state_dict().items()})
            cpu_loss, _, cpu_seconds = forward_backward(reference, batch, torch.device('cpu'), args.preflight_repeats)
            cpu_loss, device_loss = float(cpu_loss.detach()), float(loss.detach().cpu())
            cpu_norm, device_norm = gradient_norm(reference), gradient_norm(model)
            parity = {'cpuLoss': cpu_loss, 'deviceLoss': device_loss,
                      'relativeDifference': abs(cpu_loss - device_loss) / max(1e-6, abs(cpu_loss)),
                      'cpuGradientNorm': cpu_norm, 'deviceGradientNorm': device_norm,
                      'gradientRelativeDifference': abs(cpu_norm - device_norm) / max(1e-12, cpu_norm),
                      'cpuModelSeconds': round(statistics.median(cpu_seconds[1:] or cpu_seconds), 4),
                      'cpuThreads': args.threads}
        print(json.dumps({'phase': 'preflight', 'parameters': sum(p.numel() for p in model.parameters()),
                          'transfer': transfer and {k: v for k, v in transfer.items() if k != 'tensorMapping'},
                          'device': args.device, 'batch': len(examples),
                          'events': int(objectives['kind']['known']), 'sources': sources, 'loss': float(loss.detach()),
                          'objectives': objectives, 'snapping': [e['stats'] for e in examples], 'rejected': report_rows,
                          'dataSeconds': round(data_seconds, 3), 'modelSeconds': round(statistics.median(timed), 4),
                          'firstPassSeconds': round(seconds[0], 4), 'repeats': len(seconds),
                          'deviceParity': parity, 'noWeightUpdate': True}), flush=True)
        return
    code = code_hashes()
    training = {'lr': args.lr, 'minLrRatio': args.min_lr_ratio, 'warmupSteps': args.warmup_steps, 'batch': args.batch,
                'context': args.context, 'shift': args.shift, 'seed': args.seed, 'scheduleSeconds': args.max_seconds,
                'sources': sources, 'sourceMix': mix,
                'schedule': 'linear warmup by step; cosine over scheduleSeconds of saved training time, then the floor',
                'lossPositions': 'every event of each window, each with its own bar plan',
                'controlDropout': CONTROL_DROP, 'leadBars': 16, 'leadEvents': 384,
                'examplePlans': 'source, member index, 32-bit seed',
                'pitchCoding': 'relative to the local key: index = pitch - tonic_ref(tonic) + 65; exact inverse',
                'tonalLabels': {'keys': 'KeyTracker for every source', 'chords': 'AugmentedNet for aligned Lieder, '
                                'ChordTracker otherwise', 'rule': tonal_rule()}}
    source_hashes = {'index': sha256(INDEX), 'labels': sha256(LABELS), 'joint': sha256(JOINT),
                     'timeVocabulary': sha256(args.vocab)}
    if uses_midi:
        source_hashes.update(membership=sha256(MEMBERSHIP), fingerprints=sha256(FINGERPRINTS))
    manifest = {'schema': 'four-pillar-v31-training-1', 'architecture': CONFIG, 'training': training,
                'sourceHashes': source_hashes, 'codeSha256': code, 'transfer': transfer,
                'sourceCounts': {s: len(r) for s, r in pool.items()}, 'torchVersion': str(torch.__version__),
                'allTrainingSources': sources == list(MIX), 'noValidation': True, 'qualityValidated': False,
                'runtimeDeployed': False}
    manifest = json.loads(json.dumps(manifest))   # compare exactly what manifest.json stores (tuples become lists)
    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW([{'params': [p for p in params if p.dim() >= 2], 'weight_decay': .01},
                                   {'params': [p for p in params if p.dim() < 2], 'weight_decay': 0.}],
                                  lr=args.lr, betas=(.9, .98))
    step, elapsed_before, counts, rejected, snapping, pending = 0, 0., {s: 0 for s in pool}, {}, {}, []
    path = args.output_dir
    if args.resume:
        previous = json.loads((path / 'manifest.json').read_text())
        manifest['transfer'] = previous['transfer']   # recorded once, never re-applied
        # --max-seconds only decides when to stop; the cosine keeps the run's first budget (a larger
        # budget continues at the floor learning rate instead of re-warming the schedule).
        manifest['training']['scheduleSeconds'] = previous['training']['scheduleSeconds']
        if previous != manifest:
            raise ValueError('source, code, vocabulary or configuration changed; refusing v3.1 resume')
    else:
        path.mkdir(parents=True, exist_ok=False)
    with exclusive_run(path), StopAtBoundary() as stop:
        if args.resume:
            state = torch.load(path / 'state.pt', map_location='cpu', weights_only=False)
            if state['schema'] != STATE_SCHEMA or state['manifestSha256'] != sha256(path / 'manifest.json'):
                raise ValueError('not this v3.1 run')
            model.load_state_dict(state['model'], strict=True)
            optimizer.load_state_dict(state['optimizer'])
            torch.set_rng_state(state['torchRng'])
            rng.setstate(state['pythonRng'])
            cycler.load_state_dict(state['sourceCycler'])
            step, elapsed_before = state['step'], state['elapsedSeconds']
            counts, rejected, snapping, pending = state['counts'], state['rejected'], state['snapping'], state['pendingPlans']
        else:
            (path / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        stream = None
        if not args.initialize_only:
            stream = Examples(pool, mix, rng, cycler, args.workers, args.batch * 2 + 2 * args.workers, init_args, pending)
        started = time.monotonic()
        initial = step

        def elapsed():
            return elapsed_before + time.monotonic() - started

        def save():
            save_checkpoint({'schema': STATE_SCHEMA, 'model': model.state_dict(), 'optimizer': optimizer.state_dict(),
                             'step': step, 'elapsedSeconds': elapsed(), 'manifestSha256': sha256(path / 'manifest.json'),
                             'pythonRng': rng.getstate(), 'torchRng': torch.get_rng_state(),
                             'sourceCycler': cycler.state_dict(), 'pendingPlans': stream.pending() if stream else pending,
                             'counts': counts, 'rejected': rejected, 'snapping': snapping}, path / 'state.pt')
            save_checkpoint({'schema': WEIGHTS_SCHEMA, 'architecture': CONFIG,
                             'model': {k: v.detach().cpu() for k, v in model.state_dict().items()},
                             'step': step, 'manifestSha256': sha256(path / 'manifest.json'),
                             'vocabSha256': sha256(args.vocab), 'qualityValidated': False}, path / 'weights.pt')

        try:
            if not args.resume:
                save()
            last = time.monotonic()
            while (not args.initialize_only and elapsed() < args.max_seconds and not stop.requested
                   and (not args.steps or step - initial < args.steps)):
                tick = time.perf_counter()
                examples = [stream.next(rejected) for _ in range(args.batch)]
                batch = to_device(collate(examples, len(vocab)), device)
                data_seconds = time.perf_counter() - tick
                lr = learning_rate(args, step, elapsed(), manifest['training']['scheduleSeconds'])
                for group in optimizer.param_groups:
                    group['lr'] = lr
                optimizer.zero_grad(set_to_none=True)
                loss, report = model.loss(batch)
                loss.backward()
                gradient = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.))
                if not math.isfinite(gradient):
                    raise FloatingPointError('nonfinite gradient; the previous checkpoint is kept')
                optimizer.step()
                step += 1
                for e in examples:
                    counts[e['source']] += 1
                    for k, v in e['stats'].items():
                        snapping[k] = snapping.get(k, 0) + v
                row = {'step': step, 'loss': float(loss.detach()), 'lr': lr, 'gradient': gradient,
                       'elapsedSeconds': round(elapsed(), 2), 'dataWaitSeconds': round(data_seconds, 3),
                       'stepSeconds': round(time.perf_counter() - tick, 3), 'device': args.device,
                       'sources': {s: n for s in pool if (n := sum(e['source'] == s for e in examples))},
                       'events': int(report['kind']['known']),
                       'objectives': {k: round(v['loss'], 4) for k, v in report.items() if v['known']}}
                if step % 50 == 0:
                    row['known'] = {k: v['known'] for k, v in report.items()}
                with (path / 'metrics.jsonl').open('a') as log:
                    log.write(json.dumps(row) + '\n')
                if step % 25 == 0:
                    print(json.dumps({k: row[k] for k in ('step', 'loss', 'lr', 'elapsedSeconds', 'stepSeconds',
                                                          'dataWaitSeconds', 'events')}), flush=True)
                if time.monotonic() - last >= args.checkpoint_seconds:
                    save()
                    last = time.monotonic()
            save()
        finally:
            if stream is not None:
                stream.close()
        print(json.dumps({'phase': 'saved', 'step': step, 'parameters': sum(p.numel() for p in model.parameters()),
                          'weightsBytes': (path / 'weights.pt').stat().st_size,
                          'checkpointBytes': (path / 'state.pt').stat().st_size, 'counts': counts,
                          'snapping': snapping, 'rejected': rejected, 'runtimeUnchanged': True}), flush=True)


if __name__ == '__main__':
    main()
