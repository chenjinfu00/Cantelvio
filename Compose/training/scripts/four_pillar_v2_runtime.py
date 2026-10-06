"""Run locking, durable checkpoints, signal-safe boundaries and exact restore."""
from __future__ import annotations

import fcntl
import os
import signal
from contextlib import contextmanager

import torch


@contextmanager
def exclusive_run(directory):
    # Kernel lock is automatically released even after a crash; no stale-lock
    # deletion or unsafe guessing of process IDs is necessary.
    with (directory / '.writer.lock').open('a+') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('another process already owns this training run') from None
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


class StopAtBoundary:
    def __enter__(self):
        self.requested = False
        self.previous = {}
        def request(signum, frame):
            self.requested = True
        for signum in (signal.SIGINT, signal.SIGTERM):
            self.previous[signum] = signal.signal(signum, request)
        return self

    def __exit__(self, *args):
        for signum, handler in self.previous.items():
            signal.signal(signum, handler)


def save_checkpoint(value, path):
    temporary = path.with_suffix('.tmp')
    with temporary.open('wb') as stream:
        torch.save(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def pack_state(model, optimizer, rng, cycler, *, step, elapsed, manifest_hash,
               counts=None):
    return {'schema':'four-pillar-v2-state-2', 'step':step,
            'model':model.state_dict(), 'optimizer':optimizer.state_dict(),
            'pythonRng':rng.getstate(), 'torchRng':torch.get_rng_state(),
            'sourceCycler':cycler.state_dict(), 'elapsedSeconds':elapsed,
            'manifestSha256':manifest_hash, 'counts':counts or {}}


def restore_state(state, model, optimizer, rng, cycler, manifest_hash):
    if (state.get('schema') != 'four-pillar-v2-state-2'
            or state['manifestSha256'] != manifest_hash):
        raise ValueError('checkpoint schema or manifest mismatch')
    model.load_state_dict(state['model'], strict=True)
    optimizer.load_state_dict(state['optimizer'])
    rng.setstate(state['pythonRng'])
    torch.set_rng_state(state['torchRng'])
    cycler.load_state_dict(state['sourceCycler'])
    return int(state['step']), float(state['elapsedSeconds']), state['counts']


def initialize_from_checkpoint(model, path):
    """Explicit weights-only new run; exact architecture compatibility required."""
    state = torch.load(path, map_location='cpu', weights_only=False)
    if state.get('schema') != 'four-pillar-v2-state-2':
        raise ValueError('initial checkpoint is not a revised v2 state')
    model.load_state_dict(state['model'], strict=True)
    return {'parentStep':int(state['step']), 'optimizerReset':True,
            'samplingStateReset':True, 'strictArchitectureMatch':True}


def model_from_checkpoint(path, *, config):
    """Construct and strictly load a full v2 checkpoint without old weights."""
    import json
    from pathlib import Path
    from four_pillar_midi_data import sha256
    from four_pillar_v2_model import FourPillarExpressiveV2
    path = Path(path)
    manifest_path = path.with_name('manifest.json')
    manifest = json.loads(manifest_path.read_text())
    state = torch.load(path, map_location='cpu', weights_only=False)
    if (manifest.get('schema') != 'four-pillar-v2-complete-training-paths-2'
            or state.get('schema') != 'four-pillar-v2-state-2'
            or state.get('manifestSha256') != sha256(manifest_path)):
        raise ValueError('checkpoint and manifest mismatch')
    if manifest['runConfig']['architecture'] != config:
        raise ValueError('checkpoint architecture mismatch')
    transfer = manifest['oldModelTransfer']
    if transfer['sourceConfig'].get('kind') != 'structured':
        raise ValueError('unsupported frozen prior architecture')
    model = FourPillarExpressiveV2(**config, legacy_transfer=transfer)
    model.load_state_dict(state['model'], strict=True)
    model.parent_initialization = {'parentStep': int(state['step']),
        'optimizerReset': True, 'samplingStateReset': True,
        'strictArchitectureMatch': True}
    return model
