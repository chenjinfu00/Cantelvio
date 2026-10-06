#!/usr/bin/env python3
"""Train an exact-note expression sidecar on the joint-v1 Transformer.

This is an experimental *candidate*, not a browser export. It predicts per-step
note count, pitch, fractional onset, exact notated duration, tuplet ratio and
notated expression for R/B/M while retaining the existing R/H/B/M backbone.
With --fine-tune-base, the old R/H/B/M weights also receive gradients while a
joint-token replay loss protects the original decoder. Candidates still need
browser integration and listening evaluation before any runtime replacement.
"""
import argparse
import copy
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import random
import time

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from build_joint_expression import SLOTS
from joint_data import load_corpus, piece_windows, encode_window, collate
from joint_model import StructuredJoint, loss_and_metrics

ROOT = Path(__file__).resolve().parents[1]
FIELDS = ('pitch', 'sub', 'dur', 'ratio', 'dynamic', 'accent', 'wedge')
FIELD_WEIGHTS = {'pitch': 1.0, 'sub': 1.0, 'dur': 1.0, 'ratio': 0.5,
                 'dynamic': 0.5, 'accent': 0.25, 'wedge': 0.25}
LOSS_SCHEMA = 'known-fields-v2'


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


class Window:
    def __init__(self, piece, events, start, end, known=None):
        self.piece, self.start, self.end = piece, start, end
        if known is not None and known.shape != (len(events), len(FIELDS)):
            raise ValueError('event known-mask shape differs from events')
        lo = np.searchsorted(events[:, 0], start, side='left')
        hi = np.searchsorted(events[:, 0], end, side='left')
        self.events = events[lo:hi]
        if known is None:
            # Version-1 MusicXML corpus: class 0 is unseen for the train-only
            # time/ratio vocabularies, and "unknown" is dynamic class 0.
            self.known = np.ones((len(self.events), len(FIELDS)), np.bool_)
            for field, column in (('sub', 3), ('dur', 4), ('ratio', 5), ('dynamic', 6)):
                self.known[:, FIELDS.index(field)] = self.events[:, column] != 0
        else:
            self.known = known[lo:hi].astype(np.bool_)
        bins = np.bincount((self.events[:, 0] - start) * 3 + self.events[:, 1],
                           minlength=(end - start) * 3).reshape(-1, 3)
        self.overflow = int(np.maximum(bins - np.asarray(SLOTS), 0).sum())

    def annotation(self):
        count = np.zeros((128, 3), np.int16)
        fields = np.zeros((128, 3, max(SLOTS), len(FIELDS)), np.int16)
        field_known = np.zeros_like(fields, dtype=np.bool_)
        for i, (step, role, *values) in enumerate(self.events):
            t, r = int(step) - self.start, int(role)
            s = count[t, r]
            if s >= SLOTS[r]:
                continue
            fields[t, r, s] = values
            field_known[t, r, s] = self.known[i]
            count[t, r] += 1
        return count, fields, field_known

    def row(self):
        return encode_window(self.piece, self.start, self.end)


def make_windows(lieder, annotations, manifest):
    assert len(annotations['offsets']) == len(manifest['records']) + 1
    index = {p['meta']['workId']: p for p in lieder}
    splits = {'train': [], 'validation': []}
    stats = {'overflowWindows': 0, 'overflowEvents': 0, 'records': len(manifest['records'])}
    for i, record in enumerate(manifest['records']):
        split = record['split']
        if split not in splits:
            continue  # test is untouched
        piece = index.get(record['workId'])
        if piece is None or len(piece['arrays']['bar']) != record['steps']:
            raise ValueError(f"base corpus changed for {record['workId']}")
        events = annotations['events'][annotations['offsets'][i]:annotations['offsets'][i + 1]]
        known = (annotations['known'][annotations['offsets'][i]:annotations['offsets'][i + 1]]
                 if 'known' in annotations else None)
        for start, end in piece_windows(piece):
            w = Window(piece, events, start, end, known=known)
            if w.overflow:
                stats['overflowWindows'] += 1
                stats['overflowEvents'] += w.overflow
                continue  # never silently discard score events
            splits[split].append(w)
    return splits, stats


