#!/usr/bin/env python3
"""Small synthetic update and deterministic restore; never starts a corpus run."""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from four_pillar_codec import BAR, END_BAR, END_ONSET, NOTE, ONSET  # noqa: E402
from four_pillar_trial_data import collate  # noqa: E402
from four_pillar_trial_model import FourPillarTrial, SUMMARY_DIM  # noqa: E402
from train_four_pillar_trial import atomic_save, loss_terms  # noqa: E402


class CheckpointTest(unittest.TestCase):
    def test_optimizer_and_rng_resume_next_update_exactly(self):
        torch.set_num_threads(1)
        torch.manual_seed(29)
        config = dict(width=48, heads=4, planner_layers=1, decoder_layers=1,
                      history_bars=4, context=16)
        example = {
            'target': [BAR, ONSET, NOTE, END_ONSET, END_BAR],
            'loss_mask': [True] * 5,
            'history': np.zeros((4, SUMMARY_DIM), dtype=np.float32),
            'history_known': np.array([True, True, False, False]),
            'future': np.zeros((4, SUMMARY_DIM), dtype=np.float32),
            'future_known': np.array([True, False, False, False]),
            'motif': 0,
            'material': [],
        }
        batch = collate([example], context=16, device=torch.device('cpu'))
        model = FourPillarTrial(**config)
        optimizer = torch.optim.AdamW(model.parameters(), lr=2e-4)

        def update(current_model, current_optimizer):
            current_optimizer.zero_grad(set_to_none=True)
            loss, _ = loss_terms(current_model, batch)
            loss.backward()
            current_optimizer.step()
            return float(loss.detach())

        self.assertTrue(np.isfinite(update(model, optimizer)))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.pt'
            atomic_save({'model': model.state_dict(), 'optimizer': optimizer.state_dict(),
                         'torchRng': torch.get_rng_state()}, path)
            baseline_next_loss = update(model, optimizer)
            baseline_weights = {k: v.detach().clone() for k, v in model.state_dict().items()}

            restored = FourPillarTrial(**config)
            restored_optimizer = torch.optim.AdamW(restored.parameters(), lr=2e-4)
            state = torch.load(path, map_location='cpu', weights_only=False)
            restored.load_state_dict(state['model'], strict=True)
            restored_optimizer.load_state_dict(state['optimizer'])
            torch.set_rng_state(state['torchRng'])
            restored_next_loss = update(restored, restored_optimizer)

        self.assertEqual(baseline_next_loss, restored_next_loss)
        for name, value in restored.state_dict().items():
            self.assertTrue(torch.equal(value, baseline_weights[name]), name)


if __name__ == '__main__':
    unittest.main()
