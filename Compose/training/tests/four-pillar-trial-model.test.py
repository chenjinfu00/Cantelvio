#!/usr/bin/env python3
"""Technical trial checks: causal event feedback, masks and finite gradients."""
import sys
import unittest
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_codec import GROUP_BASE  # noqa: E402
from four_pillar_trial_model import FourPillarTrial  # noqa: E402


class TrialModelTest(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(2)
        torch.manual_seed(13)
        self.model = FourPillarTrial(width=48, heads=4, planner_layers=1,
                                     decoder_layers=1, history_bars=4, context=24)
        self.history = torch.randn(1, 4, 20)
        self.known = torch.tensor([[True, True, True, False]])
        self.tokens = torch.tensor([[1, 2, 32, 33, 3, 32, 33, 4, 34, 544, 288, 32]])
        self.material = torch.tensor([[2, 3, 4, 288]])
        self.mat_known = torch.tensor([[True, True, True, True]])

    def inputs(self):
        return dict(history=self.history, history_known=self.known,
                    decoder_input=self.tokens, material=self.material,
                    material_known=self.mat_known)

    def test_causality_unknown_payload_and_group_mask(self):
        self.model.eval()
        with torch.no_grad():
            original = self.model(**self.inputs())['tokens']
            changed = self.inputs()
            changed['decoder_input'] = self.tokens.clone()
            changed['decoder_input'][0, 8] = 111
            later = self.model(**changed)['tokens']
            self.assertTrue(torch.equal(original[:, :8], later[:, :8]))

            changed = self.inputs()
            changed['material'] = self.material.clone()
            changed['material_known'] = self.mat_known.clone()
            changed['material_known'][0, 2] = False
            masked = self.model(**changed)['tokens']
            changed['material'][0, 2] = 9999  # unknown data must be ignored
            still_masked = self.model(**changed)['tokens']
            self.assertTrue(torch.equal(masked, still_masked))

            groups = torch.tensor([[False, True, True, True, True, True]])
            restricted = self.model(**self.inputs(), allowed_groups=groups)['tokens']
            self.assertTrue((restricted[..., GROUP_BASE] < -1e30).all().item())
            self.assertTrue(torch.isfinite(restricted[..., GROUP_BASE + 1]).all().item())

    def test_form_and_event_paths_receive_gradients(self):
        self.model.train()
        result = self.model(**self.inputs())
        loss = (result['tokens'][0, -1, 100] + result['summaries'][0, 0].sum()
                + result['motif'][0, 0])
        loss.backward()
        self.assertTrue(torch.isfinite(loss).item())
        self.assertIsNotNone(self.model.planner.layers[0].self_attn.in_proj_weight.grad)
        self.assertIsNotNone(self.model.decoder.layers[0].self_attn.in_proj_weight.grad)
        self.assertIsNotNone(self.model.token.weight.grad)


if __name__ == '__main__':
    unittest.main()
