#!/usr/bin/env python3
"""Time-bounded, isolated four-pillar *technical trial* on curated score candidates.

This trains a two-scale form/event model, not the complete v1 composer. It does
not export to or alter the browser. Optional legacy initialization copies
compatible H/M weight blocks, but does not run the old R/H/B/M backbone or
claim an aligned score-level teacher: the corpus lacks trustworthy alignment.
The trial checks the new exact-time event, form and orchestration pathways and
is deliberately marked provisional in every saved checkpoint.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

from four_pillar_split import build_split, digest
from four_pillar_legacy_init import initialize_from_legacy
from four_pillar_trial_data import collate, load_selected, sample_example
from four_pillar_trial_model import FourPillarTrial

ROOT = Path(__file__).resolve().parents[1]
LEGACY = ROOT / 'runs/joint-continued-expression-v1/best-base.pt'
TASKS = ('free', 'given_high_voice', 'given_low_voice', 'past_motif')


def loss_terms(model: FourPillarTrial, batch: dict) -> tuple[torch.Tensor, dict]:
    out = model(history=batch['history'], history_known=batch['history_known'],
                decoder_input=batch['decoder_input'], material=batch['material'],
                material_known=batch['material_known'])
    token_losses = F.cross_entropy(out['tokens'].transpose(1, 2), batch['target'], reduction='none')
    mask = batch['loss_mask']
    if not mask.any():
        raise ValueError('batch has no supervised event tokens')
    event_loss = (token_losses * mask).sum() / mask.sum()
    future_mask = batch['future_known'][..., None]
    form_loss = (((out['summaries'] - batch['future']) ** 2) * future_mask).sum()
    form_loss = form_loss / (future_mask.sum() * batch['future'].shape[-1]).clamp(min=1)
    motif_loss = F.cross_entropy(out['motif'], batch['motif_target'])
    loss = event_loss + 0.25 * form_loss + 0.05 * motif_loss
    if not torch.isfinite(loss):
        raise FloatingPointError('nonfinite trial loss')
    return loss, {'event': float(event_loss.detach()), 'form': float(form_loss.detach()),
                  'motif_proxy': float(motif_loss.detach())}


def atomic_save(state: dict, target: Path):
    temporary = target.with_suffix(target.suffix + '.tmp')
    torch.save(state, temporary)
    os.replace(temporary, target)


def evaluate(model: FourPillarTrial, scores: list, *, seed: int, history_bars: int,
             context: int, device: torch.device) -> dict:
    model.eval()
    rng = random.Random(seed + 991)
    losses, terms = [], []
    with torch.no_grad():
        for task in TASKS:
            example = sample_example(scores, rng, history_bars=history_bars,
                                     context=context, task=task)
            loss, components = loss_terms(model, collate([example], context=context, device=device))
            losses.append(float(loss))
            terms.append(components)
    model.train()
    return {'objective': float(np.mean(losses)),
            'event': float(np.mean([x['event'] for x in terms])),
            'form': float(np.mean([x['form'] for x in terms])),
            'motif_proxy': float(np.mean([x['motif_proxy'] for x in terms])),
            'examples': len(losses)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output-dir', type=Path, required=True)
    ap.add_argument('--technical-smoke', action='store_true', help='required; this is not final training')
    ap.add_argument('--init-from-legacy', action='store_true',
                    help='partially initialize H/M decoder blocks and bar features from continued old model')
    ap.add_argument('--max-seconds', type=float, default=300,
                    help='cumulative wall-clock budget, including corpus loading and evaluation')
    ap.add_argument('--steps', type=int, default=0, help='optional shorter test; 0 means time-only')
    ap.add_argument('--batch', type=int, default=1)
    ap.add_argument('--threads', type=int, default=2)
    ap.add_argument('--context', type=int, default=192)
    ap.add_argument('--history-bars', type=int, default=32)
    ap.add_argument('--width', type=int, default=192)
    ap.add_argument('--heads', type=int, default=6)
    ap.add_argument('--planner-layers', type=int, default=4)
    ap.add_argument('--decoder-layers', type=int, default=6)
    ap.add_argument('--lr', type=float, default=2e-4)
    ap.add_argument('--seed', type=int, default=20260929)
    ap.add_argument('--checkpoint-every', type=int, default=10)
    ap.add_argument('--preflight', action='store_true', help='data checks only; no optimizer step or output writes')
    ap.add_argument('--resume', action='store_true')
    a = ap.parse_args()
    if not a.technical_smoke:
        ap.error('add --technical-smoke; this entry point is not final four-pillar training')
    if (a.max_seconds <= 0 or a.batch < 1 or a.steps < 0 or a.threads < 1
            or a.context < 32 or a.checkpoint_every < 1):
        ap.error('invalid time, batch, step, thread or context setting')
    if not a.preflight and not a.output_dir.resolve().is_relative_to((ROOT / 'runs').resolve()):
        ap.error('trial outputs must stay under training/runs')
    if a.output_dir.exists() and any(a.output_dir.iterdir()) and not a.resume and not a.preflight:
        ap.error('output directory is nonempty; choose a new path or use --resume')
    print(json.dumps({'scope': 'technical-smoke', 'fullFourPillarV1': False,
                      'legacyPriorUsed': False,
                      'legacyWeightInitialization': a.init_from_legacy,
                      'browserWeightsUnchanged': True}), flush=True)
    started = time.monotonic()
    torch.set_num_threads(a.threads)
    random.seed(a.seed)
    np.random.seed(a.seed)
    torch.manual_seed(a.seed)
    split = build_split(smoke=True)
    print(json.dumps({'phase': 'loading', 'trainScores': len(split['scores']['train']),
                      'validationScores': len(split['scores']['validation']),
                      'excluded': split['excluded']}), flush=True)
    selected = load_selected(split)
    note_counts = {key: sum(len(item.score.events) for item in scores)
                   for key, scores in selected.items()}
    print(json.dumps({'phase': 'loaded', 'noteCounts': note_counts,
                      'elapsedSeconds': round(time.monotonic() - started, 2)}), flush=True)
    config = dict(width=a.width, heads=a.heads, planner_layers=a.planner_layers,
                  decoder_layers=a.decoder_layers, history_bars=a.history_bars,
                  context=a.context)
    if a.preflight:
        preview_rng = random.Random(a.seed)
        sampled = {}
        for partition in ('train', 'validation'):
            sampled[partition] = {}
            for task in TASKS:
                example = sample_example(selected[partition], preview_rng,
                                         history_bars=a.history_bars, context=a.context,
                                         task=task)
                sampled[partition][task] = len(example['target'])
        transfer = initialize_from_legacy(FourPillarTrial(**config)) if a.init_from_legacy else None
        print(json.dumps({'preflight': 'passed', 'splitSchema': split['schema'],
                          'legacyInitialization': transfer,
                          'sampledTargetTokens': sampled}), flush=True)
        return

    run_config = {**config, 'batch': a.batch, 'lr': a.lr, 'seed': a.seed,
                  'checkpointEvery': a.checkpoint_every}
    if a.init_from_legacy:
        run_config['legacyInit'] = 'continued-joint-H-M-half-head-transplant-v1'
    device = torch.device('cpu')  # validated on the project-local macOS PyTorch runtime
    model = FourPillarTrial(**config).to(device)
    initialization = None
    if a.init_from_legacy and not a.resume:
        initialization = initialize_from_legacy(model)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    rng = random.Random(a.seed + 1)
    step = 0
    best = math.inf
    elapsed_before = 0.0
    state_path = a.output_dir / 'state.pt'
    if a.resume:
        if not state_path.is_file():
            ap.error('--resume requires existing state.pt')
        manifest = json.loads((a.output_dir / 'manifest.json').read_text())
        if manifest['runConfig'] != run_config or manifest['split'] != split:
            ap.error('resume config or source hashes changed')
        state = torch.load(state_path, map_location=device, weights_only=False)
        if state.get('manifestSha256') != digest(a.output_dir / 'manifest.json'):
            ap.error('resume manifest hash differs')
        model.load_state_dict(state['model'], strict=True)
        opt.load_state_dict(state['optimizer'])
        rng.setstate(state['pythonRng'])
        torch.set_rng_state(state['torchRng'])
        step, best = state['step'], state['best']
        elapsed_before = float(state['elapsedSeconds'])
    else:
        a.output_dir.mkdir(parents=True, exist_ok=True)
        manifest = {'schema': 'four-pillar-technical-trial-v1',
                    'notBrowserCompatible': True, 'notFullV1': True,
                    'legacyPriorUsed': False,
                    'legacyWeightInitialization': initialization,
                    'legacyCheckpoint': str(LEGACY.relative_to(ROOT)),
                    'legacyCheckpointSha256': digest(LEGACY),
                    'limitations': ['provisional internal split; all-corpus near-duplicates not fully audited',
                                    'partial old H/M weight transplant is not a verified R/H/B/M-to-score prior bridge',
                                    'no hard-locked free-running score decoder',
                                    'voice and pitch-class guide tasks are not chord labels',
                                    'tempo/dynamic supervision not yet source-calibrated',
                                    'S3 file-level score/annotation release rights not verified'],
                    'runConfig': run_config, 'split': split,
                    'lossWeights': {'event': 1.0, 'futureBarSummary': 0.25, 'motifProxy': 0.05}}
        (a.output_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
        # A zero-step state allows a clean resume if startup consumes the budget
        # or the machine is interrupted before the first scheduled checkpoint.
        atomic_save({'step': 0, 'model': model.state_dict(),
                     'optimizer': opt.state_dict(), 'pythonRng': rng.getstate(),
                     'torchRng': torch.get_rng_state(), 'best': best,
                     'elapsedSeconds': time.monotonic() - started,
                     'manifestSha256': digest(a.output_dir / 'manifest.json')}, state_path)
    if elapsed_before >= a.max_seconds:
        print(json.dumps({'budgetStopped': True, 'step': step,
                          'elapsedSeconds': elapsed_before}), flush=True)
        return

    model.train()
    last_save = time.monotonic()
    while True:
        now = time.monotonic()
        elapsed = elapsed_before + now - started
        if elapsed >= a.max_seconds or (a.steps and step >= a.steps):
            break
        examples = [sample_example(selected['train'], rng, history_bars=a.history_bars,
                                   context=a.context) for _ in range(a.batch)]
        batch = collate(examples, context=a.context, device=device)
        loss, components = loss_terms(model, batch)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        grad = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        if not torch.isfinite(grad):
            raise FloatingPointError('nonfinite trial gradient')
        opt.step()
        step += 1
        now = time.monotonic()
        elapsed = elapsed_before + now - started
        due = (step % a.checkpoint_every == 0 or now - last_save >= 45
               or elapsed >= a.max_seconds or (a.steps and step >= a.steps))
        if due:
            validation = evaluate(model, selected['validation'], seed=a.seed,
                                  history_bars=a.history_bars, context=a.context, device=device)
            row = {'step': step, 'elapsedSeconds': round(elapsed, 2),
                   'trainLoss': float(loss.detach()), 'train': components,
                   'validation': validation, 'gradientNorm': float(grad)}
            if validation['objective'] < best:
                best = validation['objective']
                atomic_save({'schema': 'four-pillar-technical-trial-v1',
                             'config': config, 'model': model.state_dict(),
                             'legacyWeightInitialization': manifest['legacyWeightInitialization'],
                             'step': step, 'validation': validation,
                             'notBrowserCompatible': True, 'notFullV1': True},
                            a.output_dir / 'best.pt')
            elapsed = elapsed_before + time.monotonic() - started
            row['elapsedSeconds'] = round(elapsed, 2)
            state = {'step': step, 'model': model.state_dict(), 'optimizer': opt.state_dict(),
                     'pythonRng': rng.getstate(), 'torchRng': torch.get_rng_state(),
                     'best': best, 'elapsedSeconds': elapsed,
                     'manifestSha256': digest(a.output_dir / 'manifest.json')}
            atomic_save(state, state_path)
            with (a.output_dir / 'metrics.jsonl').open('a') as stream:
                stream.write(json.dumps(row) + '\n')
            print(json.dumps(row), flush=True)
            last_save = now
    print(json.dumps({'done': True, 'step': step,
                      'elapsedSeconds': round(elapsed_before + time.monotonic() - started, 2),
                      'bestObjective': best, 'output': str(a.output_dir)}), flush=True)


if __name__ == '__main__':
    main()
