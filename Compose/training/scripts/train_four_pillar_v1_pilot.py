#!/usr/bin/env python3
"""Time-bounded private pilot of the full four-pillar network, not a release run.

Uses source-verified OpenScore Lieder pairs for the frozen old R/H/B/M prior,
plus a small provisional classical score selection without a fabricated prior.
Only free-continuation targets are sampled; the four conditioned tasks, final
deduplication, final validation and free score rollout remain separate gates.
Never export these weights to the current browser.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from pathlib import Path

import torch

from four_pillar_split import digest
from four_pillar_v1_model import FourPillarComposerV1
from four_pillar_v1_objective import composition_objective
from four_pillar_v1_pilot_data import ARCHIVE, JOINT, ROOT, load_mixed_pilot, make_example


def atomic_save(value: dict, path: Path):
    temporary = path.with_suffix(path.suffix + '.tmp')
    torch.save(value, temporary)
    os.replace(temporary, path)


def example_from(scores: list, rng: random.Random, context: int):
    for _ in range(64):
        item = rng.choice(scores)  # equal chance per score, not per adjacent window
        upper = min(len(item.score.measures), 65)
        if upper < 2:
            continue
        bar = rng.randrange(1, upper)
        try:
            return item, bar, make_example(item, bar, context=context)
        except ValueError:
            continue
    raise ValueError('could not sample a complete, aligned pilot bar')


def evaluate(model: FourPillarComposerV1, scores: list, context: int) -> dict:
    model.eval()
    losses, by_source = [], {'paired_old': [], 'classical_no_prior': []}
    with torch.no_grad():
        for item in scores:
            for bar in range(1, min(len(item.score.measures), 33)):
                try:
                    inputs, targets = make_example(item, bar, context=context)
                except ValueError:
                    continue
                result, _ = composition_objective(model(**inputs), targets)
                value = float(result)
                losses.append(value)
                by_source['paired_old' if item.piece is not None else 'classical_no_prior'].append(value)
                break
    model.train()
    if len(losses) != len(scores):
        raise ValueError('some pilot validation scores have no usable first-32-bar sample')
    return {'objective': sum(losses) / len(losses), 'examples': len(losses),
            'pairedOld': (sum(by_source['paired_old']) / len(by_source['paired_old'])
                          if by_source['paired_old'] else None),
            'classicalNoPrior': (sum(by_source['classical_no_prior'])
                                 / len(by_source['classical_no_prior'])
                                 if by_source['classical_no_prior'] else None)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--max-seconds', type=float, default=300)
    parser.add_argument('--context', type=int, default=256)
    parser.add_argument('--threads', type=int, default=6)
    parser.add_argument('--train-lieder', type=int, default=8)
    parser.add_argument('--validation-lieder', type=int, default=2)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--seed', type=int, default=20260929)
    parser.add_argument('--checkpoint-seconds', type=float, default=60)
    parser.add_argument('--preflight', action='store_true', help='forward-only checks, no updates or output writes')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if (args.max_seconds <= 0 or args.context < 32 or args.context > 2048
            or args.threads < 1 or args.train_lieder < 1 or args.validation_lieder < 1
            or args.lr <= 0 or args.checkpoint_seconds < 10):
        parser.error('invalid pilot setting')
    if not args.preflight and not args.output_dir.resolve().is_relative_to((ROOT / 'runs').resolve()):
        parser.error('pilot output must stay under training/runs')
    if args.resume and args.preflight:
        parser.error('preflight cannot resume an existing run')
    if (not args.preflight and args.output_dir.exists() and any(args.output_dir.iterdir())
            and not args.resume):
        parser.error('output directory is nonempty; use a fresh name or --resume')

    started = time.monotonic()
    torch.set_num_threads(args.threads)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    data, rejected, classical_split = load_mixed_pilot(
        train_count=args.train_lieder, validation_count=args.validation_lieder)
    selection = {part: [{'scoreId': item.score.score_id,
                         'oldPrior': item.piece is not None,
                         'workId': item.piece['meta']['workId'] if item.piece else item.score.composition_key}
                        for item in rows] for part, rows in data.items()}
    config = {'context': args.context, 'history_bars': 32,
              'width': 192, 'heads': 6, 'planner_layers': 3, 'decoder_layers': 4}
    model = FourPillarComposerV1(**config)
    model.eval()
    check = {}
    with torch.no_grad():
        for label, item in (('pairedOld', next(row for row in data['train'] if row.piece is not None)),
                            ('classicalNoPrior', next(row for row in data['train'] if row.piece is None))):
            for bar in range(1, min(len(item.score.measures), 33)):
                try:
                    inputs, targets = make_example(item, bar, context=args.context)
                except ValueError:
                    continue
                result = model(**inputs)
                loss, coverage = composition_objective(result, targets)
                if bool(result['legacy_prior_known'][0]) != (item.piece is not None):
                    raise ValueError('old prior visibility differs from source pairing')
                check[label] = {'scoreId': item.score.score_id, 'bar': bar,
                                'tokens': int(inputs['decoder_input'].shape[1]),
                                'loss': float(loss),
                                'coverage': {key: row['known'] for key, row in coverage.items()}}
                break
    if len(check) != 2:
        raise ValueError('pilot did not cover both old-prior and no-prior paths')
    print(json.dumps({'phase': 'preflight', 'fullV1Network': True,
                      'privateProvisionalPilot': True, 'browserWeightsUnchanged': True,
                      'selected': {key: len(rows) for key, rows in data.items()},
                      'rejectedLiederPairs': len(rejected), 'checks': check,
                      'elapsedSeconds': round(time.monotonic() - started, 2)},
                     ensure_ascii=False), flush=True)
    if args.preflight:
        return

    run_config = {**config, 'seed': args.seed, 'lr': args.lr,
                  'maxSeconds': args.max_seconds, 'trainLieder': args.train_lieder,
                  'validationLieder': args.validation_lieder,
                  'checkpointSeconds': args.checkpoint_seconds}
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),
                                  lr=args.lr, weight_decay=0.01)
    rng = random.Random(args.seed + 1)
    state_file = args.output_dir / 'state.pt'
    step, best, elapsed_before = 0, math.inf, 0.0
    if args.resume:
        manifest = json.loads((args.output_dir / 'manifest.json').read_text())
        if (manifest['runConfig'] != run_config or manifest['selection'] != selection
                or manifest['classicalSplit'] != classical_split
                or manifest['sourceHashes']['liederArchive'] != digest(ARCHIVE)
                or manifest['sourceHashes']['oldJoint'] != digest(JOINT)):
            parser.error('pilot manifest, split or source changed; refusing resume')
        state = torch.load(state_file, map_location='cpu', weights_only=False)
        if state['manifestSha256'] != digest(args.output_dir / 'manifest.json'):
            parser.error('pilot manifest hash changed')
        model.load_state_dict(state['model'], strict=True)
        optimizer.load_state_dict(state['optimizer'])
        rng.setstate(state['pythonRng'])
        torch.set_rng_state(state['torchRng'])
        step, best = state['step'], state['best']
        elapsed_before = float(state['elapsedSeconds'])
    else:
        args.output_dir.mkdir(parents=True, exist_ok=False)
        manifest = {
            'schema': 'four-pillar-v1-source-paired-private-pilot-v1',
            'fullV1Network': True, 'notBrowserCompatible': True,
            'notFormalCorpusTraining': True,
            'limitations': ['8+2 aligned Lieder scores by default; provisional 20+3 classical split',
                            'free continuation only; other conditioning tasks not trained',
                            'classical score old prior is explicitly absent',
                            'cross-corpus near duplicates and final rights/split not fully audited',
                            'no constrained free decoder or listening evaluation'],
            'sourceHashes': {'liederArchive': digest(ARCHIVE), 'oldJoint': digest(JOINT)},
            'oldModelTransfer': model.transfer,
            'runConfig': run_config, 'selection': selection,
            'classicalSplit': classical_split,
        }
        (args.output_dir / 'manifest.json').write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2))
        atomic_save({'step': step, 'model': model.state_dict(),
                     'optimizer': optimizer.state_dict(), 'pythonRng': rng.getstate(),
                     'torchRng': torch.get_rng_state(), 'best': best,
                     'elapsedSeconds': time.monotonic() - started,
                     'manifestSha256': digest(args.output_dir / 'manifest.json')}, state_file)
    if elapsed_before >= args.max_seconds:
        print(json.dumps({'done': True, 'step': step, 'elapsedSeconds': elapsed_before,
                          'reason': 'time budget already consumed'}), flush=True)
        return
    model.train()
    last_checkpoint = time.monotonic()
    while elapsed_before + time.monotonic() - started < args.max_seconds:
        item, bar, (inputs, targets) = example_from(data['train'], rng, args.context)
        output = model(**inputs)
        loss, coverage = composition_objective(output, targets)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        gradient = torch.nn.utils.clip_grad_norm_(
            (p for p in model.parameters() if p.requires_grad), 1.0)
        if not torch.isfinite(gradient):
            raise FloatingPointError('nonfinite pilot gradient')
        optimizer.step()
        step += 1
        now = time.monotonic()
        elapsed = elapsed_before + now - started
        if now - last_checkpoint < args.checkpoint_seconds and elapsed < args.max_seconds:
            continue
        validation = evaluate(model, data['validation'], args.context)
        row = {'step': step, 'elapsedSeconds': round(elapsed, 2),
               'trainLoss': float(loss.detach()), 'trainScoreId': item.score.score_id,
               'trainBar': bar, 'trainOldPrior': item.piece is not None,
               'gradientNorm': float(gradient), 'trainCoverage': coverage,
               'validation': validation}
        if validation['objective'] < best:
            best = validation['objective']
            atomic_save({'schema': manifest['schema'], 'config': config,
                         'model': model.state_dict(), 'step': step,
                         'validation': validation, 'notBrowserCompatible': True},
                        args.output_dir / 'best.pt')
        elapsed = elapsed_before + time.monotonic() - started
        row['elapsedSeconds'] = round(elapsed, 2)
        atomic_save({'step': step, 'model': model.state_dict(),
                     'optimizer': optimizer.state_dict(), 'pythonRng': rng.getstate(),
                     'torchRng': torch.get_rng_state(), 'best': best,
                     'elapsedSeconds': elapsed,
                     'manifestSha256': digest(args.output_dir / 'manifest.json')}, state_file)
        with (args.output_dir / 'metrics.jsonl').open('a') as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + '\n')
        print(json.dumps(row, ensure_ascii=False), flush=True)
        last_checkpoint = time.monotonic()
    print(json.dumps({'done': True, 'step': step, 'bestValidation': best,
                      'elapsedSeconds': round(elapsed_before + time.monotonic() - started, 2),
                      'output': str(args.output_dir)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
