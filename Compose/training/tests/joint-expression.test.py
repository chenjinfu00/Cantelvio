#!/usr/bin/env python3
"""No-network checks for exact MusicXML expression and the sidecar loss path."""
import sys
from pathlib import Path
from fractions import Fraction
import unittest
import xml.etree.ElementTree as ET

import numpy as np
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from build_joint_expression import score_events
from train_joint_expression import ExpressionSidecar, FIELDS, Window
from joint_model import StructuredJoint, loss_and_metrics


class ExpressionTest(unittest.TestCase):
    def test_full_joint_backbone_gets_expression_and_replay_gradients(self):
        torch.set_num_threads(2)
        base = StructuredJoint(d=96, heads=6, layers=1, ff=128, T=128, dropout=0)
        vocab = {key: ['<UNK>', 'value'] for key in ('sub', 'dur', 'ratio', 'dynamic')}
        model = ExpressionSidecar(base, vocab, train_base=True)
        row = {name: torch.zeros((1, 128), dtype=torch.long)
               for name in ('R', 'H', 'B', 'M', 'pos', 'meter', 'level', 'phrase',
                            'lkey', 'beatphase', 'chord', 'since', 'change')}
        row['barlen'] = torch.full((1, 128), 16, dtype=torch.long)
        row['beatlen'] = torch.full((1, 128), 4, dtype=torch.long)
        for name, token in (('R', 4), ('H', 3), ('B', 4), ('M', 4)):
            row[name][0, :2] = token
        row['domain'] = torch.zeros(1, dtype=torch.long)
        row['style'] = torch.zeros(1, dtype=torch.long)
        row['refmode'] = torch.zeros(1, dtype=torch.long)
        row['valid'] = torch.zeros((1, 128), dtype=torch.bool)
        row['valid'][0, :2] = True
        row['event_count'] = torch.zeros((1, 128, 3), dtype=torch.long)
        row['event_count'][0, 1, 2] = 1
        row['event_fields'] = torch.zeros((1, 128, 3, 16, len(FIELDS)), dtype=torch.long)
        row['event_fields'][0, 1, 2, 0, FIELDS.index('pitch')] = 60
        row['event_known'] = torch.zeros_like(row['event_fields'], dtype=torch.bool)
        row['event_known'][0, 1, 2, 0, FIELDS.index('pitch')] = True
        expression, _ = model.losses(row)
        replay, _ = loss_and_metrics(model.base, row)
        (expression + replay).backward()
        self.assertTrue(torch.isfinite(expression + replay))
        self.assertIsNotNone(base.layers[0].q[0].weight.grad)
        self.assertGreater(float(base.layers[0].q[0].weight.grad.abs().sum()), 0)

    def test_fine_tuning_keeps_old_base_trainable(self):
        class TinyBase(nn.Module):
            d = 8

            def __init__(self):
                super().__init__()
                self.tok = nn.ModuleList(nn.Embedding(8, self.d) for _ in range(4))

            def forward(self, batch, extra_step=None, return_features=False):
                h = self.tok[0](batch['R'])[:, :, None, :].expand(-1, -1, 4, -1)
                return None, h

        vocab = {key: ['<UNK>', 'value'] for key in ('sub', 'dur', 'ratio', 'dynamic')}
        model = ExpressionSidecar(TinyBase(), vocab, train_base=True)
        self.assertTrue(all(p.requires_grad for p in model.base.parameters()))
        model.train()
        self.assertTrue(model.base.training)
        fields = torch.zeros((1, 128, 3, 16, len(FIELDS)), dtype=torch.long)
        count = torch.zeros((1, 128, 3), dtype=torch.long)
        known = torch.zeros_like(fields, dtype=torch.bool)
        valid = torch.zeros((1, 128), dtype=torch.bool)
        valid[:, :2] = True
        count[0, 1, 2] = 1
        known[0, 1, 2, 0, FIELDS.index('pitch')] = True
        row = {name: torch.zeros((1, 128), dtype=torch.long) for name in ('R', 'H', 'B', 'M')}
        row.update(event_fields=fields, event_count=count, event_known=known, valid=valid)
        loss, _ = model.losses(row)
        loss.backward()
        self.assertIsNotNone(model.base.tok[0].weight.grad)

    def test_unknown_dynamic_does_not_train_dynamic_head(self):
        class TinyBase(nn.Module):
            d = 8

            def __init__(self):
                super().__init__()
                self.tok = nn.ModuleList(nn.Embedding(8, self.d) for _ in range(4))

            def forward(self, batch, extra_step=None, return_features=False):
                shape = (*batch['R'].shape, 4, self.d)
                return None, torch.zeros(shape)

        vocab = {key: ['<UNK>', 'value'] for key in ('sub', 'dur', 'ratio', 'dynamic')}
        model = ExpressionSidecar(TinyBase(), vocab)
        fields = torch.zeros((1, 128, 3, 16, len(FIELDS)), dtype=torch.long)
        count = torch.zeros((1, 128, 3), dtype=torch.long)
        known = torch.zeros_like(fields, dtype=torch.bool)
        valid = torch.zeros((1, 128), dtype=torch.bool)
        valid[:, :2] = True
        count[0, 1, 2] = 1
        fields[0, 1, 2, 0, FIELDS.index('pitch')] = 72
        for field in ('pitch', 'sub', 'dur'):
            known[0, 1, 2, 0, FIELDS.index(field)] = True
        batch = {name: torch.zeros((1, 128), dtype=torch.long) for name in ('R', 'H', 'B', 'M')}
        batch.update(event_fields=fields, event_count=count, event_known=known, valid=valid)
        loss, metrics = model.losses(batch)
        self.assertTrue(torch.isfinite(loss))
        self.assertIn('2.pitch', metrics)
        self.assertIn('2.dur', metrics)
        self.assertNotIn('2.dynamic', metrics)
        loss.backward()

    def test_missing_dynamics_and_explicit_field_masks(self):
        events = np.asarray([[0, 2, 72, 1, 1, 1, 0, 0, 0],
                             [1, 2, 74, 1, 1, 0, 6, 0, 0]], np.int32)
        _, _, known = Window(None, events, 0, 16).annotation()
        self.assertFalse(known[0, 2, 0, FIELDS.index('dynamic')])
        self.assertTrue(known[0, 2, 0, FIELDS.index('pitch')])
        self.assertTrue(known[0, 2, 0, FIELDS.index('dur')])
        self.assertFalse(known[1, 2, 0, FIELDS.index('ratio')])
        self.assertTrue(known[1, 2, 0, FIELDS.index('dynamic')])
        explicit = np.ones((2, len(FIELDS)), bool)
        explicit[0, FIELDS.index('accent')] = False
        explicit[1, FIELDS.index('wedge')] = False
        _, _, custom = Window(None, events, 0, 16, known=explicit).annotation()
        self.assertFalse(custom[0, 2, 0, FIELDS.index('accent')])
        self.assertFalse(custom[1, 2, 0, FIELDS.index('wedge')])

    def test_exact_tuplets_dotted_dynamic_and_compound_meter(self):
        xml = ET.fromstring('''<score-partwise>
          <part id="P1"><measure number="1"><attributes><divisions>60</divisions>
          <time><beats>6</beats><beat-type>8</beat-type></time></attributes>
          <direction><direction-type><dynamics><mf/></dynamics><wedge type="crescendo"/></direction-type></direction>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>20</duration>
            <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
            <notations><articulations><accent/></articulations></notations></note>
          <note><pitch><step>D</step><octave>5</octave></pitch><duration>20</duration>
            <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
          <note><pitch><step>E</step><octave>5</octave></pitch><duration>20</duration>
            <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
          <note><pitch><step>F</step><octave>5</octave></pitch><duration>12</duration>
            <time-modification><actual-notes>5</actual-notes><normal-notes>4</normal-notes></time-modification></note>
          <note><pitch><step>G</step><octave>5</octave></pitch><duration>45</duration><type>eighth</type><dot/></note>
          <note><pitch><step>A</step><octave>5</octave></pitch><duration>10</duration>
            <time-modification><actual-notes>6</actual-notes><normal-notes>4</normal-notes></time-modification></note>
          <note><pitch><step>B</step><octave>5</octave></pitch><duration>10</duration>
            <time-modification><actual-notes>7</actual-notes><normal-notes>4</normal-notes></time-modification></note>
          </measure></part>
          <part id="P2"><measure number="1"><attributes><divisions>60</divisions></attributes>
          <note><pitch><step>C</step><octave>3</octave></pitch><duration>60</duration></note>
          <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>60</duration></note>
          </measure></part></score-partwise>''')
        piece = {'arrays': {'bar': np.zeros(12, np.int16), 'meter': np.full(12, 5, np.int16)}}
        events = score_events(xml, piece)
        melody = [e for e in events if e[1] == 2]
        self.assertEqual([e[2] for e in melody], [72, 74, 76, 77, 79, 81, 83])
        self.assertEqual([e[3] for e in melody], ['0', '1/3', '2/3', '0', '4/5', '4/5', '7/15'])
        self.assertEqual([e[4] for e in melody], ['1/3', '1/3', '1/3', '1/5', '3/4', '1/6', '1/6'])
        self.assertEqual([e[5] for e in melody], ['3:2', '3:2', '3:2', '5:4', 'none', '6:4', '7:4'])
        self.assertTrue(all(e[6] == 'mf' and e[8] == 1 for e in melody))
        self.assertEqual(melody[0][7], 1)
        self.assertEqual([e[1] for e in events if e[0] == 0], [0, 1, 2])


if __name__ == '__main__':
    unittest.main()
