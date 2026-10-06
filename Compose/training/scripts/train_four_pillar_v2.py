#!/usr/bin/env python3
"""Train-only four-pillar v2: complete windows and four source-supported tasks.

This is a new run, initialized from the preserved old joint model, not from
the discarded v1 all-data trial. Use --preflight to check all five sources
without optimizer updates or writing a run directory. No internal validation,
browser export or musical-quality claim is made by this script.
"""
from __future__ import annotations

import argparse
import json
import random
import time
from dataclasses import replace
from fractions import Fraction
from bisect import bisect_right
from pathlib import Path

import torch

from four_pillar_midi_data import (_load_midi_score, midi_item_from_score,
                                    sha256, slice_score,
                                    verify_manifest)
from four_pillar_midi_data import source_path
from audit_midi_performance import tempo_events
from four_pillar_score_index import get_score, index_rows, open_index
from four_pillar_trial_data import summarize_bars
from four_pillar_trial_model import PLAN_BARS
from four_pillar_v1_codec import encode_dynamic_score
from four_pillar_v1_pilot_data import PairedScore, ROOT
from four_pillar_v2_data import (canonicalize_item,
                                 canonicalize_pitch_class_item,
                                 transpose_item, valid_shifts)
from four_pillar_v2_model import FourPillarExpressiveV2, expressive_objective
from four_pillar_v2_examples import SourceLabels, make_training_example, UnusableExample, LABELS, JOINT
from four_pillar_v2_integrity import SourceIntegrity, FINGERPRINTS
from train_four_pillar_v1_all_data import SourceCycler
from four_pillar_v2_runtime import (exclusive_run, StopAtBoundary, save_checkpoint,
                                    pack_state, restore_state, model_from_checkpoint)

MIDI_MANIFEST = ROOT / 'data/four-pillar-midi-all-train-v1.json'
SCORE_INDEX = ROOT / 'data/four-pillar-score-all-train-v1.sqlite'
MIX = {'symphony-classical': 0.20, 'symphony-contemporary': 0.35,
       'curated-midi': 0.10, 'Lieder': 0.20, 'classical-scores': 0.15}
CODE_SOURCES = ('train_four_pillar_v2.py', 'train_four_pillar_v1_all_data.py',
                'four_pillar_v2_data.py',
                'four_pillar_v2_model.py', 'four_pillar_v1_model.py',
                'four_pillar_v1_objective.py', 'four_pillar_v1_pilot_data.py',
                'four_pillar_v1_codec.py', 'four_pillar_midi_data.py',
                'four_pillar_score_index.py', 'four_pillar_trial_data.py',
                'four_pillar_trial_model.py', 'four_pillar_codec.py',
                'score_events_v2.py', 'four_pillar_legacy_init.py',
                'joint_model.py', 'joint_data.py', 'orchestra_midi_groups.py',
                'four_pillar_v2_examples.py', 'four_pillar_v1_alignment.py',
                'four_pillar_v2_runtime.py', 'audit_midi_performance.py', 'four_pillar_v2_integrity.py')


def transform_item(item, rng, target_bar, *, prefer_nonzero=False):
    # A past-only canonical branch shares a pitch-token reference across keys
    # when the entire orchestration remains playable. Other passages receive
    # whole-excerpt semitone augmentation; no notes are clipped.
    if not prefer_nonzero and rng.random() < 0.5:
        canonical = canonicalize_item(item, target_bar)
        if canonical is not None:
            return canonical[0], canonical[1], 'past-canonical'
        pitch_class = canonicalize_pitch_class_item(item, target_bar)
        if pitch_class is not None:
            return pitch_class[0], pitch_class[1], 'past-pitch-class-canonical'
    shifts = valid_shifts(item.score)
    choices = tuple(shift for shift in shifts if shift) if prefer_nonzero else shifts
    shift = rng.choice(choices or shifts)
    return transpose_item(item, shift), shift, 'whole-excerpt-shift'


