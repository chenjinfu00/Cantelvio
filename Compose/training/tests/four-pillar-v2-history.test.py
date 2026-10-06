#!/usr/bin/env python3
"""Long history must reach training and decoding, with causal rolling bounds."""
import copy
import random
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from score_events_v2 import ScoreEvents
from four_pillar_midi_data import midi_item_from_score, slice_score
from four_pillar_v2_model import FourPillarExpressiveV2, expressive_objective
from four_pillar_v2_examples import make_training_example
from four_pillar_v2_decode import Cursor
import train_four_pillar_v2 as trainer


def long_score():
    return ScoreEvents.from_candidate({
        'scoreId': 'history-test', 'parts': [{'id': 'p', 'group': 'keys'}],
        'measures': [{'on': str(i*4), 'dur': '4', 'meter': [4,4]} for i in range(524)],
        'notes': [{'on': str(i*4), 'dur': '1', 'bar': i, 'pitch': 48+i%24,
                   'part': 'p', 'staff': '1', 'voice': '1', 'group': 'keys'}
                  for i in range(524)]})


class HistoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        torch.manual_seed(84)
        cls.model = FourPillarExpressiveV2(context=256).eval()
        cls.score = long_score()

    def test_real_sampler_supplies_512_past_bars_and_oldest_affects_plan(self):
        rng = random.Random(2)
        with patch.object(trainer, 'get_score', return_value=self.score), \
             patch.object(rng, 'choice', return_value=519), \
             patch.object(trainer, 'transform_item', side_effect=lambda item,*a,**k: (item,0,'none')):
            _,_,_,inputs,targets,audit = trainer.sample_score(
                None, [('history-test',524)], rng, lambda: 0, 256, task='free')
        self.assertEqual(audit['knownHistoryBars'], 512)
        self.assertEqual(audit['historyBars'], 512)
        self.assertEqual(inputs['history'].shape, (1,512,20))
        # target 519 retains bars 7..518, excludes both evicted and future bars.
        self.assertEqual(int(inputs['history'][0,0,:12].argmax()), (48+7)%12)
        self.assertEqual(int(inputs['history'][0,-1,:12].argmax()), (48+518)%12)
        changed = copy.deepcopy(inputs)
        changed['history'][0,0,:12] = torch.roll(changed['history'][0,0,:12], 1)
        with torch.no_grad():
            a, b = self.model(**inputs), self.model(**changed)
        self.assertGreater(float((a['plan']-b['plan']).abs().max()), 1e-7)
        self.model.zero_grad(set_to_none=True)
        loss,_ = expressive_objective(self.model(**inputs), targets)
        loss.backward()
        self.assertTrue(all(torch.isfinite(p.grad).all() for p in self.model.parameters()
                            if p.grad is not None))
        self.assertGreater(float(self.model.score.bar_position.weight.grad[511].abs().sum()), 0)

    def test_midi_rolling_window_and_short_history_padding(self):
        parsed = (self.score, {}, (True,)*524, (90.,)*524)
        item = midi_item_from_score(parsed, target_bar=519, history_bars=512)
        self.assertEqual((item.first_source_bar,item.target_relative_bar), (7,512))
        x,_,audit = make_training_example(item,512,random.Random(1),context=256,task='free')
        self.assertEqual(int(x['history_known'].sum()), 512)
        short = midi_item_from_score(parsed,target_bar=2,history_bars=512)
        x,_,audit = make_training_example(short,2,random.Random(1),context=256,task='free')
        self.assertEqual(int(x['history_known'].sum()), 2)
        altered = copy.deepcopy(x)
        altered['history'][:,2:] = 999
        with torch.no_grad():
            self.assertTrue(torch.equal(self.model(**x)['tokens'], self.model(**altered)['tokens']))

    def test_decoder_uses_checkpoint_window_and_old_weights_require_migration(self):
        prompt = slice_score(self.score,0,519)
        cursor = Cursor(self.model,prompt,torch.Generator().manual_seed(1),1.)
        with torch.no_grad():
            self.assertTrue(torch.isfinite(cursor.predict()['tokens']).all())
        self.assertEqual(int(cursor.memory_inputs['history_known'].sum()), 512)
        old = FourPillarExpressiveV2(context=256,history_bars=32).eval()
        with self.assertRaises(RuntimeError):
            old.load_state_dict(self.model.state_dict(), strict=True)
        cursor = Cursor(old,prompt,torch.Generator().manual_seed(1),1.)
        with torch.no_grad(): cursor.predict()
        self.assertEqual(int(cursor.memory_inputs['history_known'].sum()), 32)
        counts = self.model.parameter_counts()
        self.assertEqual(counts['total'] - old.parameter_counts()['total'], 92160)


if __name__ == '__main__': unittest.main()
