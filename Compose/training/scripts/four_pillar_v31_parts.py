#!/usr/bin/env python3
"""Four-pillar v3.1 in two parts: the bar planner and the event composer.

A v3.1 checkpoint is one FourPillarV31. This module splits its parameters without changing any of them:

  PlannerPart   completed-bar summaries (78 values per bar) -> one plan vector per bar (width 192), the next
                bar's key change, pitch classes, groups, density and register, and the reference pointer over
                earlier bars. 1,386,440 parameters in the trained configuration.
  ComposerPart  committed events + bar condition (plan + controls) + reference bar -> the next event's
                attributes in the trained order (kind, onset, chord root/quality | group, voice, pitch,
                duration, expression). 3,628,527 parameters.

The parts meet only through the plan vector (planner -> composer) and the bar summaries (composer ->
planner). `modulation_in` is used by both sides (bar condition, planner bar outputs) and is copied into both.

  assemble(planner, composer)  one FourPillarV31 with exactly the original tensors, so the v3.1 Composer
                               (four_pillar_v31_sample) runs unchanged and bit-identically.
  planner_free(composer)       the composer alone: every bar gets the trained "no completed bar" plan, the
                               pointer never restates a bar by itself (a named reference still works) and
                               keys must be given ('keep' or a key, never None).
  PlannerPart                  the planner alone, from bar summaries (`summary_of_bar` builds one).
  save_parts / load_parts      two files that can be trained or replaced separately.
  planner_frozen(model)        training helper: the planner runs without gradients (the composer then trains
                               alone; the planner's input does not depend on the transposition).

Measured on the step-45,225 weights (2026-10-02, training windows): without the planner the six note
attributes lose 3.9% (chord roots 24%); without the reference bar 14%. Nothing here changes the v3.1 training
code, its hashed files or the checkpoint.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
from fractions import Fraction
from pathlib import Path

import torch
from torch import nn

from four_pillar_v31_model import FourPillarV31

PART_SCHEMA = 'four-pillar-v31-part-1'
PLANNER_MODULES = ('summary_input', 'planner', 'plan_empty', 'plan_norm', 'bar_key', 'bar_pcs', 'bar_groups',
                   'bar_density', 'bar_register', 'ref_query', 'ref_key', 'ref_none', 'ref_distance')
SHARED_MODULES = ('modulation_in',)


def _owner(name: str) -> str:
    return name.split('.', 1)[0]


def split_state(state: dict) -> tuple[dict, dict]:
    """(planner entries, composer entries) of a FourPillarV31 state dict; shared entries go to both."""
    planner = {k: v for k, v in state.items() if _owner(k) in PLANNER_MODULES + SHARED_MODULES}
    composer = {k: v for k, v in state.items() if _owner(k) not in PLANNER_MODULES}
    return planner, composer


class _Part(nn.Module):
    """Holds a subset of FourPillarV31's modules under their original names (built by FourPillarV31 itself, so
    shapes and initialization never diverge from the model code)."""

    def __init__(self, config: dict, names):
        super().__init__()
        full = FourPillarV31(config)
        self.config = full.config
        for name in names:
            setattr(self, name, getattr(full, name))

    def save(self, path: Path, source: dict) -> None:
        torch.save({'schema': PART_SCHEMA, 'part': type(self).__name__, 'architecture': self.config,
                    'source': source, 'state': self.state_dict()}, path)


class PlannerPart(_Part):
    """The bar planner, its bar-level heads and the reference pointer; methods are FourPillarV31's own."""

    def __init__(self, config: dict):
        super().__init__(config, PLANNER_MODULES + SHARED_MODULES)

    plan_bars = FourPillarV31.plan_bars
    new_planner_cache = FourPillarV31.new_planner_cache
    planner_step = FourPillarV31.planner_step
    gather_plans = FourPillarV31.gather_plans
    key_logits = FourPillarV31.key_logits
    bar_outputs = FourPillarV31.bar_outputs
    ref_logits = FourPillarV31.ref_logits

    def empty_plan(self) -> torch.Tensor:
        """The plan of a bar with no completed bar before it [width]."""
        return self.plan_norm(self.plan_empty)


class ComposerPart(_Part):
    """Event inputs, backbone, bar controls, reference reader and attribute decoder, plus the empty plan as a
    buffer so it can run without a planner."""

    def __init__(self, config: dict):
        names = [n for n in FourPillarV31(config).state_dict() if _owner(n) not in PLANNER_MODULES]
        super().__init__(config, dict.fromkeys(_owner(n) for n in names))
        self.register_buffer('empty_plan', torch.zeros(self.config['width']))


def split(model: FourPillarV31) -> tuple[PlannerPart, ComposerPart]:
    """Copy a model's tensors into the two parts (the model itself is not changed)."""
    planner_state, composer_state = split_state(model.state_dict())
    planner, composer = PlannerPart(model.config), ComposerPart(model.config)
    planner.load_state_dict(planner_state, strict=True)
    with torch.no_grad():
        composer_state = dict(composer_state, empty_plan=model.plan_norm(model.plan_empty).detach().clone())
    composer.load_state_dict(composer_state, strict=True)
    return planner.eval(), composer.eval()


def assemble(planner: PlannerPart, composer: ComposerPart) -> FourPillarV31:
    """One FourPillarV31 from the two parts; the shared `modulation_in` must agree."""
    if planner.config != composer.config:
        raise ValueError('the parts come from different architectures')
    p, c = planner.state_dict(), composer.state_dict()
    for name in p:
        if name in c and not torch.equal(p[name], c[name]):
            raise ValueError(f'shared tensor {name} differs between the parts')
    model = FourPillarV31(planner.config)
    state = {**{k: v for k, v in c.items() if k != 'empty_plan'}, **p}
    model.load_state_dict(state, strict=True)
    return model.eval()