def attach_carried_notes(item, full_score, shift):
    first = item.score.measures[0].onset
    carried = [n for n in full_score.events if n.onset < first < n.end]
    if any(n.pitch is not None and not 0 <= n.pitch+shift <= 127 for n in carried):
        raise UnusableExample('transposition would push a carried note outside MIDI range')
    item.carried_notes = tuple(replace(n,pitch=None if n.pitch is None else n.pitch+shift)
                               for n in carried)


def sample_midi(rows, rng, choose, context, *, prefer_nonzero=False, task=None, rejections=None,
                integrity=None, history_bars=512):
    for _ in range(20):
        row = rows[choose()]
        if integrity is not None:
            integrity.check(row)
        try:
            parsed = _load_midi_score(row)
            # Read explicit FF51 events, not a library's possible default BPM.
            tpq, events = tempo_events(source_path(row).read_bytes())
            grouped = {}
            for tick, qpm in events:
                grouped.setdefault(Fraction(tick,tpq), set()).add(qpm)
            times = sorted(grouped)
            values = [next(iter(grouped[t])) if len(grouped[t]) == 1 else None for t in times]
            tempos = tuple(values[i] if (i := bisect_right(times,m.onset)-1) >= 0 else None
                           for m in parsed[0].measures)
            parsed = (*parsed[:3], tempos)
            active = list(range(1, len(parsed[0].measures)))
            if not active:
                continue
            item = midi_item_from_score(parsed, target_bar=rng.choice(active), history_bars=history_bars)
            item, shift, transform = transform_item(
                item, rng, item.target_relative_bar, prefer_nonzero=prefer_nonzero)
            attach_carried_notes(item, parsed[0], shift)
            inputs, targets, audit = make_training_example(
                item, item.target_relative_bar, rng, context=context, history_bars=history_bars, task=task)
            return row['name'], shift, transform, inputs, targets, audit
        except (ValueError, IndexError, OverflowError) as error:
            if rejections is not None:
                rejections.append({'identity': row['name'], 'reason': str(error)})
            continue
    raise ValueError('20 sampled MIDI passages could not be encoded for v2')


def sample_score(db, rows, rng, choose, context, *, prefer_nonzero=False, labels=None,
                 task=None, rejections=None, history_bars=512):
    for _ in range(20):
        score_id, bars = rows[choose()]
        if bars < 2:
            continue
        try:
            score = get_score(db, score_id)
            active = list(range(1, bars))
            if not active:
                continue
            target = rng.choice(active)
            first = max(0, target - history_bars)
            excerpt = slice_score(score, first, min(bars, target + PLAN_BARS))
            item = PairedScore(excerpt, None, encode_dynamic_score(excerpt),
                               summarize_bars(excerpt), ())
            relative = target - first
            item, shift, transform = transform_item(
                item, rng, relative, prefer_nonzero=prefer_nonzero)
            attach_carried_notes(item, score, shift)
            harmony = labels.harmony(score, first, relative, shift) if labels else ()
            numeric, tempos = labels.expression(score) if labels else ({}, (None,) * bars)
            inputs, targets, audit = make_training_example(
                item, relative, rng, context=context, history_bars=history_bars, task=task, harmony=harmony,
                numeric=numeric, tempos=tempos[first:first+len(excerpt.measures)])
            if labels:
                inputs.update(labels.prior(score, target, shift))
            audit['verifiedLegacyPrior'] = 'legacy_window' in inputs
            return score_id, shift, transform, inputs, targets, audit
        except (ValueError, IndexError, OverflowError) as error:
            if rejections is not None:
                rejections.append({'identity':score_id, 'reason':str(error)})
            continue
    raise ValueError('20 sampled score passages could not be encoded for v2')


