#!/usr/bin/env python3
"""Train the Cantelvio Compose orchestral model. Resumes automatically from <run>/state.pt.

  python training/orchestra/train.py configs/ablation-rotary-aug.json --data <prepared data> --runs <folder>

Writes <runs>/<name>/:
  log.jsonl    one JSON line per log/eval step (losses per field, tokens per second, learning rate)
  state.pt     full training state (model, optimizer, step, random state), replaced atomically
  best.pt      weights with the lowest validation loss so far; model.pt at the end
  config.json  the resolved configuration
Create a file named STOP in the run folder to stop cleanly after the next step
(state is saved; running the same command again continues).
"""
import argparse, json, math, os, random, sys, time
from pathlib import Path
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import groups as G
from data import Corpus, collate
from model import OrchestraTransformer, count_parameters

DEFAULTS = {
    'model': {'d': 256, 'heads': 4, 'layers': 6, 'ff': 1024, 'dropout': 0.1, 'pitch': 'rotary', 'register': True, 'value_rotary': True},
    'train': {'max_len': 1024, 'batch': 16, 'lr': 1e-3, 'min_lr': 5e-5, 'warmup': 500, 'steps': 20000, 'weight_decay': 0.05,
              'grad_clip': 1.0, 'transpose': [-6, 5], 'eval_every': 500, 'eval_windows': 192, 'save_every': 250,
              'log_every': 50, 'seed': 20260928, 'workers': 2},
}


def resolve(cfg_path, overrides):
    cfg = json.loads(Path(cfg_path).read_text()) if cfg_path else {}
    out = {k: dict(v) for k, v in DEFAULTS.items()}
    for k in ('model', 'train'):
        out[k].update(cfg.get(k, {}))
    out['name'] = cfg.get('name', Path(cfg_path).stem if cfg_path else 'run')
    for o in overrides:   # section.key=value
        key, val = o.split('=', 1); sec, name = key.split('.')
        out[sec][name] = json.loads(val)
    return out


class Windows(torch.utils.data.IterableDataset):
    """Endless random training windows; each worker opens the corpus itself (memmaps are not pickled)."""

    def __init__(self, data_dir, max_len, transpose, seed):
        self.data_dir, self.max_len, self.transpose, self.seed = data_dir, max_len, transpose, seed

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        rng = np.random.default_rng([self.seed, info.id if info else 0])
        corpus = Corpus(self.data_dir, 'train')
        while True:
            yield corpus.window(rng, self.max_len, transpose=tuple(self.transpose) if self.transpose else None)


def pick_device(name):
    if name != 'auto':
        return torch.device(name)
    if torch.backends.mps.is_available():
        return torch.device('mps')
    return torch.device('cuda' if torch.cuda.is_available() else 'cpu')


def to(b, dev):
    return {k: (v.to(dev) if torch.is_tensor(v) else v) for k, v in b.items()}


def eval_sets(data_dir, n, max_len, seed):
    """Fixed validation windows: as they are, and every window transposed by +5 and by -4."""
    c = Corpus(data_dir, 'validation')
    if not len(c):
        return {}
    rng = np.random.default_rng(seed)
    specs = [(int(rng.choice(len(c), p=c.weights)), None) for _ in range(n)]
    specs = [(pi, int(rng.integers(c.pieces[pi]['bars']))) for pi, _ in specs]
    out = {}
    for name, shift in (('val', 0), ('val+5', 5), ('val-4', -4)):
        ws = [c.window(rng, max_len, piece=pi, start_bar=b0, shift=shift) for pi, b0 in specs]
        out[name] = [collate(ws[i:i + 16]) for i in range(0, len(ws), 16)]
    return out


