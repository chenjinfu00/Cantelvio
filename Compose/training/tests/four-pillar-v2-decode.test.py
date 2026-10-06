#!/usr/bin/env python3
"""Grammar/free rhythm, exact locked voices and inspectable offline exports."""
import importlib.util
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

import torch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from four_pillar_codec import *
from four_pillar_v1_codec import V1_VOCAB_SIZE,encode_dynamic_score,decode_dynamic_score
from four_pillar_v2_decode import generate,Cursor
from four_pillar_v2_export import export
from score_events_v2 import ScoreEvents


def prompt():
    return ScoreEvents.from_candidate({'scoreId':'test','parts':[{'id':'p','group':'keys'}],
        'measures':[{'on':'0','dur':'4','meter':[4,4]}],
        'notes':[{'on':'0','dur':'5','bar':0,'pitch':60,'part':'p','staff':'1','voice':'1',
                  'group':'keys'}]})


class MockModel:
    score=SimpleNamespace(config={'context':256,'history_bars':512})
    def eval(self):return self
    def __call__(self,**inputs):
        length=inputs['decoder_input'].shape[1]
        logits=torch.full((1,length,V1_VOCAB_SIZE),-100.)
        for token in (ONSET,END_ONSET,NONE,GROUP_BASE+3,ACCENT_BASE,PITCH_BASE+64,BYTE_BASE+1):
            logits[...,token]=100
        n=inputs['voice_features'].shape[2]
        pointer=torch.full((1,length,n+1),-100.)
        pointer[...,0]=100
        return {'tokens':logits,'voice_pointer':pointer,
                'midi_velocity':torch.full((1,length,2),0.7),'tempo':torch.zeros(1,4,3)}


class DecodeTest(unittest.TestCase):
    def test_onset_at_next_barline_never_creates_a_note(self):
        class BarlineCursor(Cursor):
            def fraction(self,maximum,denominators,*,zero=False,clock=False):
                if clock:
                    self.now+=maximum
                    return maximum
                raise AssertionError('A next-bar onset must not sample note duration')
        result,audit=generate(MockModel(),prompt(),bars=1,max_notes=128,
                              groups=('keys',),cursor_factory=BarlineCursor)
        self.assertEqual(result.events,prompt().events)
        self.assertEqual(audit['resourceClosures'],[])

    def test_free_rhythm_and_full_codec_roundtrip(self):
        result,audit=generate(MockModel(),prompt(),bars=2,max_notes=2,groups=('keys',),
                              denominators=(1,2,3),max_voices=4)
        self.assertEqual(len(result.events),5)
        self.assertEqual([n.onset for n in result.events[1:]],list(map(Fraction,(5,6,9,10))))
        self.assertEqual(decode_dynamic_score(encode_dynamic_score(result),result).events,result.events)
        self.assertEqual(len(audit['resourceClosures']),2)
        self.assertEqual([q for _,q in audit['tempoMap']],[90.,90.,90.])

    def test_locked_future_voice_preserved_and_conflicts_fail(self):
        p=prompt()
        locked=replace(p.events[0],source_index=100,bar=1,onset=Fraction(13,3),
                       duration=Fraction(7,3),pitch=67,part='supplied')
        result,_=generate(MockModel(),p,bars=1,max_notes=2,groups=('keys',),
                           denominators=(1,2,3),locked_notes=(locked,))
        self.assertIn(locked,result.events)
        self.assertEqual(sum(n.voice_id==locked.voice_id for n in result.events),1)
        with self.assertRaises(ValueError):
            generate(MockModel(),p,bars=1,groups=('brass',),locked_notes=(locked,))

    def test_musicxml_midi_json_export(self):
        from symusic import Score
        result,audit=generate(MockModel(),prompt(),bars=1,max_notes=2,groups=('keys',),denominators=(1,2,3))
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory)/'sample'
            playback=export(result,audit,out)
            self.assertTrue(playback['exactTiming'])
            root=ET.parse(out/'score.musicxml').getroot()
            self.assertTrue(root.findall('.//tie'))
            from prepare_classical_scores import score_events
            parts,measures,notes,_=score_events(root)
            self.assertEqual(sorted((n['pitch'],Fraction(n['on']),Fraction(n['dur'])) for n in notes),
                             sorted((n.pitch,n.onset,n.duration) for n in result.events))
            midi=Score(str(out/'preview.mid'))
            self.assertEqual(sum(len(t.notes) for t in midi.tracks),len(result.events))
            self.assertEqual(sorted((n.pitch,Fraction(n.time,midi.ticks_per_quarter),
                                     Fraction(n.duration,midi.ticks_per_quarter))
                                    for t in midi.tracks for n in t.notes),
                             sorted((n.pitch,n.onset,n.duration) for n in result.events))
            self.assertTrue((out/'score.json').stat().st_size>0)

    def test_real_untrained_network_cursor_is_finite(self):
        from four_pillar_v2_model import FourPillarExpressiveV2
        torch.set_num_threads(1)
        model=FourPillarExpressiveV2(context=256).eval()
        cursor=Cursor(model,prompt(),torch.Generator().manual_seed(3),1.)
        with torch.no_grad():
            logits=cursor.predict()['tokens']
        self.assertTrue(torch.isfinite(logits).all())


if __name__=='__main__':unittest.main()
