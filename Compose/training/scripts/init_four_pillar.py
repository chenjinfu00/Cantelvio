#!/usr/bin/env python3
"""Create an isolated four-pillar *initialization* checkpoint from deployed weights.

No optimization, model export, or browser replacement occurs here. The structural
R/H/B/M backbone is copied exactly; only shape/meaning-compatible auxiliary
weights are transplanted. New form, voice, tempo and condition modules remain
untrained and are gated off from the old decoder initially.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile

import torch

from four_pillar_model import FourPillarFoundation, GROUPS

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'runs/joint-continued-expression-v1/best-base.pt'
EXPRESSION = ROOT / 'runs/joint-continued-expression-v1/best.pt'
ARRANGEMENT = ROOT / 'runs/joint-continued-arrangement-v1/best.pt'
OUTPUT = ROOT / 'runs/four-pillar-bootstrap-v0/init.pt'


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def build_initial_model(base_path: Path = BASE, expression_path: Path = EXPRESSION,
                        arrangement_path: Path = ARRANGEMENT, seed: int = 29):
    base = torch.load(base_path, map_location='cpu', weights_only=True)
    expression = torch.load(expression_path, map_location='cpu', weights_only=True)
    arrangement = torch.load(arrangement_path, map_location='cpu', weights_only=True)
    config = base.get('config')
    if not isinstance(config, dict) or config.get('kind') != 'structured' or 'state_dict' not in base:
        raise ValueError('source must be the continued StructuredJoint backbone')
    if expression.get('baseHash') != base.get('sourceHash') or expression.get('step') != base.get('step'):
        raise ValueError('expression head does not belong to this exact continued backbone')
    base_sha = sha256(base_path)
    if arrangement.get('source', {}).get('jointInitializationHash') != base_sha:
        raise ValueError('six-group checkpoint was not initialized from this backbone file')
    sizes = {key: len(expression['vocab'][key]) for key in ('sub', 'dur', 'ratio', 'dynamic')}

    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(seed)
        model = FourPillarFoundation(base_config=config, expression_sizes=sizes)
    model.base.load_state_dict(base['state_dict'], strict=True)
    transferred = ['base.*']
    with torch.no_grad():
        for stream, token in (('harmony', 'H'), ('melody', 'M')):
            source = base['state_dict'][f'tok.{1 if token == "H" else 3}.weight']
            getattr(model.material, stream).weight.copy_(source)
            transferred.append(f'material.{stream}.weight')
        for name in ('sub', 'dur', 'ratio', 'dynamic'):
            target = model.voice_heads[name]
            for part in ('weight', 'bias'):
                value = expression['sidecar'][f'field_head.{name}.{part}']
                getattr(target, part).copy_(value)
                transferred.append(f'voice_heads.{name}.{part}')
        group = arrangement['model']
        for part in ('weight', 'bias'):
            value = group[f'group.{part}']
            if value.shape[0] != len(GROUPS):
                raise ValueError('arrangement group ordering/size changed')
            getattr(model.group_head, part)[:len(GROUPS)].copy_(value)
            transferred.append(f'group_head.{part}[:6]')
    if not all(torch.equal(value, model.base.state_dict()[key]) for key, value in base['state_dict'].items()):
        raise AssertionError('backbone transfer was not exact')
    if model.material_gate.item() != 0 or model.plan_gate.item() != 0:
        raise AssertionError('new conditions must initially be gated off')

    checkpoint = {
        'schema': 'four-pillar-bootstrap-v0',
        'base_config': config,
        'expression_sizes': sizes,
        'state_dict': model.state_dict(),
        'seed': seed,
        'source': {
            'base': {'path': str(base_path.relative_to(ROOT)), 'sha256': base_sha, 'step': base['step']},
            'expression': {'path': str(expression_path.relative_to(ROOT)), 'sha256': sha256(expression_path)},
            'arrangement': {'path': str(arrangement_path.relative_to(ROOT)), 'sha256': sha256(arrangement_path)},
        },
        'transferred': transferred,
        'trained_new_modules': False,
        'browser_compatible': False,
    }
    return model, checkpoint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--seed', type=int, default=29)
    args = parser.parse_args()
    target = args.output.resolve()
    if target.exists():
        parser.error(f'refusing to overwrite existing checkpoint: {target}')
    model, checkpoint = build_initial_model(seed=args.seed)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix='.four-pillar-', suffix='.pt', dir=target.parent,
                                     delete=False) as stream:
        temporary = Path(stream.name)
    try:
        torch.save(checkpoint, temporary)
        # An exclusive hard link publishes the complete file without replacing
        # another run's checkpoint; the temporary name is then removed.
        os.link(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    reread = torch.load(target, map_location='cpu', weights_only=True)
    restored = FourPillarFoundation(base_config=reread['base_config'],
                                    expression_sizes=reread['expression_sizes'])
    restored.load_state_dict(reread['state_dict'], strict=True)
    count = sum(p.numel() for p in model.parameters())
    print(json.dumps({'checkpoint': str(target), 'parameters': count,
                      'base_parameters': sum(p.numel() for p in model.base.parameters()),
                      'source_step': checkpoint['source']['base']['step'],
                      'trained_new_modules': False, 'browser_compatible': False}, indent=2))


if __name__ == '__main__':
    main()
