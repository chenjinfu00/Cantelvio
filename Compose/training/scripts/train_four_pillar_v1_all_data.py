#!/usr/bin/env python3
"""Resumable, time-bounded all-available-corpus training for four-pillar v1.

Every accepted source record is training eligible. There is deliberately no
validation, best checkpoint, or test score: the user will provide an independent
future corpus for that purpose. This first pass trains free continuation and
source-known MIDI group/tempo/velocity heads, not the complete four-task product.
The current browser weights are never written by this script.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import time
from collections import Counter
from pathlib import Path

import torch

from four_pillar_midi_data import (_load_midi_score, make_midi_example,
                                    midi_item_from_score, sha256, slice_score,
                                    verify_manifest)
from four_pillar_score_index import get_score, index_rows, open_index
from four_pillar_trial_data import summarize_bars
from four_pillar_v1_codec import encode_dynamic_score
from four_pillar_v1_model import FourPillarComposerV1
from four_pillar_v1_objective import composition_objective
from four_pillar_v1_pilot_data import PairedScore, ROOT, make_example
from four_pillar_trial_model import PLAN_BARS


def atomic_save(value: dict, path: Path):
    temporary = path.with_suffix(path.suffix + '.tmp')
    torch.save(value, temporary)
    os.replace(temporary, path)


class SourceCycler:
    """Visit each member of a source once before reshuffling that source."""

    def __init__(self, pool: dict, rng: random.Random):
        self.rng = rng
        self.orders = {name: list(range(len(rows))) for name, rows in pool.items()}
        for order in self.orders.values():
            rng.shuffle(order)
        self.positions = {name: 0 for name in pool}
        self.epochs = {name: 0 for name in pool}

    def next_index(self, source: str) -> int:
        order = self.orders[source]
        if self.positions[source] == len(order):
            self.rng.shuffle(order)
            self.positions[source] = 0
            self.epochs[source] += 1
        index = order[self.positions[source]]
        self.positions[source] += 1
        return index

    def state_dict(self) -> dict:
        return {'orders': self.orders, 'positions': self.positions, 'epochs': self.epochs}

    def load_state_dict(self, saved: dict) -> None:
        if set(saved['orders']) != set(self.orders):
            raise ValueError('source cycler pool changed')
        for source, order in saved['orders'].items():
            if len(order) != len(self.orders[source]) or set(order) != set(self.orders[source]):
                raise ValueError('source cycler membership changed: ' + source)
            if not 0 <= saved['positions'][source] <= len(order):
                raise ValueError('source cycler position is invalid')
        self.orders = saved['orders']
        self.positions = saved['positions']
        self.epochs = saved['epochs']


def sample_midi(rows: list[dict], rng: random.Random, context: int, choose=None):
    for _ in range(20):
        row = rows[choose()] if choose is not None else rng.choice(rows)
        try:
            parsed = _load_midi_score(row)
            active_bars = sorted({event.bar for event in parsed[0].events
                                  if 0 < event.bar < len(parsed[0].measures)})
            if not active_bars:
                continue
            bar = rng.choice(active_bars)
            item = midi_item_from_score(parsed, target_bar=bar)
            return row['name'], make_midi_example(item, context=context)
        except (ValueError, IndexError, OverflowError):
            continue
    raise ValueError('20 consecutive sampled MIDI passages could not be encoded')


def sample_score(db, rows: list[tuple[str, int]], rng: random.Random, context: int,
                 choose=None):
    for _ in range(20):
        score_id, bars = rows[choose()] if choose is not None else rng.choice(rows)
        if bars < 2:
            continue
        try:
            full = get_score(db, score_id)
            active_bars = sorted({event.bar for event in full.events if 0 < event.bar < bars})
            if not active_bars:
                continue
            bar = rng.choice(active_bars)
            first = max(0, bar - 32)
            excerpt = slice_score(full, first, min(bars, bar + PLAN_BARS))
            item = PairedScore(excerpt, None, encode_dynamic_score(excerpt),
                               summarize_bars(excerpt), ())
            return score_id, make_example(item, bar - first, context=context)
        except (ValueError, IndexError, OverflowError):
            continue
    raise ValueError('20 consecutive score passages could not be encoded')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--midi-membership', type=Path,
                        default=ROOT / 'data/four-pillar-midi-all-train-v1.json')
    parser.add_argument('--score-index', type=Path,
                        default=ROOT / 'data/four-pillar-score-all-train-v1.sqlite')
    parser.add_argument('--max-seconds', type=float, default=9 * 3600)
    parser.add_argument('--context', type=int, default=256)
    parser.add_argument('--threads', type=int, default=6)
    parser.add_argument('--seed', type=int, default=20260929)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--checkpoint-seconds', type=float, default=600)
    parser.add_argument('--preflight', action='store_true')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if (args.max_seconds <= 0 or not 32 <= args.context <= 2048 or args.threads < 1
            or args.lr <= 0 or args.checkpoint_seconds < 10):
        parser.error('invalid training configuration')
    if not args.preflight and not args.output_dir.resolve().is_relative_to((ROOT / 'runs').resolve()):
        parser.error('training output must be under training/runs')
    if args.preflight and args.resume:
        parser.error('preflight cannot resume')
    if not args.preflight and args.output_dir.exists() and any(args.output_dir.iterdir()) and not args.resume:
        parser.error('output directory is nonempty; use --resume or a new path')
    torch.set_num_threads(args.threads)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    started = time.monotonic()

    frozen = json.loads(args.midi_membership.read_text())
    verify_manifest(frozen)
    db = open_index(args.score_index)
    score_meta = json.loads(db.execute("SELECT value FROM metadata WHERE key='manifest'").fetchone()[0])
    if (score_meta['schema'] != 'four-pillar-score-all-train-v1'
            or score_meta['sourceHashes']['midiMembership'] != sha256(args.midi_membership)):
        raise ValueError('score index does not match the approved MIDI membership')
    midi_rows = {
        'symphony-classical': [r for r in frozen['rows'] if r['source'] == 'SymphonyNet'
                               and '/classical/' in r['name']],
        'symphony-contemporary': [r for r in frozen['rows'] if r['source'] == 'SymphonyNet'
                                  and '/contemporary/' in r['name']],
        'curated-midi': [r for r in frozen['rows'] if r['source'] == 'MIDI-Library'],
    }
    score_rows = {source: index_rows(db, source=source, split='train')
                  for source in ('Lieder', 'classical-scores')}
    pool = {**midi_rows, **score_rows}
    if any(not rows for rows in pool.values()):
        raise ValueError('one training source is empty')
    if (len(midi_rows['symphony-classical']) + len(midi_rows['symphony-contemporary']) != 45240
            or len(midi_rows['curated-midi']) != 117
            or len(score_rows['Lieder']) != 1131
            or len(score_rows['classical-scores']) != 303):
        raise ValueError('all-data membership has changed from the inspected source counts')
    config = {'context': args.context, 'history_bars': 32,
              'width': 192, 'heads': 6, 'planner_layers': 3, 'decoder_layers': 4}
    model = FourPillarComposerV1(**config)
    model.train(args.preflight)
    rng = random.Random(args.seed + 1)
    checks = {}
    with torch.enable_grad() if args.preflight else torch.no_grad():
        for source, rows in pool.items():
            identity, (inputs, targets) = (sample_midi(rows, rng, args.context)
                                           if source in midi_rows else
                                           sample_score(db, rows, rng, args.context))
            loss, coverage = composition_objective(model(**inputs), targets)
            if args.preflight:
                loss.backward()  # no optimizer exists yet; weights cannot update
                finite = all(torch.isfinite(p.grad).all().item()
                             for p in model.parameters() if p.requires_grad and p.grad is not None)
                model.zero_grad(set_to_none=True)
                if not finite:
                    raise FloatingPointError('nonfinite preflight gradient: ' + source)
            checks[source] = {'identity': identity, 'tokens': int(inputs['decoder_input'].shape[1]),
                              'loss': float(loss.detach()),
                              'known': {k: item['known'] for k, item in coverage.items()},
                              'backwardFinite': True if args.preflight else None}
    print(json.dumps({'phase': 'preflight', 'allTrainingOnly': True,
                      'pool': {k: len(v) for k, v in pool.items()},
                      'browserWeightsUnchanged': True, 'checks': checks,
                      'seconds': round(time.monotonic() - started, 1)}, ensure_ascii=False), flush=True)
    if args.preflight:
        db.close()
        return

    # Balanced sampling is deliberate: 44k contemporary MIDIs would otherwise
    # drown out the smaller notated classical, Lieder and user-curated sources.
    sources = tuple(pool)
    mix = {'symphony-classical': 0.20, 'symphony-contemporary': 0.35,
           'curated-midi': 0.10, 'Lieder': 0.20, 'classical-scores': 0.15}
    cycler = SourceCycler(pool, rng)
    run_config = {'architecture': config, 'maxSeconds': args.max_seconds,
                  'seed': args.seed, 'lr': args.lr,
                  'checkpointSeconds': args.checkpoint_seconds, 'sourceMix': mix,
                  'sourceOrder': 'shuffle-without-replacement-until-source-exhausted'}
    manifest = {'schema': 'four-pillar-v1-all-data-train-only-v1',
                'noValidation': True, 'notBrowserCompatible': True,
                'midiMembershipSha256': sha256(args.midi_membership),
                'scoreIndexSha256': sha256(args.score_index),
                'scoreSources': score_meta, 'runConfig': run_config,
                'oldModelTransfer': model.transfer,
                'limitations': ['no validation or model selection until independent future material arrives',
                                'a 9-hour sample budget does not guarantee all 45k MIDI files are visited',
                                'MIDI lacks trustworthy harmony/form/role/notation labels',
                                'first pass trains free continuation, not all four conditioning tasks',
                                'no unconstrained full-score decoder or listening validation']}
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),
                                  lr=args.lr, weight_decay=0.01)
    state_path = args.output_dir / 'state.pt'
    log_path = args.output_dir / 'metrics.jsonl'
    step, elapsed_before = 0, 0.0
    if args.resume:
        saved = json.loads((args.output_dir / 'manifest.json').read_text())
        if saved != manifest:
            parser.error('run manifest or source changed; refusing resume')
        state = torch.load(state_path, map_location='cpu', weights_only=False)
        if state['manifestSha256'] != sha256(args.output_dir / 'manifest.json'):
            parser.error('run manifest hash changed')
        model.load_state_dict(state['model'], strict=True)
        optimizer.load_state_dict(state['optimizer'])
        rng.setstate(state['pythonRng'])
        torch.set_rng_state(state['torchRng'])
        cycler.load_state_dict(state['sourceCycler'])
        step, elapsed_before = int(state['step']), float(state['elapsedSeconds'])
    else:
        args.output_dir.mkdir(parents=True, exist_ok=False)
        (args.output_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))

    def checkpoint(elapsed: float, *, last_loss: float | None = None):
        row = {'step': step, 'elapsedSeconds': round(elapsed, 1),
               'lastTrainingLoss': last_loss, 'noValidation': True}
        atomic_save({'step': step, 'model': model.state_dict(), 'optimizer': optimizer.state_dict(),
                     'pythonRng': rng.getstate(), 'torchRng': torch.get_rng_state(),
                     'sourceCycler': cycler.state_dict(),
                     'elapsedSeconds': elapsed,
                     'manifestSha256': sha256(args.output_dir / 'manifest.json')}, state_path)
        with log_path.open('a') as log:
            log.write(json.dumps(row, ensure_ascii=False) + '\n')
        print(json.dumps({'phase': 'checkpoint', **row}, ensure_ascii=False), flush=True)

    if not args.resume:
        checkpoint(time.monotonic() - started)
    if elapsed_before >= args.max_seconds:
        print(json.dumps({'done': True, 'step': step, 'elapsedSeconds': elapsed_before}), flush=True)
        db.close()
        return
    model.train()
    source_steps = Counter()
    last_save = time.monotonic()
    last_loss = None
    try:
        while elapsed_before + time.monotonic() - started < args.max_seconds:
            source = rng.choices(sources, weights=[mix[s] for s in sources])[0]
            choose = lambda: cycler.next_index(source)
            identity, (inputs, targets) = (sample_midi(pool[source], rng, args.context, choose)
                                           if source in midi_rows else
                                           sample_score(db, pool[source], rng, args.context, choose))
            output = model(**inputs)
            loss, _ = composition_objective(output, targets)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            gradient = torch.nn.utils.clip_grad_norm_(
                (p for p in model.parameters() if p.requires_grad), 1.0)
            if not torch.isfinite(gradient):
                raise FloatingPointError('nonfinite training gradient')
            optimizer.step()
            step += 1
            last_loss = float(loss.detach())
            source_steps[source] += 1
            if step % 25 == 0:
                print(json.dumps({'phase': 'train', 'step': step,
                                  'elapsedSeconds': round(elapsed_before + time.monotonic() - started, 1),
                                  'source': source, 'example': identity,
                                  'loss': last_loss, 'sourceSteps': dict(source_steps),
                                  'sourceEpochs': cycler.epochs},
                                 ensure_ascii=False), flush=True)
            if time.monotonic() - last_save >= args.checkpoint_seconds:
                checkpoint(elapsed_before + time.monotonic() - started, last_loss=last_loss)
                last_save = time.monotonic()
    finally:
        checkpoint(elapsed_before + time.monotonic() - started, last_loss=last_loss)
        db.close()
    print(json.dumps({'done': True, 'step': step,
                      'elapsedSeconds': round(elapsed_before + time.monotonic() - started, 1),
                      'browserWeightsUnchanged': True}), flush=True)


if __name__ == '__main__':
    main()
