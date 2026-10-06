#!/usr/bin/env python3
"""Train the AIlegro joint R/H/B/M Transformer prototype (or the flat baseline).

Schedule: synthetic pretraining (existing rule system), then fine-tuning on the
OpenScore Lieder four-stream corpus with a little synthetic replay. The Lieder
test split is never touched here; checkpoints are selected on Lieder validation.

  python training/scripts/train_joint.py --model structured --output-dir training/runs/joint-v1/structured
  python training/scripts/train_joint.py --model flat --output-dir training/runs/joint-v1/flat
"""
import argparse, copy, json, math, os, random, time
from pathlib import Path
import numpy as np
import torch
from joint_data import load_corpus, build_windows, collate, STREAMS
from joint_model import StructuredJoint, FlatJoint, loss_and_metrics, count_parameters, WEIGHTS

ROOT = Path(__file__).resolve().parents[1]


def evaluate(model, windows, batch=32):
    model.eval(); sums = {s: 0.0 for s in STREAMS}; counts = {s: 0 for s in STREAMS}
    with torch.no_grad():
        for i in range(0, len(windows), batch):
            _, m = loss_and_metrics(model, collate(windows[i:i + batch]))
            for s, (ce, n) in m.items():
                sums[s] += ce * n; counts[s] += n
    model.train()
    ce = {s: sums[s] / counts[s] for s in STREAMS if counts[s]}
    ce['weighted'] = sum(WEIGHTS[s] * ce[s] for s in ce)
    return {k: round(v, 5) for k, v in ce.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', choices=['structured', 'flat'], default='structured')
    ap.add_argument('--d', type=int, default=96); ap.add_argument('--heads', type=int, default=6)
    ap.add_argument('--layers', type=int, default=4); ap.add_argument('--ff', type=int, default=256)
    ap.add_argument('--dropout', type=float, default=0.1)
    ap.add_argument('--flat-controls', choices=['full', 'basic'], default='full')
    ap.add_argument('--pretrain-steps', type=int, default=800); ap.add_argument('--finetune-steps', type=int, default=2400)
    ap.add_argument('--batch', type=int, default=16); ap.add_argument('--lr', type=float, default=1.5e-3)
    ap.add_argument('--weight-decay', type=float, default=0.03); ap.add_argument('--warmup', type=int, default=200)
    ap.add_argument('--replay', type=float, default=0.15, help='synthetic fraction during fine-tuning')
    ap.add_argument('--eval-every', type=int, default=200); ap.add_argument('--eval-windows', type=int, default=480)
    ap.add_argument('--seed', type=int, default=930227); ap.add_argument('--threads', type=int, default=2)
    ap.add_argument('--lieder', type=Path, default=ROOT / 'data/joint/lieder-joint.npz')
    ap.add_argument('--synthetic', type=Path, default=ROOT / 'data/joint/synthetic-joint.npz')
    ap.add_argument('--output-dir', type=Path, required=True)
    ap.add_argument('--resume', action='store_true',
                    help='continue from <output-dir>/state.pt (saved at every evaluation) if it exists')
    a = ap.parse_args()
    torch.manual_seed(a.seed); random.seed(a.seed); np.random.seed(a.seed); torch.set_num_threads(a.threads)
    t_load = time.time()
    lieder, syn = load_corpus(a.lieder), load_corpus(a.synthetic)
    W = {'lieder_train': build_windows(lieder, 'train'), 'lieder_val': build_windows(lieder, 'validation'),
         'syn_train': build_windows(syn, 'train'), 'syn_val': build_windows(syn, 'validation')}
    rng = random.Random(a.seed + 1)
    val_l = rng.sample(W['lieder_val'], min(a.eval_windows, len(W['lieder_val'])))
    val_s = rng.sample(W['syn_val'], min(a.eval_windows // 3, len(W['syn_val'])))
    print(json.dumps({k: len(v) for k, v in W.items()} | {'loadSeconds': round(time.time() - t_load, 1)}), flush=True)

    Model = StructuredJoint if a.model == 'structured' else FlatJoint
    extra = {'controls': a.flat_controls} if a.model == 'flat' else {}
    model = Model(d=a.d, heads=a.heads, layers=a.layers, ff=a.ff, dropout=a.dropout, **extra)
    params = count_parameters(model)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=a.weight_decay, betas=(0.9, 0.98))
    total = a.pretrain_steps + a.finetune_steps
    def lr_at(step):
        if step < a.warmup:
            return a.lr * (step + 1) / a.warmup
        p = (step - a.warmup) / max(1, total - a.warmup)
        return a.lr * (0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * p)))

    curve, best, best_state, best_step = [], float('inf'), None, None
    train_seconds, recent, start, resumed = 0.0, [], 1, []
    state_path = a.output_dir / 'state.pt'
    if a.resume and state_path.exists():
        st = torch.load(state_path, map_location='cpu', weights_only=False)
        model.load_state_dict(st['model']); opt.load_state_dict(st['opt'])
        rng.setstate(st['rng']); random.setstate(st['random']); np.random.set_state(st['numpy']); torch.set_rng_state(st['torch'])
        curve, best, best_step, best_state = st['curve'], st['best'], st['best_step'], st['best_state']
        train_seconds, recent, resumed = st['train_seconds'], st['recent'], st['resumed'] + [st['step']]
        start = st['step'] + 1
        print(json.dumps({'resumedFrom': st['step']}), flush=True)
    else:
        initial = {'lieder': evaluate(model, val_l), 'synthetic': evaluate(model, val_s)}
        curve.append({'step': 0, 'trainSeconds': 0.0, 'phase': 'init', 'lieder': initial['lieder'], 'synthetic': initial['synthetic']})
        print(json.dumps({'model': a.model, 'parameters': params, 'initial': initial}), flush=True)
    model.train()
    for step in range(start, total + 1):
        phase = 'pretrain' if step <= a.pretrain_steps else 'finetune'
        if phase == 'pretrain':
            rows = rng.sample(W['syn_train'], a.batch)
        else:
            n_syn = sum(rng.random() < a.replay for _ in range(a.batch))
            rows = rng.sample(W['syn_train'], n_syn) + rng.sample(W['lieder_train'], a.batch - n_syn)
        for g in opt.param_groups:
            g['lr'] = lr_at(step - 1)
        t0 = time.time()
        loss, _ = loss_and_metrics(model, collate(rows))
        opt.zero_grad(set_to_none=True); loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step()
        train_seconds += time.time() - t0
        recent.append(float(loss.detach())); recent = recent[-50:]
        if step % a.eval_every == 0 or step == total:
            ev = {'lieder': evaluate(model, val_l), 'synthetic': evaluate(model, val_s)}
            row = {'step': step, 'trainSeconds': round(train_seconds, 1), 'phase': phase, 'lr': round(lr_at(step - 1), 6),
                   'trainLoss': round(float(np.mean(recent)), 4), **ev}
            curve.append(row); print(json.dumps(row), flush=True)
            if phase == 'finetune' and ev['lieder']['weighted'] < best:
                best, best_step, best_state = ev['lieder']['weighted'], step, copy.deepcopy(model.state_dict())
                # keep the best checkpoint and the curve on disk, so an interrupted run stays usable
                a.output_dir.mkdir(parents=True, exist_ok=True)
                torch.save({'config': model.config, 'state_dict': best_state}, a.output_dir / 'model.pt')
                (a.output_dir / 'training.json').write_text(json.dumps({'model': a.model, 'config': model.config, 'parameters': params,
                    'partial': True, 'selectedStep': best_step, 'trainSeconds': round(train_seconds, 1), 'curve': curve}, indent=1))
            # full training state, so a restarted machine can continue exactly here (--resume)
            a.output_dir.mkdir(parents=True, exist_ok=True)
            torch.save({'step': step, 'model': model.state_dict(), 'opt': opt.state_dict(), 'rng': rng.getstate(),
                        'random': random.getstate(), 'numpy': np.random.get_state(), 'torch': torch.get_rng_state(),
                        'curve': curve, 'best': best, 'best_step': best_step, 'best_state': best_state,
                        'train_seconds': train_seconds, 'recent': recent, 'resumed': resumed}, state_path.with_suffix('.tmp'))
            os.replace(state_path.with_suffix('.tmp'), state_path)
    if best_state is None:
        best_state, best_step = copy.deepcopy(model.state_dict()), total
    model.load_state_dict(best_state)
    final = {'lieder_validation_full': evaluate(model, W['lieder_val']), 'synthetic_validation_full': evaluate(model, W['syn_val'])}
    a.output_dir.mkdir(parents=True, exist_ok=True)
    torch.save({'config': model.config, 'state_dict': best_state}, a.output_dir / 'model.pt')
    meta = {'model': a.model, 'config': model.config, 'parameters': params, 'args': {k: str(v) for k, v in vars(a).items()},
            'windows': {k: len(v) for k, v in W.items()}, 'selectedStep': best_step, 'trainSeconds': round(train_seconds, 1),
            'secondsPerStep': round(train_seconds / total, 4), 'curve': curve, 'final': final, 'resumedAfterSteps': resumed,
            'order': 'per sixteenth step R -> H -> B -> M; no stream generated ahead',
            'data': 'synthetic pretraining (AIlegro rule system) + OpenScore Lieder (CC0) with AugmentedNet harmony; Lieder test split untouched'}
    (a.output_dir / 'training.json').write_text(json.dumps(meta, indent=1))
    if state_path.exists():
        state_path.unlink()
    print(json.dumps({'done': True, 'selectedStep': best_step, 'final': final, 'secondsPerStep': meta['secondsPerStep']}), flush=True)


if __name__ == '__main__':
    main()
