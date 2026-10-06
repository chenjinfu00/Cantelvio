#!/usr/bin/env python3
"""Exact-slice provenance and active forward-path check for partial old initialization."""
import sys
import unittest
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_legacy_init import SOURCE, initialize_from_legacy  # noqa: E402
from four_pillar_trial_model import FourPillarTrial  # noqa: E402


class LegacyInitializationTest(unittest.TestCase):
    def test_transferred_slices_are_exact_and_change_predictions(self):
        torch.set_num_threads(2)
        torch.manual_seed(53)
        model = FourPillarTrial(history_bars=4, context=24)
        untouched_token = model.token.weight.detach().clone()
        untouched_planner = model.planner.layers[0].self_attn.in_proj_weight.detach().clone()
        inputs = {
            'history': torch.rand(1, 4, 20),
            'history_known': torch.tensor([[True, True, True, False]]),
            'decoder_input': torch.tensor([[1, 2, 3, 4, 5]]),
            'material': torch.empty(1, 0, dtype=torch.long),
            'material_known': torch.empty(1, 0, dtype=torch.bool),
        }
        model.eval()
        with torch.no_grad():
            before = model(**inputs)['tokens'].clone()
        transfer = initialize_from_legacy(model)
        source = torch.load(SOURCE, map_location='cpu', weights_only=True)['state_dict']
        d, width = 96, model.config['width']
        half = d // model.config['heads']
        for name, stream, offset in (('H', 1, 0), ('M', 3, half)):
            idx = (torch.arange(d) // half) * (2 * half) + torch.arange(d) % half + offset
            target = model.decoder.layers[0]
            self.assertTrue(torch.equal(
                target.self_attn.in_proj_weight[idx[:, None], idx[None, :]],
                source[f'layers.0.q.{stream}.weight']), name)
            self.assertTrue(torch.equal(
                target.linear2.bias[idx], source[f'layers.0.ff2.{stream}.bias']), name)
        self.assertTrue(torch.equal(model.token.weight, untouched_token))
        self.assertTrue(torch.equal(model.planner.layers[0].self_attn.in_proj_weight,
                                    untouched_planner))
        with torch.no_grad():
            after = model(**inputs)['tokens']
        self.assertFalse(torch.equal(before, after))
        self.assertTrue(torch.isfinite(after).all())
        self.assertEqual(transfer['sourceStep'], 42377)
        self.assertEqual(transfer['decoderLayersSeeded'], 4)
        self.assertGreater(transfer['copiedScalars'], 100000)
        model.train()
        loss = model(**inputs)['tokens'][0, -1].square().mean()
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertTrue(torch.isfinite(model.decoder.layers[0].self_attn.in_proj_weight.grad).all())

    def test_rejects_incompatible_dimensions(self):
        model = FourPillarTrial(width=96, heads=6, planner_layers=1,
                                decoder_layers=1, history_bars=4, context=8)
        with self.assertRaisesRegex(ValueError, 'width=2'):
            initialize_from_legacy(model)


if __name__ == '__main__':
    unittest.main()
