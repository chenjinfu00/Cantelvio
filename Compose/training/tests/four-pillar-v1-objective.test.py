#!/usr/bin/env python3
"""Missing source labels stay unsupervised; all heads can be wired later."""
import sys
import unittest
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_v1_objective import composition_objective  # noqa: E402


class ObjectiveTest(unittest.TestCase):
    def test_masks_and_hard_locks(self):
        torch.manual_seed(5)
        outputs = {
            'tokens': torch.randn(1, 3, 7, requires_grad=True),
            'voice_pointer': torch.randn(1, 3, 4, requires_grad=True),
            'harmony_root': torch.randn(1, 4, 12, requires_grad=True),
            'harmony_quality': torch.randn(1, 4, 40, requires_grad=True),
            'summaries': torch.randn(1, 4, 20, requires_grad=True),
            'form_density': torch.randn(1, 4, 1, requires_grad=True),
            'form_register': torch.randn(1, 4, 2, requires_grad=True),
            'form_texture': torch.randn(1, 4, 4, requires_grad=True),
            'group_activity': torch.randn(1, 4, 6, requires_grad=True),
            'key_direction': torch.randn(1, 4, 13, requires_grad=True),
            'motif': torch.randn(1, 5, requires_grad=True),
            'tempo': torch.randn(1, 4, 3, requires_grad=True),
            'numeric_dynamic': torch.randn(1, 3, 2, requires_grad=True),
            'midi_velocity': torch.randn(1, 3, 2, requires_grad=True),
        }
        targets = {
            'event': torch.tensor([[1, 9999, 2]]),
            'event_known': torch.tensor([[True, False, True]]),
            'event_locked': torch.tensor([[True, False, False]]),
            'voice_pointer': torch.tensor([[3, 9999, 0]]),
            'voice_pointer_known': torch.tensor([[True, False, False]]),
            'harmony_root': torch.tensor([[5, 9999, 9999, 9999]]),
            'harmony_root_known': torch.tensor([[True, False, False, False]]),
            'form_summary': torch.zeros(1, 4, 20),
            'form_summary_known': torch.zeros(1, 4, 20, dtype=torch.bool),
            'tempo_change': torch.tensor([[1, 9999, 9999, 9999]]),
            'tempo_change_known': torch.tensor([[True, False, False, False]]),
            'numeric_dynamic': torch.tensor([[80., 9999., 9999.]]),
            'numeric_dynamic_known': torch.tensor([[True, False, False]]),
        }
        loss, detail = composition_objective(outputs, targets)
        self.assertTrue(torch.isfinite(loss))
        self.assertEqual(detail['event']['known'], 1)
        self.assertEqual(detail['voice_pointer']['known'], 1)
        self.assertEqual(detail['form_summary']['known'], 0)
        loss.backward()
        self.assertTrue(torch.isfinite(outputs['tokens'].grad).all())
        self.assertEqual(outputs['tokens'].grad[0, 0].abs().sum(), 0)
        self.assertEqual(outputs['tokens'].grad[0, 1].abs().sum(), 0)
        self.assertGreater(outputs['tokens'].grad[0, 2].abs().sum(), 0)

    def test_refuses_unsupervised_batch(self):
        outputs = {'tokens': torch.zeros(1, 1, 4, requires_grad=True)}
        with self.assertRaisesRegex(ValueError, 'no source-known'):
            composition_objective(outputs, {})


if __name__ == '__main__':
    unittest.main()