def batch_of(windows):
    b = collate([w.row() for w in windows])
    annotations = [w.annotation() for w in windows]
    b['event_count'] = torch.as_tensor(np.stack([a[0] for a in annotations]).astype(np.int64))
    b['event_fields'] = torch.as_tensor(np.stack([a[1] for a in annotations]).astype(np.int64))
    b['event_known'] = torch.as_tensor(np.stack([a[2] for a in annotations]))
    return b


class ExpressionSidecar(nn.Module):
    def __init__(self, base, vocab, *, train_base=False):
        super().__init__()
        self.base = base
        self.train_base = train_base
        if not train_base:
            for p in self.base.parameters():
                p.requires_grad_(False)
            self.base.eval()
        d = base.d
        sizes = {'pitch': 128, 'sub': len(vocab['sub']), 'dur': len(vocab['dur']),
                 'ratio': len(vocab['ratio']), 'dynamic': len(vocab['dynamic']),
                 'accent': 3, 'wedge': 3}
        self.embed = nn.ModuleDict({k: nn.Embedding(n, d) for k, n in sizes.items()})
        self.role = nn.Embedding(3, d)
        self.input_norm = nn.LayerNorm(d)
        self.coarse = nn.Linear(d, d)
        self.count_head = nn.ModuleList([nn.Linear(d, n + 1) for n in SLOTS])
        self.slot = nn.Embedding(max(SLOTS), d)
        self.field_head = nn.ModuleDict({k: nn.Linear(d, n) for k, n in sizes.items()})
        self.out_norm = nn.LayerNorm(d)

    def train(self, mode=True):
        super().train(mode)
        if not self.train_base:
            self.base.eval()  # frozen pretrained dropout must stay disabled
        return self

    def features(self, b):
        f = b['event_fields']; count = b['event_count']
        B, T, _, K, _ = f.shape
        x = self.role.weight[None, None, :, None, :]
        for j, key in enumerate(FIELDS):
            x = x + self.embed[key](f[..., j])
        slots = torch.arange(K, device=f.device)[None, None, None, :]
        mask = (slots < count[..., None]).unsqueeze(-1)
        x = (x * mask).sum((2, 3)) / count.sum(-1).clamp(min=1).sqrt()[..., None]
        extra = self.input_norm(x)
        # A truly empty step must contribute zero, not LayerNorm's learned bias.
        extra = extra * (count.sum(-1) > 0)[..., None]
        _, h = self.base(b, extra_step=extra, return_features=True)
        return h

    def losses(self, b):
        h = self.features(b)
        # The sidecar is sampled *after* the old model finishes R/H/B/M for
        # step t+1, so it may condition on those coarse tokens without seeing
        # the expressive target events. This also helps preserve old harmony.
        coarse = sum(self.base.tok[i](b[name][:, 1:]) for i, name in enumerate(('R', 'H', 'B', 'M')))
        coarse = self.coarse(coarse)
        target_count = b['event_count'][:, 1:]
        target_fields = b['event_fields'][:, 1:]
        target_known = b['event_known'][:, 1:]
        valid = b['valid'][:, 1:]
        total = h.new_zeros(())
        metrics = {}
        # Backbone state at t predicts exact events of step t+1. The first
        # step in each window is context only, mirroring joint-v1 training.
        for r, stream_index in enumerate((0, 2, 3)):
            source = h[:, :-1, stream_index] + coarse
            count_logits = self.count_head[r](source)
            ce = F.cross_entropy(count_logits[valid], target_count[..., r][valid])
            total = total + ce
            metrics[f'{r}.count'] = float(ce.detach())
            for j, key in enumerate(FIELDS):
                slot = torch.arange(SLOTS[r], device=h.device)[None, None, :]
                active = (slot < target_count[..., r, None]) & valid[..., None]
                y = target_fields[:, :, r, :SLOTS[r], j]
                active = active & target_known[:, :, r, :SLOTS[r], j]
                if not active.any():
                    continue
                selected = (source[:, :, None, :] + self.slot(slot))[active]
                lg = self.field_head[key](self.out_norm(selected))
                field_ce = F.cross_entropy(lg, y[active])
                total = total + FIELD_WEIGHTS[key] * field_ce
                metrics[f'{r}.{key}'] = float(field_ce.detach())
        return total, metrics


