#!/usr/bin/env python3
"""Hardware and speed check for training the orchestral model on this machine.

Records chip, memory, cores, GPU cores, free disk, PyTorch/MPS status, matrix-multiply
speed and the time of one training step for a few model sizes (random data), and writes
everything to the given JSON file.

  python training/orchestra/hwcheck.py work/hardware.json
"""
import json, platform, shutil, subprocess, sys, time
from pathlib import Path
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import groups as G
from model import OrchestraTransformer, count_parameters

SIZES = {  # name: model config, (batch, max_len)
    'small': (dict(d=256, heads=4, layers=4, ff=1024), (16, 1024)),
    'medium': (dict(d=384, heads=6, layers=8, ff=1536), (4, 1024)),
    'large': (dict(d=512, heads=8, layers=10, ff=2048), (1, 1024)),
}


def sh(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        return ''


def machine(work):
    info = {'platform': platform.platform(), 'python': sys.version.split()[0], 'torch': torch.__version__,
            'mps': bool(torch.backends.mps.is_available()), 'mpsBuilt': bool(torch.backends.mps.is_built())}
    if sys.platform == 'darwin':
        info.update(chip=sh(['sysctl', '-n', 'machdep.cpu.brand_string']), macos=sh(['sw_vers', '-productVersion']),
                    memoryGB=round(int(sh(['sysctl', '-n', 'hw.memsize']) or 0) / 2**30, 1),
                    performanceCores=sh(['sysctl', '-n', 'hw.perflevel0.physicalcpu']),
                    efficiencyCores=sh(['sysctl', '-n', 'hw.perflevel1.physicalcpu']))
        try:
            disp = json.loads(sh(['system_profiler', 'SPDisplaysDataType', '-json']) or '{}')
            info['gpuCores'] = [d.get('sppci_cores') for d in disp.get('SPDisplaysDataType', [])]
        except Exception:
            pass
    du = shutil.disk_usage(work)
    info['freeDiskGB'] = round(du.free / 2**30, 1)
    return info


def matmul_tflops(dev, dtype, n=1024, reps=3):
    a = torch.randn(n, n, device=dev, dtype=dtype); b = torch.randn(n, n, device=dev, dtype=dtype)
    for _ in range(1):
        a @ b
    sync(dev); t = time.perf_counter()
    for _ in range(reps):
        a @ b
    sync(dev)
    return round(2 * n ** 3 * reps / (time.perf_counter() - t) / 1e12, 2)


def sync(dev):
    if dev.type == 'mps':
        torch.mps.synchronize()
    elif dev.type == 'cuda':
        torch.cuda.synchronize()


def random_batch(batch, L, dev):
    g = torch.Generator().manual_seed(0)
    r = lambda n: torch.randint(0, n, (batch, L), generator=g)
    b = {'type': torch.where(torch.rand(batch, L, generator=g) < 0.05, G.BAR, G.NOTE), 'meter': r(G.N_METER), 'tempo': r(G.N_TEMPO),
         'prog': r(G.N_PROG), 'mask': r(64), 'pos': r(G.MAX_BAR), 'group': r(G.N_GROUPS), 'pitchf': r(G.N_PITCHF),
         'pabs': r(128), 'dur': r(G.N_DUR), 'vel': r(G.N_VEL), 'pi': r(88) + 21, 'next_prog': r(G.N_PROG)}
    b['t'] = torch.cumsum(torch.rand(batch, L, generator=g) * 0.5, 1)
    return {k: v.to(dev) for k, v in b.items()}


def step_time(cfg, batch, L, dev, reps=2):
    model = OrchestraTransformer(**cfg).to(dev).train()
    opt = torch.optim.AdamW(model.parameters(), lr=1e-4)
    b = random_batch(batch, L, dev)
    for i in range(1 + reps):
        if i == 1:
            sync(dev); t = time.perf_counter()
        loss, _ = model.loss(b)
        opt.zero_grad(); loss.backward(); opt.step()
    sync(dev)
    sec = (time.perf_counter() - t) / reps
    return {'parameters': count_parameters(model), 'batch': batch, 'maxLen': L, 'secondsPerStep': round(sec, 3),
            'tokensPerSecond': round(batch * L / sec)}


def main():
    out = Path(sys.argv[1]); out.parent.mkdir(parents=True, exist_ok=True)
    res = {'machine': machine(out.parent), 'time': time.strftime('%Y-%m-%d %H:%M:%S')}
    print(json.dumps(res['machine'], ensure_ascii=False), flush=True)
    devs = [torch.device('mps')] if res['machine']['mps'] else []
    devs.append(torch.device('cpu'))
    res['matmulTFLOPS'] = {}
    for dev in devs:
        # Float16 matrix multiplication on CPU can be emulated and take minutes.
        for dt in ((torch.float32, torch.float16) if dev.type != 'cpu' else (torch.float32,)):
            try:
                res['matmulTFLOPS'][f'{dev.type}-{str(dt).split(".")[1]}'] = matmul_tflops(dev, dt)
            except Exception as e:
                res['matmulTFLOPS'][f'{dev.type}-{str(dt).split(".")[1]}'] = f'failed: {type(e).__name__}'
    print(json.dumps({'matmulTFLOPS': res['matmulTFLOPS']}), flush=True)
    res['training'] = {}
    for dev in devs:
        for name, (cfg, (batch, L)) in SIZES.items():
            if dev.type == 'cpu' and name != 'small':
                continue
            if dev.type == 'cpu':
                batch, L = 2, 256
            try:
                r = step_time(cfg, batch, L, dev)
            except Exception as e:
                r = {'failed': f'{type(e).__name__}: {str(e)[:200]}'}
            res['training'][f'{dev.type}-{name}'] = r
            print(json.dumps({f'{dev.type}-{name}': r}), flush=True)
            out.write_text(json.dumps(res, indent=1, ensure_ascii=False))
            if dev.type == 'mps':
                torch.mps.empty_cache()
    out.write_text(json.dumps(res, indent=1, ensure_ascii=False))
    print(f'written {out}')


if __name__ == '__main__':
    main()