def run_training(args, parser, model, rng, pool, midi, db, labels, config, stop, integrity=None):
    cycler = SourceCycler(pool, rng)
    run_config = {'architecture': config, 'maxSeconds': args.max_seconds,
                  'seed': args.seed, 'lr': args.lr, 'threads': args.threads,
                  'warmupSteps': args.warmup_steps,
                  'checkpointSeconds': args.checkpoint_seconds,
                  'sourceMix': MIX, 'taskMix': 'uniform over source-supported tasks',
                  'windowPolicy': 'whole-onset chunks with past local events',
                  'sourceOrder': 'shuffle-without-replacement-until-source-exhausted'}
    manifest = {'schema': 'four-pillar-v2-complete-training-paths-2',
                'parentCheckpointSha256': (sha256(args.init_checkpoint)
                    if getattr(args,'init_checkpoint',None) else None),
                'parentInitialization': getattr(model,'parent_initialization',None),
                'midiMembershipSha256': sha256(MIDI_MANIFEST),
                'midiContentInventorySha256': sha256(FINGERPRINTS),
                'scoreIndexSha256': sha256(SCORE_INDEX),
                'performanceLabelsSha256': sha256(LABELS),
                'liederJointSha256': sha256(JOINT),
                'liederJointMetadataSha256': sha256(JOINT.with_suffix('.json')),
                'codeSha256': {name: sha256(ROOT / 'scripts' / name) for name in CODE_SOURCES},
                'sourceCounts': {s: len(v) for s, v in pool.items()},
                'runConfig': run_config, 'oldModelTransfer': model.transfer,
                'torchVersion': str(torch.__version__),
                'noValidation': True, 'notBrowserCompatible': True,
                'limits': ['augmentation is not strict neural transposition equivariance',
                           'harmony and motif labels are sourced analysis/proxies',
                           'unknown role/texture/intent labels remain masked',
                           'musical quality requires independent material and listening']}
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),
                                  lr=args.lr, weight_decay=0.01)
    manifest_path = args.output_dir / 'manifest.json'
    state_path = args.output_dir / 'state.pt'
    log_path = args.output_dir / 'metrics.jsonl'
    step, elapsed_before = 0, 0.0
    counts = {'sources':{}, 'tasks':{}, 'known':{}, 'rejected':0, 'chunks':0}
    if args.resume:
        if json.loads(manifest_path.read_text()) != manifest:
            parser.error('run manifest, source, code, runtime or config changed; refusing resume')
        state = torch.load(state_path, map_location='cpu', weights_only=False)
        step, elapsed_before, counts = restore_state(
            state, model, optimizer, rng, cycler, sha256(manifest_path))
    else:
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    started = time.monotonic()  # preflight/setup are not training budget
    def elapsed():
        return elapsed_before + time.monotonic() - started
    def log(row, echo=True):
        with log_path.open('a') as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + '\n')
        if echo:
            print(json.dumps(row, ensure_ascii=False), flush=True)
    def checkpoint(last_loss=None):
        save_checkpoint(pack_state(model, optimizer, rng, cycler, step=step,
                         elapsed=elapsed(), manifest_hash=sha256(manifest_path),
                         counts=counts), state_path)
        log({'phase':'checkpoint', 'step':step, 'elapsedSeconds':round(elapsed(),1),
             'lastTrainingLoss':last_loss, 'counts':counts,
             'sourceEpochs':cycler.epochs, 'noValidation':True})
    if not args.resume:
        checkpoint()
    if elapsed_before >= args.max_seconds:
        print(json.dumps({'done':True,'step':step,'elapsedSeconds':elapsed_before}),flush=True)
        return
    last_save, last_loss = time.monotonic(), None
    try:
        while elapsed() < args.max_seconds and not stop.requested:
            source = rng.choices(tuple(pool), weights=[MIX[s] for s in pool])[0]
            choose = lambda: cycler.next_index(source)
            rejections = []
            try:
                identity, shift, transform, inputs, targets, audit = (
                    sample_midi(pool[source],rng,choose,args.context,rejections=rejections,integrity=integrity,history_bars=config["history_bars"])
                    if source in midi else sample_score(db,pool[source],rng,choose,
                        args.context,labels=labels,rejections=rejections,history_bars=config["history_bars"]))
            finally:
                for rejected in rejections:
                    log({'phase':'rejected','step':step,'source':source,**rejected},echo=False)
                counts['rejected'] += len(rejections)
            # Stop requests are handled after a complete optimizer step, never
            # halfway through a state mutation. Forced process termination uses
            # the preceding atomic checkpoint instead.
            rate = args.lr * min(1.0, (step+1)/max(args.warmup_steps,1))
            for group in optimizer.param_groups:
                group['lr'] = rate
            optimizer.zero_grad(set_to_none=True)
            loss, coverage = expressive_objective(model(**inputs), targets)
            loss.backward()
            gradient = torch.nn.utils.clip_grad_norm_(
                (p for p in model.parameters() if p.requires_grad),1.0)
            if not torch.isfinite(gradient):
                raise FloatingPointError('nonfinite gradient; last good checkpoint preserved')
            optimizer.step()
            step += 1
            last_loss = float(loss.detach())
            for name, key in (('sources',source),('tasks',audit['task'])):
                counts[name][key] = counts[name].get(key,0)+1
            for name,value in coverage.items():
                counts['known'][name] = counts['known'].get(name,0)+value['known']
            counts['chunks'] += int(audit['chunkCount'] > 1)
            log({'phase':'train','step':step,'elapsedSeconds':round(elapsed(),1),
                 'source':source,'example':identity,'shift':shift,'transform':transform,
                 'loss':last_loss,'lr':rate,'gradientNorm':float(gradient),
                 'window':audit,'objectives':coverage},echo=step%25==0)
            if time.monotonic()-last_save >= args.checkpoint_seconds:
                checkpoint(last_loss)
                last_save = time.monotonic()
    except BaseException as error:
        # A mid-step failure must not overwrite a known-good optimizer/RNG state.
        log({'phase':'failed','step':step,'error':str(error),
             'recovery':'resume the last complete periodic checkpoint'})
        raise
    checkpoint(last_loss)
    print(json.dumps({'done':not stop.requested,'stopped':stop.requested,'step':step,
                      'elapsedSeconds':round(elapsed(),1),'browserWeightsUnchanged':True}),flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--max-seconds', type=float, required=True)
    parser.add_argument('--context', type=int, default=2048)
    parser.add_argument('--history-bars', type=int, default=512)
    parser.add_argument('--threads', type=int, default=6)
    parser.add_argument('--seed', type=int, default=20260930)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--warmup-steps', type=int, default=100)
    parser.add_argument('--checkpoint-seconds', type=float, default=600)
    parser.add_argument('--preflight', action='store_true')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--init-checkpoint', type=Path,
                        help='start a new compatible run from v2 weights; reset optimizer and sampling state')
    args = parser.parse_args()
    if (args.max_seconds <= 0 or not 32 <= args.context <= 2048 or args.threads < 1 or not 1 <= args.history_bars <= 512
            or args.lr <= 0 or args.checkpoint_seconds < 10 or args.warmup_steps < 0
            or not all(__import__('math').isfinite(v) for v in
                       (args.lr, args.max_seconds, args.checkpoint_seconds))):
        parser.error('invalid v2 training configuration')
    if args.preflight and args.resume:
        parser.error('preflight cannot resume')
    if args.init_checkpoint and args.init_checkpoint.resolve().is_relative_to(args.output_dir.resolve()):
        parser.error('parent checkpoint must be outside the new run directory')
    if not args.preflight and not args.output_dir.resolve().is_relative_to((ROOT / 'runs').resolve()):
        parser.error('output must be under training/runs')
    if not args.preflight and not args.resume and args.output_dir.exists():
        parser.error('new v2 run needs a fresh output directory')
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    started = time.monotonic()
    frozen = json.loads(MIDI_MANIFEST.read_text())
    verify_manifest(frozen)
    integrity = SourceIntegrity(frozen)
    db = open_index(SCORE_INDEX)
    try:
        score_meta = json.loads(db.execute(
            "SELECT value FROM metadata WHERE key='manifest'").fetchone()[0])
        if score_meta['sourceHashes']['midiMembership'] != sha256(MIDI_MANIFEST):
            raise ValueError('score index and MIDI membership disagree')
        midi = {'symphony-classical': [r for r in frozen['rows'] if r['source'] == 'SymphonyNet'
                                      and '/classical/' in r['name']],
                'symphony-contemporary': [r for r in frozen['rows'] if r['source'] == 'SymphonyNet'
                                         and '/contemporary/' in r['name']],
                'curated-midi': [r for r in frozen['rows'] if r['source'] == 'MIDI-Library']}
        scores = {source: index_rows(db, source=source, split='train')
                  for source in ('Lieder', 'classical-scores')}
        pool = {**midi, **scores}
        if (sum(len(rows) for rows in midi.values()) != 45357
                or len(scores['Lieder']) != 1131 or len(scores['classical-scores']) != 303):
            raise ValueError('expected all selected real sources, no validation')
        rng = random.Random(args.seed + 1)
        labels = SourceLabels()
        config = {'context': args.context, 'history_bars': args.history_bars,
                  'width': 192, 'heads': 6, 'planner_layers': 3, 'decoder_layers': 4}
        model = (model_from_checkpoint(args.init_checkpoint, config=config)
                 if args.init_checkpoint else FourPillarExpressiveV2(**config))
        model.train()
        checks = {}
        jobs = [(source,'free') for source in pool] + [
            ('Lieder',task) for task in ('given_melody','given_chords','given_motif')]
        for source, task in jobs:
            rows = pool[source]
            choose = lambda: rng.randrange(len(rows))
            rejections = []
            identity, shift, transform, inputs, targets, audit = (sample_midi(rows, rng, choose, args.context,
                                                            prefer_nonzero=True, task=task, rejections=rejections,
                                                            integrity=integrity, history_bars=args.history_bars)
                                                if source in midi else
                                                sample_score(db, rows, rng, choose, args.context,
                                                             prefer_nonzero=True, labels=labels, task=task,
                                                             rejections=rejections, history_bars=args.history_bars))
            loss, coverage = expressive_objective(model(**inputs), targets)
            loss.backward()  # no optimizer exists; preflight never updates weights
            finite = all(torch.isfinite(p.grad).all().item()
                         for p in model.parameters() if p.requires_grad and p.grad is not None)
            model.zero_grad(set_to_none=True)
            if not finite:
                raise FloatingPointError('nonfinite v2 preflight gradient: ' + source)
            checks[source+'/'+task] = {'identity': identity, 'shift': shift, 'transform': transform,
                              'tokens': int(inputs['decoder_input'].shape[1]),
                              'window': audit,
                              'rejections': rejections,
                              'loss': float(loss.detach()),
                              'objectives': coverage,
                              'known': {name: row['known'] for name, row in coverage.items()}}
        print(json.dumps({'phase': 'preflight', 'pool': {s: len(v) for s, v in pool.items()},
                          'architecture': config, 'parameters': model.parameter_counts(),
                          'checks': checks, 'noValidation': True, 'noWeightUpdate': True,
                          'seconds': round(time.monotonic() - started, 1)},
                         ensure_ascii=False), flush=True)
        if args.preflight:
            return

        if args.resume:
            if not args.output_dir.is_dir():
                parser.error('resume needs an existing run directory')
        else:
            args.output_dir.mkdir(parents=True, exist_ok=False)
        with exclusive_run(args.output_dir), StopAtBoundary() as stop:
            run_training(args, parser, model, rng, pool, midi, db, labels, config, stop, integrity)
    finally:
        db.close()


if __name__ == '__main__':
    main()