class PlannerFree(FourPillarV31):
    """FourPillarV31 that runs on the composer part alone (planner modules stay unused).

    Every bar is conditioned on the trained empty plan; the pointer prefers 'no reference' (column 0), so
    reference='auto' restates nothing and a named reference bar still works; the key head is unavailable."""

    def __init__(self, composer: ComposerPart):
        super().__init__(composer.config)
        state = {k: v for k, v in composer.state_dict().items() if k != 'empty_plan'}
        missing, unexpected = self.load_state_dict(state, strict=False)
        if unexpected or any(_owner(k) not in PLANNER_MODULES for k in missing):
            raise ValueError('composer part does not match the v3.1 architecture')
        self.plan_norm = nn.Identity()
        self.plan_empty = nn.Parameter(composer.empty_plan.detach().clone(), requires_grad=False)
        self.eval()

    def new_planner_cache(self) -> list:
        return []

    def planner_step(self, summary, bar_index, cache):
        return self.plan_empty[None, None]

    def ref_logits(self, query, keys, distance):
        scores = torch.full((*query.shape[:-1], 1 + keys.shape[-2]), torch.finfo(query.dtype).min)
        scores[..., 0] = 0.
        return scores

    def key_logits(self, plan):
        raise ValueError('the composer alone has no key head: give each bar a key (or keep the previous one)')


def planner_free(composer: ComposerPart) -> PlannerFree:
    return PlannerFree(composer)


@contextlib.contextmanager
def planner_frozen(model: FourPillarV31):
    """Within the block, model.plan_bars runs without gradients (train the composer side alone)."""
    original = model.plan_bars

    def frozen(history):
        with torch.no_grad():
            return original(history)

    model.plan_bars = frozen
    try:
        yield model
    finally:
        del model.plan_bars       # back to the class method


def summary_of_bar(notes: list[dict], *, key: int, previous_key: int | None, length: Fraction,
                   index: int) -> list[float]:
    """The planner input for one completed bar, exactly as the composer computes it: `notes` as returned by
    Composer.next_bar (onset/pitch/group fields), key ids as in four_pillar_v31_tonal (tonic + 12 * mode)."""
    from four_pillar_v31_data import bar_profile, bar_vector
    from four_pillar_v31_sample import bar_summary
    placed = [(Fraction(n['onset']), n['pitch']) for n in notes]
    return bar_vector(bar_summary(notes), key, previous_key, bar_profile(placed, Fraction(length), key % 12), index)


def _sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save_parts(model: FourPillarV31, directory: Path, source: dict | None = None) -> dict:
    """Write planner.pt and composer.pt (refuses to overwrite)."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    paths = {'planner': directory / 'planner.pt', 'composer': directory / 'composer.pt'}
    for path in paths.values():
        if path.exists():
            raise FileExistsError(path)
    planner, composer = split(model)
    planner.save(paths['planner'], source or {})
    composer.save(paths['composer'], source or {})
    return {name: {'path': str(path), 'sha256': _sha256(path),
                   'parameters': sum(p.numel() for p in part.parameters())}
            for (name, path), part in zip(paths.items(), (planner, composer))}


def load_part(path: Path):
    data = torch.load(path, map_location='cpu', weights_only=False)
    if data.get('schema') != PART_SCHEMA:
        raise ValueError(f'{path} is not a v3.1 part file')
    part = {'PlannerPart': PlannerPart, 'ComposerPart': ComposerPart}[data['part']](data['architecture'])
    part.load_state_dict(data['state'], strict=True)
    return part.eval()


def load_parts(path: Path) -> tuple[PlannerPart, ComposerPart]:
    """From a directory holding planner.pt + composer.pt, or by splitting a v3.1 weights.pt."""
    path = Path(path)
    if path.is_dir():
        return load_part(path / 'planner.pt'), load_part(path / 'composer.pt')
    from four_pillar_v31_sample import load
    model, _, _ = load(path)
    return split(model)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--checkpoint', type=Path, required=True, help='v3.1 weights.pt')
    parser.add_argument('--export', type=Path, help='write planner.pt and composer.pt into this new directory')
    parser.add_argument('--bars', type=int, default=4, help='bars generated by the round-trip check')
    args = parser.parse_args()
    from four_pillar_v31_sample import Composer, load
    model, vocab, weights = load(args.checkpoint)
    planner, composer = split(model)
    rebuilt = assemble(planner, composer)
    same = all(torch.equal(a, b) for a, b in zip(model.state_dict().values(), rebuilt.state_dict().values()))
    composers = [Composer(m, vocab, seed=11, key=(0, 0)) for m in (model, rebuilt)]

    def music(bar):   # everything but the wall-clock timing
        return {k: v for k, v in bar.items() if k != 'timing'}

    identical = all(music(composers[0].next_bar(reference='auto')) == music(composers[1].next_bar(reference='auto'))
                    for _ in range(args.bars))
    alone = Composer(planner_free(composer), vocab, seed=11, key=(0, 0))
    notes_alone = sum(len(alone.next_bar()['notes']) for _ in range(args.bars))
    report = {'step': weights['step'], 'parameters': {
        'planner': sum(p.numel() for p in planner.parameters()),
        'composer': sum(p.numel() for p in composer.parameters()),
        'shared': sum(p.numel() for n, p in planner.named_parameters() if _owner(n) in SHARED_MODULES)},
        'assembledTensorsIdentical': same, 'assembledGenerationIdentical': identical,
        'composerAloneNotes': notes_alone}
    if args.export:
        report['export'] = save_parts(model, args.export, {'checkpoint': str(args.checkpoint),
                                                           'sha256': _sha256(args.checkpoint),
                                                           'step': weights['step']})
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
