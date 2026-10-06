#!/usr/bin/env python3
"""Seconds per training step for each joint-v1 model, measured one after another on an idle machine.

The logged secondsPerStep of a run depends on whatever else ran at the same time;
this benchmark times the same batch size and threads for every model in isolation.
Writes <run>/benchmark.json ({model: median seconds per step}).

  python training/scripts/benchmark_joint.py training/runs/joint-v1
"""
import argparse, json, random, statistics, time
from pathlib import Path
import torch
from joint_data import load_corpus, build_windows, collate
from joint_model import StructuredJoint, FlatJoint, loss_and_metrics

ROOT = Path(__file__).resolve().parents[1]
CONFIGS = {
    'structured': (StructuredJoint, {}),
    'flat-compute': (FlatJoint, {'controls': 'full'}),
    'flat-params': (FlatJoint, {'d': 128, 'heads': 8, 'layers': 7, 'ff': 512, 'controls': 'full'}),
    'flat-compute-basic': (FlatJoint, {'controls': 'basic'}),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('run_dir', type=Path)
    ap.add_argument('--steps', type=int, default=30); ap.add_argument('--warmup', type=int, default=5)
    ap.add_argument('--batch', type=int, default=16); ap.add_argument('--threads', type=int, default=2)
    a = ap.parse_args(); torch.set_num_threads(a.threads); torch.manual_seed(0)
    windows = build_windows(load_corpus(ROOT / 'data/joint/lieder-joint.npz'), 'train')
    rng = random.Random(0)
    batches = [collate(rng.sample(windows, a.batch)) for _ in range(a.warmup + a.steps)]
    out = {}
    for name, (Model, kw) in CONFIGS.items():
        cfg = {'d': 96, 'heads': 6, 'layers': 4, 'ff': 256, 'dropout': 0.1} | kw
        model = Model(**cfg); model.train()
        opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.03, betas=(0.9, 0.98))
        times = []
        for i, batch in enumerate(batches):
            t0 = time.perf_counter()
            loss, _ = loss_and_metrics(model, batch)
            opt.zero_grad(set_to_none=True); loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step()
            if i >= a.warmup:
                times.append(time.perf_counter() - t0)
        out[name] = round(statistics.median(times), 4)
        print(json.dumps({name: out[name], 'parameters': sum(p.numel() for p in model.parameters())}), flush=True)
    meta = out | {'_note': f'median seconds per training step, batch {a.batch}, {a.threads} CPU threads, measured one model at a time'}
    (a.run_dir / 'benchmark.json').write_text(json.dumps(meta, indent=1))


if __name__ == '__main__':
    main()