@torch.no_grad()
def evaluate(model, sets, dev):
    model.eval()
    res = {}
    for name, batches in sets.items():
        tot, n, fields = 0.0, 0, {}
        for b in batches:
            b = to(b, dev)
            loss, parts = model.loss(b)
            k = int((b['type'][:, 1:] != G.PAD).sum())
            tot += float(loss) * k; n += k
            for f, (v, m) in parts.items():
                s, c = fields.get(f, (0.0, 0)); fields[f] = (s + float(v) * m, c + m)
        res[name] = {'nll': round(tot / max(1, n), 5), **{f: round(s / max(1, c), 5) for f, (s, c) in fields.items()}}
    model.train()
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('config', nargs='?'); ap.add_argument('--data', type=Path, required=True); ap.add_argument('--runs', type=Path, required=True)
    ap.add_argument('--device', default='auto'); ap.add_argument('--set', nargs='*', default=[], help='override, e.g. train.steps=100')
    a = ap.parse_args()
    cfg = resolve(a.config, a.set); tc = cfg['train']
    run = a.runs / cfg['name']; run.mkdir(parents=True, exist_ok=True)
    (run / 'config.json').write_text(json.dumps(cfg, indent=1))
    dev = pick_device(a.device)
    torch.manual_seed(tc['seed']); random.seed(tc['seed']); np.random.seed(tc['seed'] % 2**32)
    model = OrchestraTransformer(**cfg['model']).to(dev)
    is_embedding = lambda n: n.split('.')[0].startswith(('e_', 'c_'))   # input and conditioning embeddings
    decay = [p for n, p in model.named_parameters() if p.dim() >= 2 and not is_embedding(n)]
    other = [p for n, p in model.named_parameters() if not (p.dim() >= 2 and not is_embedding(n))]
    opt = torch.optim.AdamW([{'params': decay, 'weight_decay': tc['weight_decay']}, {'params': other, 'weight_decay': 0.0}],
                            lr=tc['lr'], betas=(0.9, 0.98))
    step, best, log = 0, float('inf'), run / 'log.jsonl'
    state_path = run / 'state.pt'
    if state_path.exists():
        st = torch.load(state_path, map_location='cpu', weights_only=False)
        model.load_state_dict(st['model']); opt.load_state_dict(st['opt'])
        step, best = st['step'], st['best']
        print(json.dumps({'resumedFrom': step}), flush=True)
    else:
        with open(log, 'a') as f:
            f.write(json.dumps({'start': True, 'name': cfg['name'], 'parameters': count_parameters(model), 'device': str(dev),
                                'torch': torch.__version__, 'config': cfg}) + '\n')
    # data order after a resume: a new stream seeded by the step (not the same windows, same distribution)
    loader = torch.utils.data.DataLoader(Windows(a.data, tc['max_len'], tc['transpose'], tc['seed'] + step),
                                         batch_size=tc['batch'], collate_fn=collate, num_workers=tc['workers'],
                                         persistent_workers=tc['workers'] > 0, prefetch_factor=4 if tc['workers'] else None)
    sets = eval_sets(a.data, tc['eval_windows'], tc['max_len'], tc['seed'] + 1)

    def lr_at(s):
        if s < tc['warmup']:
            return tc['lr'] * (s + 1) / tc['warmup']
        p = min(1.0, (s - tc['warmup']) / max(1, tc['steps'] - tc['warmup']))
        return tc['min_lr'] + (tc['lr'] - tc['min_lr']) * 0.5 * (1 + math.cos(math.pi * p))

    def save():
        tmp = run / 'state.tmp'
        torch.save({'model': model.state_dict(), 'opt': opt.state_dict(), 'step': step, 'best': best, 'config': cfg}, tmp)
        os.replace(tmp, state_path)

    model.train()
    t_last, tok_last, ema, tokens = time.time(), 0, None, 0
    it = iter(loader)
    while step < tc['steps']:
        b = to(next(it), dev)
        for g in opt.param_groups:
            g['lr'] = lr_at(step)
        loss, parts = model.loss(b)
        opt.zero_grad(set_to_none=True); loss.backward()
        gn = torch.nn.utils.clip_grad_norm_(model.parameters(), tc['grad_clip'])
        opt.step(); step += 1
        tokens += int((b['type'] != G.PAD).sum())
        lv = loss.item(); ema = lv if ema is None else 0.98 * ema + 0.02 * lv
        row = None
        if step % tc['log_every'] == 0:
            now = time.time()
            row = {'step': step, 'loss': round(ema, 4), 'lr': round(lr_at(step), 7), 'gradNorm': round(float(gn), 3),
                   'tokensPerSec': round((tokens - tok_last) / max(1e-6, now - t_last)), 'time': round(now)}
            t_last, tok_last = now, tokens
        if sets and (step % tc['eval_every'] == 0 or step == tc['steps']):
            row = row or {'step': step, 'loss': round(ema, 4), 'time': round(time.time())}
            row['eval'] = evaluate(model, sets, dev)
            if row['eval']['val']['nll'] < best:
                best = row['eval']['val']['nll']
                torch.save({'config': cfg['model'], 'state_dict': model.state_dict(), 'step': step, 'val': best}, run / 'best.pt')
            row['best'] = best
        if row:
            with open(log, 'a') as f:
                f.write(json.dumps(row) + '\n')
            print(json.dumps(row), flush=True)
        if step % tc['save_every'] == 0 or step == tc['steps']:
            save()
        if (run / 'STOP').exists():
            save(); print(json.dumps({'stopped': step}), flush=True)
            (run / 'STOP').unlink()
            return
    torch.save({'config': cfg['model'], 'state_dict': model.state_dict(), 'step': step}, run / 'model.pt')
    with open(log, 'a') as f:
        f.write(json.dumps({'done': True, 'step': step, 'best': best}) + '\n')
    print(json.dumps({'done': True, 'step': step, 'best': best}), flush=True)


if __name__ == '__main__':
    main()
