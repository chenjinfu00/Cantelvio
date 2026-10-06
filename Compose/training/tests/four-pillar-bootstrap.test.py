#!/usr/bin/env python3
"""Check exact backbone migration and non-leaking future-material input."""
import sys
import unittest
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_model import FourPillarFoundation, GROUPS  # noqa: E402
from init_four_pillar import build_initial_model  # noqa: E402
from joint_data import T_MAX, chord_features_from_H  # noqa: E402
from joint_model import StructuredJoint  # noqa: E402


def sample_batch():
    B, T = 1, T_MAX
    H = torch.full((B, T), 2, dtype=torch.long)
    H[:, 0] = 3
    chord, since, change = chord_features_from_H(H)
    pos = torch.arange(T)[None] % 16
    return {
        'R': torch.full((B, T), 2, dtype=torch.long), 'H': H,
        'B': torch.full((B, T), 2, dtype=torch.long),
        'M': torch.full((B, T), 2, dtype=torch.long),
        'pos': pos, 'meter': torch.full((B, T), 2, dtype=torch.long),
        'level': torch.zeros(B, T, dtype=torch.long),
        'phrase': (torch.arange(T)[None] // 16) % 8,
        'lkey': torch.zeros(B, T, dtype=torch.long),
        'beatphase': pos % 4,
        'barlen': torch.full((B, T), 16, dtype=torch.long),
        'beatlen': torch.full((B, T), 4, dtype=torch.long),
        'chord': chord, 'since': since, 'change': change,
        'domain': torch.ones(B, dtype=torch.long),
        'style': torch.full((B,), 3, dtype=torch.long),
        'refmode': torch.zeros(B, dtype=torch.long),
    }


def supplied_material():
    H = torch.full((1, T_MAX), 999, dtype=torch.long)  # unknown payload must be ignored
    M = torch.full((1, T_MAX), 999, dtype=torch.long)
    known_h = torch.zeros_like(H, dtype=torch.bool)
    known_m = torch.zeros_like(M, dtype=torch.bool)
    known_m[:, 65] = True
    M[:, 65] = 8
    return {'H': H, 'M': M, 'known_H': known_h, 'known_M': known_m}


class BootstrapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        cls.model, cls.checkpoint = build_initial_model()
        cls.model.eval()

    def test_exact_joint_logits_even_with_new_inputs(self):
        batch = sample_batch()
        pretrained = StructuredJoint(**{k: v for k, v in self.checkpoint['base_config'].items() if k != 'kind'})
        pretrained.load_state_dict({k.removeprefix('base.'): v for k, v in self.checkpoint['state_dict'].items()
                                    if k.startswith('base.')}, strict=True)
        pretrained.eval()
        with torch.no_grad():
            expected = pretrained(batch)
            plain = self.model(batch)
            conditioned = self.model(batch, material=supplied_material(),
                                     phrase_context=torch.randn(1, T_MAX, self.model.base.d))
        for stream in ('R', 'H', 'B', 'M'):
            self.assertTrue(torch.equal(expected[stream], plain['joint'][stream]), stream)
            self.assertTrue(torch.equal(expected[stream], conditioned['joint'][stream]), stream)
        self.assertEqual(plain['form'].shape, (1, T_MAX, 4))
        self.assertEqual(plain['voices']['pitch'].shape, (1, T_MAX, 2, 130))
        self.assertEqual(plain['groups'].shape, (1, T_MAX, 2, len(GROUPS) + 1))
        self.assertEqual(plain['tempo'].shape, (1, T_MAX, 3))

    def test_unknown_payload_is_not_visible_but_known_future_is(self):
        material = supplied_material()
        variant = {key: value.clone() for key, value in material.items()}
        variant['H'][~variant['known_H']] = -999
        variant['M'][~variant['known_M']] = -999
        with torch.no_grad():
            original = self.model.material(material)
            hidden = self.model.material(variant)
            variant['M'][:, 65] = 12
            changed = self.model.material(variant)
        self.assertTrue(torch.equal(original, hidden))
        self.assertFalse(torch.equal(original[:, 0], changed[:, 0]))
        empty = {key: value.clone() for key, value in material.items()}
        empty['known_M'][:] = False
        with torch.no_grad():
            self.assertEqual(torch.count_nonzero(self.model.material(empty)).item(), 0)

    def test_group_mask_and_roundtrip(self):
        allow = torch.zeros(1, T_MAX, len(GROUPS), dtype=torch.bool)
        allow[..., 4] = True
        with torch.no_grad():
            result = self.model(sample_batch(), allowed_groups=allow)
        self.assertTrue((result['groups'][..., 0] < -1e30).all().item())
        self.assertTrue(torch.isfinite(result['groups'][..., 4]).all().item())
        self.assertTrue(torch.isfinite(result['groups'][..., 6]).all().item())
        copy = FourPillarFoundation(base_config=self.checkpoint['base_config'],
                                    expression_sizes=self.checkpoint['expression_sizes'])
        copy.load_state_dict(self.checkpoint['state_dict'], strict=True)
        self.assertTrue(all(torch.equal(p, q) for p, q in zip(self.model.parameters(), copy.parameters())))


if __name__ == '__main__':
    unittest.main()
