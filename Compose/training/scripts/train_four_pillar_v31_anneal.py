#!/usr/bin/env python3
"""v3.1 fine-tuning with a decaying learning rate and weight averaging (EMA).

Why: the 17.5-hour v3.1 run ended on a constant floor learning rate of 1e-4 (the cosine of the first 11 h was
finished long before) and the saved weights are the raw last step, whose per-batch loss swings 4.5-5.8. A training
tail that decays the learning rate to ~0 and an exponential moving average of the weights are the two standard,
validation-free ways to get the noise out of the final weights.

This script starts a NEW run from a v3.1 weights.pt (like `--init-checkpoint` of train_four_pillar_v31.py, optimizer
reset), reusing that script's data pipeline unchanged (same sources, mix, plans, random transposition, losses). The
original trainer and its strict-resume manifest are not touched. Output (in --output-dir under training/runs):

  weights.pt      EMA weights, schema four-pillar-v31-weights-1 (loadable by every v3.1 tool; adds "ema": true)
  weights-raw.pt  raw weights of the last step, same schema
  state.pt        resumable state (model, EMA, optimizer, step, saved training time)  -> rerun with --resume
  metrics.jsonl   one row per step (loss, lr, objectives) like the original trainer

Learning rate: linear warmup, then cosine from --lr to --lr * --min-lr-ratio over --hours of saved training time.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

import torch

import train_four_pillar_v31 as T
from four_pillar_midi_data import ROOT, sha256, verify_manifest
from four_pillar_score_index import open_index
from four_pillar_v2_integrity import SourceIntegrity
from four_pillar_v2_runtime import StopAtBoundary, exclusive_run, save_checkpoint
from four_pillar_v31_data import collate
from four_pillar_v31_model import CONFIG, FourPillarV31
from four_pillar_v31_time import TimeVocabulary
from train_four_pillar_v1_all_data import SourceCycler

STATE_SCHEMA = 'four-pillar-v31-anneal-state-1'
_ORIGINAL_INIT_WORKER = T.init_worker


def init_worker_an(*args):
    """Data-worker initializer for --chord-labels augmentednet: swap in the AugmentedNet chord sidecar, then the usual."""
    import four_pillar_v31_chords_an as AN
    AN.install()
    return _ORIGINAL_INIT_WORKER(*args)


def lr_at(args, step: int, elapsed: float) -> float:
    warm = min(1., (step + 1) / max(1, args.warmup_steps))
    progress = min(1., elapsed / (args.hours * 3600.))
    cosine = args.min_lr_ratio + (1 - args.min_lr_ratio) * .5 * (1 + math.cos(math.pi * progress))
    return args.lr * warm * cosine


@torch.no_grad()
def ema_update(ema: dict, model, decay: float):
    for k, v in model.state_dict().items():
        if v.dtype.is_floating_point:
            ema[k].mul_(decay).add_(v.detach(), alpha=1. - decay)
        else:
            ema[k].copy_(v)


def weights_file(model_state: dict, step: int, args, manifest_hash: str, ema: bool) -> dict:
    return {'schema': T.WEIGHTS_SCHEMA, 'architecture': CONFIG,
            'model': {k: v.detach().cpu().clone() for k, v in model_state.items()}, 'step': step,
            'manifestSha256': manifest_hash, 'vocabSha256': sha256(args.vocab), 'qualityValidated': False, 'ema': ema}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--output-dir', type=Path, required=True)
    p.add_argument('--init-checkpoint', type=Path, help='v3.1 weights.pt (new run only)')
    p.add_argument('--resume', action='store_true')
    p.add_argument('--hours', type=float, default=9., help='training time; the cosine ends exactly here')
    p.add_argument('--steps', type=int, default=0, help='optional limit on additional steps (smoke tests)')
    p.add_argument('--lr', type=float, default=1.5e-4)
    p.add_argument('--min-lr-ratio', type=float, default=.03)
    p.add_argument('--warmup-steps', type=int, default=200)
    p.add_argument('--ema-decay', type=float, default=.9995, help='half-life ~ 1400 steps')
    p.add_argument('--ema-start', type=int, default=300, help='steps before averaging starts (after the warmup)')
    p.add_argument('--batch', type=int, default=8)
    p.add_argument('--context', type=int, default=512)
    p.add_argument('--shift', type=int, default=6)
    p.add_argument('--threads', type=int, default=4)
    p.add_argument('--workers', type=int, default=max(1, min(6, (__import__('os').cpu_count() or 4) - 2)))
    p.add_argument('--sources', default=','.join(T.MIX))
    p.add_argument('--seed', type=int, default=20261004)
    p.add_argument('--checkpoint-seconds', type=float, default=600)
    p.add_argument('--vocab', type=Path, default=T.DEFAULT_VOCAB)
    p.add_argument('--chord-labels', choices=('tracker', 'augmentednet'), default='tracker',
                   help='augmentednet: use data/chords-augmentednet-v1.json.gz (four_pillar_v31_chords_an.py) for the '
                        'scores it lists instead of the rule-based ChordTracker')
    args = p.parse_args()
    sources = [s for s in args.sources.split(',') if s]
    if args.resume == bool(args.init_checkpoint):
        p.error('give exactly one of --init-checkpoint (new run) or --resume')
    if not args.output_dir.resolve().is_relative_to((ROOT / 'runs').resolve()):
        p.error('output must be under training/runs')
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed + 1)
    vocab = TimeVocabulary.load(args.vocab)
    frozen = None
    if any(s not in T.SCORE_SOURCES for s in sources):
        frozen = json.loads(T.MEMBERSHIP.read_text())
        verify_manifest(frozen)
        SourceIntegrity(frozen)
    db = open_index(T.INDEX)
    pool = T.build_pool(sources, db, frozen)
    db.close()
    mix = {s: T.MIX[s] for s in sources}
    cycler = SourceCycler(pool, rng)
    model = FourPillarV31()
    path = args.output_dir
    step, before, counts, pending = 0, 0., {s: 0 for s in pool}, []
    config = {'lr': args.lr, 'minLrRatio': args.min_lr_ratio, 'warmupSteps': args.warmup_steps, 'hours': args.hours,
              'emaDecay': args.ema_decay, 'emaStart': args.ema_start, 'batch': args.batch, 'context': args.context,
              'shift': args.shift, 'seed': args.seed, 'sources': sources, 'sourceMix': mix,
              'schedule': 'linear warmup; cosine over `hours` of saved training time; EMA of the weights',
              'chordLabels': args.chord_labels}
    if args.resume:
        manifest = json.loads((path / 'manifest.json').read_text())
        if manifest['config'] != config:
            raise ValueError('configuration changed; refusing resume')
        state = torch.load(path / 'state.pt', map_location='cpu', weights_only=False)
        model.load_state_dict(state['model'])
        ema = {k: v.clone() for k, v in state['ema'].items()}
        step, before, counts, pending = state['step'], state['elapsedSeconds'], state['counts'], state['pendingPlans']
        rng.setstate(state['pythonRng'])
        torch.set_rng_state(state['torchRng'])
        cycler.load_state_dict(state['sourceCycler'])
    else:
        parent = torch.load(args.init_checkpoint, map_location='cpu', weights_only=False)
        if parent.get('schema') != T.WEIGHTS_SCHEMA or parent['architecture'] != CONFIG \
                or parent['vocabSha256'] != sha256(args.vocab):
            raise ValueError('not a compatible v3.1 weights.pt')
        model.load_state_dict(parent['model'], strict=True)
        ema = {k: v.detach().clone() for k, v in model.state_dict().items()}
        path.mkdir(parents=True, exist_ok=False)
        manifest = {'schema': 'four-pillar-v31-anneal-1', 'config': config, 'architecture': CONFIG,
                    'parent': {'path': str(args.init_checkpoint.resolve()), 'step': int(parent['step']),
                               'sha256': sha256(args.init_checkpoint)},
                    'sourceCounts': {s: len(r) for s, r in pool.items()}, 'torchVersion': str(torch.__version__),
                    'noValidation': True, 'qualityValidated': False}
        (path / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    parent_step = manifest['parent']['step']
    params = [q for q in model.parameters() if q.requires_grad]
    optimizer = torch.optim.AdamW([{'params': [q for q in params if q.dim() >= 2], 'weight_decay': .01},
                                   {'params': [q for q in params if q.dim() < 2], 'weight_decay': 0.}],
                                  lr=args.lr, betas=(.9, .98))
    if args.resume:
        optimizer.load_state_dict(state['optimizer'])
    init_args = (sources, args.vocab, args.context, args.shift)
    if args.chord_labels == 'augmentednet':
        import four_pillar_v31_chords_an as AN
        if not AN.load():
            p.error(f'{AN.SIDECAR} is missing or empty')
        AN.install()                      # the main process (and --workers 0)
        T.init_worker = init_worker_an    # the data workers
    with exclusive_run(path), StopAtBoundary() as stop:
        stream = T.Examples(pool, mix, rng, cycler, args.workers, args.batch * 2 + 2 * args.workers, init_args, pending)
        started, initial, rejected = time.monotonic(), step, {}

        def elapsed():
            return before + time.monotonic() - started

        def save():
            mh = sha256(path / 'manifest.json')
            save_checkpoint({'schema': STATE_SCHEMA, 'model': model.state_dict(), 'ema': ema,
                             'optimizer': optimizer.state_dict(), 'step': step, 'elapsedSeconds': elapsed(),
                             'pythonRng': rng.getstate(), 'torchRng': torch.get_rng_state(),
                             'sourceCycler': cycler.state_dict(), 'pendingPlans': stream.pending(), 'counts': counts},
                            path / 'state.pt')
            # weights.pt = EMA when averaging has started, else the raw weights; step counts parent steps too.
            use_ema = step - 0 >= args.ema_start
            save_checkpoint(weights_file(ema if use_ema else model.state_dict(), parent_step + step, args, mh, use_ema),
                            path / 'weights.pt')
            save_checkpoint(weights_file(model.state_dict(), parent_step + step, args, mh, False), path / 'weights-raw.pt')

        try:
            last = time.monotonic()
            while elapsed() < args.hours * 3600. and not stop.requested and (not args.steps or step - initial < args.steps):
                tick = time.perf_counter()
                batch = collate([stream.next(rejected) for _ in range(args.batch)], len(vocab))
                lr = lr_at(args, step, elapsed())
                for g in optimizer.param_groups:
                    g['lr'] = lr
                optimizer.zero_grad(set_to_none=True)
                loss, report = model.loss(batch)
                loss.backward()
                gradient = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.))
                if not math.isfinite(gradient):
                    raise FloatingPointError('nonfinite gradient; the previous checkpoint is kept')
                optimizer.step()
                step += 1
                if step <= args.ema_start:
                    ema = {k: v.detach().clone() for k, v in model.state_dict().items()}   # track until averaging starts
                else:
                    ema_update(ema, model, args.ema_decay)
                row = {'step': parent_step + step, 'loss': float(loss.detach()), 'lr': lr, 'gradient': gradient,
                       'elapsedSeconds': round(elapsed(), 2), 'stepSeconds': round(time.perf_counter() - tick, 3),
                       'events': int(report['kind']['known']),
                       'objectives': {k: round(v['loss'], 4) for k, v in report.items() if v['known']}}
                with (path / 'metrics.jsonl').open('a') as log:
                    log.write(json.dumps(row) + '\n')
                if step % 25 == 0:
                    print(json.dumps({k: row[k] for k in ('step', 'loss', 'lr', 'elapsedSeconds', 'stepSeconds')}),
                          flush=True)
                if time.monotonic() - last >= args.checkpoint_seconds:
                    save()
                    last = time.monotonic()
            save()
        finally:
            stream.close()
        print(json.dumps({'phase': 'saved', 'step': parent_step + step, 'ema': step >= args.ema_start,
                          'elapsedSeconds': round(elapsed(), 1)}), flush=True)


if __name__ == '__main__':
    main()