def evaluate(model, windows, batch=4, joint_weight=0.0):
    model.eval()
    sums, counts = {}, {}
    objective, joint_objective, examples = 0.0, 0.0, 0
    with torch.no_grad():
        for i in range(0, len(windows), batch):
            row = batch_of(windows[i:i + batch])
            loss, metrics = model.losses(row)
            joint = loss_and_metrics(model.base, row)[0] if joint_weight else loss.new_zeros(())
            n = min(batch, len(windows) - i)
            objective += float(loss.detach()) * n
            joint_objective += float(joint.detach()) * n
            examples += n
            for key, value in metrics.items():
                sums[key] = sums.get(key, 0.0) + value * n
                counts[key] = counts.get(key, 0) + n
    model.train()
    expression = objective / examples
    joint = joint_objective / examples
    return {'objective': round(expression + joint_weight * joint, 5),
            'expressionObjective': round(expression, 5),
            'jointObjective': round(joint, 5),
            **{k: round(sums[k] / counts[k], 5) for k in sorted(sums)}}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--expression', type=Path, required=True)
    ap.add_argument('--lieder', type=Path, default=ROOT / 'data/joint/lieder-joint.npz')
    ap.add_argument('--base-checkpoint', type=Path, default=ROOT / 'runs/backups/joint-v1-before-new-data-20260928/model.pt')
    ap.add_argument('--output-dir', type=Path, required=True)
    ap.add_argument('--steps', type=int, default=None,
                    help='optional step limit; omitted with --max-seconds means time-only training')
    ap.add_argument('--batch', type=int, default=4)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--eval-every', type=int, default=200)
    ap.add_argument('--eval-windows', type=int, default=160)
    ap.add_argument('--seed', type=int, default=930228)
    ap.add_argument('--threads', type=int, default=2)
    ap.add_argument('--max-seconds', type=float, default=0,
                    help='gracefully stop after this cumulative training-time budget at an evaluation checkpoint')
    ap.add_argument('--fine-tune-base', action='store_true',
                    help='update old joint Transformer as well as sidecar; uses a joint-token preservation loss')
    ap.add_argument('--base-lr', type=float, default=3e-5)
    ap.add_argument('--joint-weight', type=float, default=1.0)
    ap.add_argument('--resume', action='store_true')
    a = ap.parse_args()
    if a.steps is None:
        a.steps = 0 if a.max_seconds else 2400
    if (a.steps < 0 or (a.steps == 0 and a.max_seconds <= 0) or a.batch < 1 or
            a.eval_every < 1 or a.max_seconds < 0 or a.base_lr <= 0 or a.joint_weight < 0):
        ap.error('use positive steps, or --steps 0 with positive --max-seconds; batch and eval-every must be positive')
    manifest_path = a.expression.with_suffix('.json')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('limited'):
        ap.error('expression corpus was built with --limit; rebuild the full corpus')
    if a.output_dir.exists() and any(a.output_dir.iterdir()) and not a.resume:
        ap.error('output directory is not empty; use a new path or --resume')
    if a.resume and not (a.output_dir / 'state.pt').exists():
        ap.error('--resume needs an existing state.pt')
    np.random.seed(a.seed); torch.manual_seed(a.seed); random.seed(a.seed)
    torch.set_num_threads(a.threads)
    print(json.dumps({'phase': 'loading', 'expression': str(a.expression),
                      'baseCheckpoint': str(a.base_checkpoint)}), flush=True)
    with np.load(a.expression) as data:
        annotations = {k: data[k] for k in data.files}
    windows, stats = make_windows(load_corpus(a.lieder), annotations, manifest)
    print(json.dumps({'phase': 'window-audit', 'windows': {k: len(v) for k, v in windows.items()},
                      **stats}), flush=True)
    if not windows['train'] or not windows['validation']:
        ap.error('need both training and validation windows')
    rng = random.Random(a.seed + 1)
    val = rng.sample(windows['validation'], min(a.eval_windows, len(windows['validation'])))
    ckpt = torch.load(a.base_checkpoint, map_location='cpu', weights_only=False)
    if ckpt['config']['kind'] != 'structured' or ckpt['config']['T'] != 128:
        ap.error('requires the backed-up structured joint-v1 checkpoint with T=128')
    base = StructuredJoint(**{k: v for k, v in ckpt['config'].items() if k != 'kind'})
    base.load_state_dict(ckpt['state_dict'], strict=True)
    model = ExpressionSidecar(base, manifest['vocab'], train_base=a.fine_tune_base)
    opt = torch.optim.AdamW(
        [{'params': [p for p in model.base.parameters() if p.requires_grad],
          'lr': a.base_lr, 'scale': a.base_lr / a.lr},
         {'params': [p for name, p in model.named_parameters()
                     if not name.startswith('base.') and p.requires_grad], 'lr': a.lr, 'scale': 1.0}]
        if a.fine_tune_base else (p for p in model.parameters() if p.requires_grad),
        lr=a.lr, weight_decay=0.02)
    a.output_dir.mkdir(parents=True, exist_ok=True)
    state_path = a.output_dir / 'state.pt'
    start, best, best_step = 1, float('inf'), None
    elapsed_before = 0.0
    curve = []
    if a.resume:
        state = torch.load(state_path, map_location='cpu', weights_only=False)
        if state['dataHash'] != sha256(a.expression) or state['baseHash'] != sha256(a.base_checkpoint):
            ap.error('resume input hashes differ')
        loss_schema = LOSS_SCHEMA + ('-fine-tuned' if a.fine_tune_base else '')
        if state.get('lossSchema') != loss_schema:
            ap.error('resume loss schema differs; use a new output directory')
        schedule = {'steps': a.steps, 'batch': a.batch, 'lr': a.lr,
                    'evalEvery': a.eval_every, 'seed': a.seed,
                    'fineTuneBase': a.fine_tune_base, 'baseLr': a.base_lr,
                    'jointWeight': a.joint_weight}
        if state['schedule'] != schedule:
            ap.error('resume schedule differs; reuse the original training arguments')
        model.load_state_dict(state['model']); opt.load_state_dict(state['optimizer'])
        rng.setstate(state['rng']); torch.set_rng_state(state['torch'])
        start, best, best_step, curve = state['step'] + 1, state['best'], state['bestStep'], state['curve']
        elapsed_before = float(state.get('elapsedSeconds', 0.0))
    else:
        provenance = {'base': str(a.base_checkpoint), 'baseHash': sha256(a.base_checkpoint),
                      'expression': str(a.expression), 'dataHash': sha256(a.expression),
                      'lieder': str(a.lieder), 'liederHash': sha256(a.lieder),
                      'windows': {k: len(v) for k, v in windows.items()}, 'audit': stats,
                      'frozenBase': not a.fine_tune_base, 'browserCompatible': False,
                      'lossSchema': LOSS_SCHEMA + ('-fine-tuned' if a.fine_tune_base else ''),
                      'notes': 'experimental expression sidecar; not a browser export or old-model replacement'}
        (a.output_dir / 'provenance.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=1))
        print(json.dumps(provenance, ensure_ascii=False), flush=True)
    model.train()
    if a.steps and start > a.steps:
        print(json.dumps({'done': True, 'bestStep': best_step, 'output': str(a.output_dir)}), flush=True)
        return
    if a.max_seconds and elapsed_before >= a.max_seconds:
        print(json.dumps({'budgetStopped': True, 'step': start - 1, 'bestStep': best_step}), flush=True)
        return
    started = time.monotonic()
    recent = []
    budget_stopped = False
    iterator = itertools.count(start) if a.steps == 0 else range(start, a.steps + 1)
    for step in iterator:
        progress = ((elapsed_before + time.monotonic() - started) / a.max_seconds
                    if a.steps == 0 else (step - 1) / a.steps)
        lr = a.lr * (0.1 + 0.9 * (1 + math.cos(math.pi * min(1.0, progress))) / 2)
        for group in opt.param_groups:
            group['lr'] = lr * group.get('scale', 1.0)
        rows = rng.choices(windows['train'], k=a.batch)
        train_batch = batch_of(rows)
        expression_loss, _ = model.losses(train_batch)
        joint_loss = (loss_and_metrics(model.base, train_batch)[0]
                      if a.fine_tune_base else expression_loss.new_zeros(()))
        loss = expression_loss + a.joint_weight * joint_loss
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_((p for p in model.parameters() if p.requires_grad), 1.0)
        opt.step()
        recent.append(float(loss.detach()))
        recent = recent[-50:]
        deadline_reached = bool(a.max_seconds and elapsed_before + time.monotonic() - started >= a.max_seconds)
        steps_done = bool(a.steps and step == a.steps)
        if step % a.eval_every == 0 or steps_done or deadline_reached:
            ev = evaluate(model, val, joint_weight=a.joint_weight if a.fine_tune_base else 0.0)
            elapsed = elapsed_before + time.monotonic() - started
            budget_stopped = bool(a.max_seconds and elapsed >= a.max_seconds)
            score = ev['objective']
            row = {'step': step, 'trainLoss': round(float(np.mean(recent)), 5),
                   'validationObjective': score, 'validation': ev,
                   'trainExpressionLoss': round(float(expression_loss.detach()), 5),
                   'trainJointLoss': round(float(joint_loss.detach()), 5)}
            curve.append(row)
            print(json.dumps(row), flush=True)
            if score < best:
                best, best_step = score, step
                torch.save({'config': ckpt['config'], 'sidecar': {k: v for k, v in model.state_dict().items()
                            if not k.startswith('base.')}, 'vocab': manifest['vocab'], 'step': step,
                            'baseHash': sha256(a.base_checkpoint),
                            'lossSchema': LOSS_SCHEMA + ('-fine-tuned' if a.fine_tune_base else ''),
                            'fineTunedBase': a.fine_tune_base}, a.output_dir / 'best.tmp')
                os.replace(a.output_dir / 'best.tmp', a.output_dir / 'best.pt')
                if a.fine_tune_base:
                    torch.save({'config': ckpt['config'], 'state_dict': model.base.state_dict(),
                                'sourceHash': sha256(a.base_checkpoint), 'step': step},
                               a.output_dir / 'best-base.tmp')
                    os.replace(a.output_dir / 'best-base.tmp', a.output_dir / 'best-base.pt')
            state = {'step': step, 'model': model.state_dict(), 'optimizer': opt.state_dict(),
                     'rng': rng.getstate(), 'torch': torch.get_rng_state(), 'best': best,
                     'bestStep': best_step, 'curve': curve,
                     'dataHash': sha256(a.expression), 'baseHash': sha256(a.base_checkpoint),
                     'lossSchema': LOSS_SCHEMA + ('-fine-tuned' if a.fine_tune_base else ''),
                     'elapsedSeconds': elapsed,
                     'schedule': {'steps': a.steps, 'batch': a.batch, 'lr': a.lr,
                                  'evalEvery': a.eval_every, 'seed': a.seed,
                                  'fineTuneBase': a.fine_tune_base, 'baseLr': a.base_lr,
                                  'jointWeight': a.joint_weight}}
            torch.save(state, a.output_dir / 'state.tmp')
            os.replace(a.output_dir / 'state.tmp', state_path)
            (a.output_dir / 'metrics.json').write_text(json.dumps({'curve': curve, 'bestStep': best_step,
                                                                    'completed': steps_done or budget_stopped,
                                                                    'budgetStopped': budget_stopped}, indent=1))
            if budget_stopped:
                break
    print(json.dumps({'done': steps_done or budget_stopped, 'budgetStopped': budget_stopped,
                      'elapsedSeconds': elapsed,
                      'bestStep': best_step, 'output': str(a.output_dir)}), flush=True)


if __name__ == '__main__':
    main()
