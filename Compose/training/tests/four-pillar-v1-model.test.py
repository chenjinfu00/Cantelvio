#!/usr/bin/env python3
"""Integrated, untrained architecture checks only; no corpus run or optimizer."""
import sys
import unittest
from fractions import Fraction
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from four_pillar_codec import BAR, GROUP_BASE, PITCH_BASE, ROLE_BASE  # noqa: E402
from four_pillar_v1_model import FourPillarComposerV1, LEGACY_STEP_KEYS  # noqa: E402
from four_pillar_v1_objective import composition_objective  # noqa: E402
from four_pillar_v1_codec import VOICE_CHOICE  # noqa: E402


class FullModelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        torch.manual_seed(91)
        cls.model = FourPillarComposerV1(history_bars=4, context=24).eval()

    def inputs(self, *, legacy=True):
        features = torch.zeros(1, 2, 16)
        features[0, 0, 0] = 1  # woodwinds
        features[0, 1, 4] = 1  # high strings
        features[..., 14] = 48 / 127
        features[..., 15] = 84 / 127
        chord = {'root': torch.tensor([[5, 9999]]),
                 'quality': torch.tensor([[0, 9999]]),
                 'bar': torch.tensor([[0, 9999]]),
                 'offset_num': torch.tensor([[0, 9999]]),
                 'offset_den': torch.tensor([[1, 9999]]),
                 'known': torch.tensor([[True, False]]),
                 'hard_lock': torch.tensor([[True, False]])}
        args = dict(
            history=torch.rand(1, 4, 20),
            history_known=torch.tensor([[True, True, True, False]]),
            decoder_input=torch.tensor([[1, 2, 3, 4, 5]]),
            material=torch.empty(1, 0, dtype=torch.long),
            material_known=torch.empty(1, 0, dtype=torch.bool),
            task_id=torch.tensor([2]), intent_id=torch.tensor([0]),
            voice_features=features, voice_known=torch.tensor([[True, True]]),
            voice_pointer_input=torch.full((1, 5), -1, dtype=torch.long),
            chords=chord,
            motif_tokens=torch.tensor([[[2, 288, 9999]]]),
            motif_known=torch.tensor([[[True, True, False]]]),
            log_qpm=torch.tensor([4.8]), tempo_known=torch.tensor([True]),
            allowed_groups=torch.tensor([[False, True, True, True, True, True]]),
        )
        if legacy:
            window = {k: torch.zeros(1, 128, dtype=torch.long) for k in LEGACY_STEP_KEYS}
            for key in ('R', 'H', 'B', 'M'):
                window[key].fill_(2)
            window['barlen'].fill_(16)
            window['beatlen'].fill_(4)
            window.update(domain=torch.tensor([0]), style=torch.tensor([3]),
                          refmode=torch.tensor([0]))
            args.update(legacy_window=window, legacy_visible_steps=torch.tensor([8]),
                        legacy_end_qn=(Fraction(31, 4),),
                        target_start_qn=(Fraction(8),))
        return args

    def test_all_pillars_forward_and_masks(self):
        args = self.inputs()
        with torch.no_grad():
            out = self.model(**args)
        self.assertEqual(out['tokens'].shape[:2], (1, 5))
        self.assertEqual(out['voice_pointer'].shape, (1, 5, 3))
        self.assertEqual(out['form_density'].shape, (1, 4, 1))
        self.assertEqual(out['motif_recall'].shape, (1, 4, 2))
        self.assertEqual(out['motif_transform'].shape, (1, 4, 2))
        self.assertEqual(out['tempo'].shape, (1, 4, 3))
        self.assertTrue(torch.isfinite(out['harmony_root']).all())
        self.assertEqual(out['harmony_root'][0, 0].argmax().item(), 5)
        self.assertEqual(out['locked_chords']['root'][0, 0].item(), 5)
        self.assertTrue(out['legacy_prior_known'].item())
        self.assertTrue((out['tokens'][..., GROUP_BASE] < -1e30).all())
        self.assertTrue((out['voice_pointer'][..., 0] < -1e30).all())
        self.assertTrue(torch.isfinite(out['voice_pointer'][..., 1:]).all())
        counts = self.model.parameter_counts()
        self.assertEqual(counts['frozen_legacy'], 1581309)
        self.assertEqual(counts['total'], counts['trainable'] + counts['frozen_legacy'])
        self.assertEqual(self.model.transfer['decoderLayersSeeded'], 4)
        self.assertEqual(self.model.transfer['copiedScalars'], 699392)
        self.assertEqual(len(self.model.score.decoder.layers), 4)
        with torch.no_grad():
            old_streams, visible = self.model._past_legacy(
                args['legacy_window'], args['legacy_visible_steps'],
                args['legacy_end_qn'], args['target_start_qn'], 1,
                args['history'].device)
        self.assertEqual(old_streams.shape, (1, 4, 192))
        self.assertTrue(visible.all())
        self.assertFalse(torch.equal(old_streams[0, 0], old_streams[0, 1]))

    def test_unknown_future_cannot_enter_old_prior_or_conditions(self):
        args = self.inputs()
        with torch.no_grad():
            original = self.model(**args)['tokens']
            mutated = self.inputs()
            mutated['history'] = args['history']
            mutated['legacy_window'] = {k: v.clone() for k, v in args['legacy_window'].items()}
            for key in LEGACY_STEP_KEYS:
                mutated['legacy_window'][key][:, 8:] = 9999
            mutated['chords']['root'][0, 1] = 7
            mutated['chords']['quality'][0, 1] = 9
            mutated['chords']['bar'][0, 1] = 1
            mutated['chords']['offset_num'][0, 1] = 1
            mutated['chords']['offset_den'][0, 1] = 2
            mutated['motif_tokens'][0, 0, 2] = 0
            changed = self.model(**mutated)['tokens']
        self.assertTrue(torch.equal(original, changed))
        mutated['legacy_end_qn'] = (Fraction(33, 4),)
        with self.assertRaisesRegex(ValueError, 'past-only'):
            self.model(**mutated)

    def test_lock_and_resource_constraints(self):
        args = self.inputs(legacy=False)
        allowed_roles = torch.zeros(1, 8, dtype=torch.bool)
        allowed_roles[0, 1] = True
        allowed_pitches = torch.zeros(1, 128, dtype=torch.bool)
        allowed_pitches[0, 60] = True
        args.update(allowed_roles=allowed_roles, allowed_pitches=allowed_pitches,
                    locked_tokens=torch.tensor([[0, BAR, 0, 0, 0]]),
                    locked_mask=torch.tensor([[False, True, False, False, False]]))
        with torch.no_grad():
            out = self.model(**args)
        self.assertEqual(out['tokens'][0, 1].argmax().item(), BAR)
        self.assertTrue((out['tokens'][0, 1, torch.arange(out['tokens'].shape[-1]) != BAR] < -1e30).all())
        self.assertTrue((out['tokens'][0, 0, ROLE_BASE] < -1e30).all())
        self.assertTrue((out['tokens'][0, 0, PITCH_BASE:PITCH_BASE + 60] < -1e30).all())
        args['locked_tokens'][0, 1] = GROUP_BASE
        with self.assertRaisesRegex(ValueError, 'conflicts'):
            self.model(**args)

    def test_no_aligned_old_prior_and_seventy_registered_voices(self):
        args = self.inputs(legacy=False)
        args['voice_features'] = torch.zeros(1, 70, 16)
        args['voice_known'] = torch.ones(1, 70, dtype=torch.bool)
        with torch.no_grad():
            out = self.model(**args)
        self.assertFalse(out['legacy_prior_known'].item())
        self.assertEqual(out['voice_pointer'].shape, (1, 5, 71))

    def test_same_instrument_role_still_has_distinct_voice_identities(self):
        args = self.inputs(legacy=False)
        args['voice_features'][0, 1] = args['voice_features'][0, 0]
        args['allowed_groups'] = torch.ones(1, 6, dtype=torch.bool)
        with torch.no_grad():
            logits = self.model(**args)['voice_pointer']
        self.assertFalse(torch.equal(logits[0, :, 0], logits[0, :, 1]))

    def test_empty_initial_voice_registry(self):
        args = self.inputs(legacy=False)
        args['voice_features'] = torch.zeros(1, 5, 0, 16)
        args['voice_known'] = torch.zeros(1, 5, 0, dtype=torch.bool)
        with torch.no_grad():
            logits = self.model(**args)['voice_pointer']
        self.assertEqual(logits.shape, (1, 5, 1))
        self.assertTrue(torch.isfinite(logits).all())

    def test_causal_voice_feedback_and_growing_registry(self):
        args = self.inputs(legacy=False)
        args['decoder_input'] = torch.tensor([[1, VOICE_CHOICE, 4, VOICE_CHOICE, 5]])
        args['voice_pointer_input'] = torch.tensor([[-1, 0, -1, 1, -1]])
        registry = torch.zeros(1, 5, 2, 16)
        registry[..., -1] = 1
        known = torch.tensor([[[False, False], [False, False], [True, False],
                               [True, False], [True, True]]])
        args['voice_features'] = registry
        args['voice_known'] = known
        with torch.no_grad():
            out = self.model(**args)
        self.assertEqual(out['voice_pointer'].shape, (1, 5, 3))
        self.assertTrue((out['voice_pointer'][0, 0, 1:] < -1e30).all())
        self.assertTrue(torch.isfinite(out['voice_pointer'][0, 0, 0]))
        self.assertTrue(torch.isfinite(out['voice_pointer'][0, 3, 1]))
        args['voice_pointer_input'][0, 3] = 0  # existing voice, not NEW_VOICE
        args['voice_known'][0, 4, 1] = False
        with torch.no_grad():
            changed = self.model(**args)
        self.assertTrue(torch.equal(out['tokens'][:, :3], changed['tokens'][:, :3]))
        self.assertFalse(torch.equal(out['tokens'][:, 3:], changed['tokens'][:, 3:]))

    def test_full_network_has_finite_masked_gradients_without_training(self):
        self.model.train()
        try:
            self.assertFalse(self.model.legacy.training)
            self.model.zero_grad(set_to_none=True)
            out = self.model(**self.inputs())
            targets = {
                'event': torch.tensor([[BAR, BAR, BAR, BAR, BAR]]),
                'event_known': torch.tensor([[True, False, False, False, False]]),
                'voice_pointer': torch.tensor([[1, 0, 0, 0, 0]]),
                'voice_pointer_known': torch.tensor([[True, False, False, False, False]]),
                'form_summary': torch.zeros_like(out['summaries']),
                'form_summary_known': torch.ones_like(out['summaries'], dtype=torch.bool),
                'tempo_change': torch.zeros(1, 4),
                'tempo_change_known': torch.tensor([[True, False, False, False]]),
                'motif_recall': torch.tensor([[1, 0, 0, 0]]),
                'motif_recall_known': torch.tensor([[True, False, False, False]]),
                'motif_pitch_shift': torch.zeros(1, 4),
                'motif_pitch_shift_known': torch.tensor([[True, False, False, False]]),
            }
            loss, details = composition_objective(out, targets)
            loss.backward()
            self.assertTrue(torch.isfinite(loss))
            self.assertEqual(details['event']['known'], 1)
            self.assertTrue(torch.isfinite(self.model.score.decoder.layers[0].self_attn.in_proj_weight.grad).all())
            self.assertTrue(torch.isfinite(self.model.score.planner.layers[0].self_attn.in_proj_weight.grad).all())
            self.assertIsNone(self.model.legacy.tok[0].weight.grad)
        finally:
            self.model.eval()


if __name__ == '__main__':
    unittest.main()
