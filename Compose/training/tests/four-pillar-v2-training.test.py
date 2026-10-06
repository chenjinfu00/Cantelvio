#!/usr/bin/env python3
"""Training readiness: complete windows, no future leaks, real task losses.

The optimizer test changes only a temporary synthetic model; no corpus run.
"""
import copy
import random
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from dataclasses import replace
from fractions import Fraction
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from score_events_v2 import ScoreEvents
from four_pillar_v1_codec import encode_dynamic_score
from four_pillar_v1_pilot_data import PairedScore
from four_pillar_trial_data import summarize_bars
from four_pillar_v2_examples import bar_chunks, make_training_example, SourceLabels
from four_pillar_v2_model import FourPillarExpressiveV2, expressive_objective
from four_pillar_v2_runtime import pack_state, restore_state, save_checkpoint, exclusive_run
from train_four_pillar_v1_all_data import SourceCycler


def fixture(onsets=4):
    data={'scoreId':'fixture','parts':[{'id':p,'group':'keys'} for p in ('a','b')],
          'measures':[{'on':str(i*4),'dur':'4','meter':[4,4]} for i in range(5)], 'notes':[]}
    for bar in range(5):
        for i in range(onsets):
            for p,base in [('a',60),('b',48)]:
                data['notes'].append(dict(bar=bar,on=str(bar*4+Fraction(i*4,onsets)),
                    dur='5' if i==0 else '1/3',part=p,staff='1',voice='1',
                    pitch=base+i%7,writtenPitch=base+i%7,group='keys',role='mel',dynamic='mf'))
    score=ScoreEvents.from_candidate(data)
    return PairedScore(score,None,encode_dynamic_score(score),summarize_bars(score),())


class TrainingReadiness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        torch.manual_seed(53)
        cls.model=FourPillarExpressiveV2(context=256).eval()

    def test_dense_bar_chunks_cover_every_target_once_and_include_real_past(self):
        item=fixture(20)
        chunks=bar_chunks(item.encoded,2,128)
        self.assertGreater(len(chunks),3)
        covered=[]
        for i,(a,b) in enumerate(chunks):
            inputs,targets,audit=make_training_example(item,2,random.Random(4),context=128,
                                                     task='free',chunk_index=i)
            covered.extend(range(a,b))
            self.assertLessEqual(inputs['decoder_input'].shape[1],128)
            self.assertTrue(audit['decoderStart'] < a)
            self.assertTrue(inputs['timeline'][...,18].max()>0)
            self.assertTrue(targets['event_known'].any())
        self.assertEqual(covered,list(range(*item.encoded.bar_spans[2])))
        self.assertTrue(audit['reachesBarEnd'])

    def test_unknown_future_changes_do_not_change_past_logits(self):
        item=fixture()
        other=replace(item,score=replace(item.score,events=tuple(
            replace(n,pitch=n.pitch+1) if n.bar>=3 else n for n in item.score.events)))
        other=replace(other,encoded=encode_dynamic_score(other.score),summaries=summarize_bars(other.score))
        a,_,_=make_training_example(item,2,random.Random(2),context=256,task='free')
        b,_,_=make_training_example(other,2,random.Random(2),context=256,task='free')
        for name in a:
            if torch.is_tensor(a[name]):self.assertTrue(torch.equal(a[name],b[name]),name)
        with torch.no_grad():
            self.assertTrue(torch.equal(self.model(**a)['tokens'],self.model(**b)['tokens']))

    def test_four_tasks_have_finite_objectives_and_supplied_notes_are_not_targets(self):
        item=fixture()
        harmony=[(i,Fraction(0),i,0) for i in range(3)]
        for task in ('free','given_melody','given_chords','given_motif'):
            inputs,targets,audit=make_training_example(item,2,random.Random(2),context=256,
                task=task,harmony=harmony,numeric={n.source_index:0.7 for n in item.score.events},
                tempos=(80.,80.,90.,90.,100.))
            loss,coverage=expressive_objective(self.model(**inputs),targets)
            self.assertTrue(torch.isfinite(loss))
            self.assertGreater(coverage['numeric_dynamic']['known'],0)
            self.assertGreater(coverage['tempo_level']['known'],0)
            if task=='given_melody':
                self.assertTrue(targets['event_locked'].any())
                self.assertTrue(audit['lockedSourceNotes'])
                self.assertLess(coverage['event']['known'],int(targets['event_known'].sum()))
            if task=='given_chords':
                self.assertEqual(coverage['harmony_root']['known'],0)
                intrabar=copy.deepcopy(inputs)
                intrabar['chords']['offset_num'][0,0]=1
                with torch.no_grad():
                    out=self.model(**intrabar)
                self.assertTrue((out['harmony_root'][0,0]>torch.finfo(torch.float32).min).all())
                self.assertEqual(int(out['locked_chords']['offset_num'][0,0]),1)
            if task=='free':self.assertEqual(coverage['harmony_root']['known'],3)

    def test_ordered_motif_encoder_distinguishes_permutations(self):
        tokens=torch.tensor([[[300,301,302,303]]])
        known=torch.ones_like(tokens,dtype=torch.bool)
        with torch.no_grad():
            a,_=self.model._motifs(tokens,known,1,torch.device('cpu'))
            b,_=self.model._motifs(tokens.flip(-1),known,1,torch.device('cpu'))
        self.assertFalse(torch.allclose(a,b,atol=1e-7,rtol=0))

    def test_future_token_inside_target_cannot_change_earlier_logits(self):
        item=fixture()
        last=[n for n in item.score.events if n.bar==2][-1]
        score=replace(item.score,events=tuple(replace(n,pitch=n.pitch+1)
                      if n.source_index==last.source_index else n for n in item.score.events))
        other=replace(item,score=score,encoded=encode_dynamic_score(score),summaries=summarize_bars(score))
        chunk=len(bar_chunks(item.encoded,2,256))-1
        a,_,_=make_training_example(item,2,random.Random(2),context=256,task='free',chunk_index=chunk)
        b,_,_=make_training_example(other,2,random.Random(2),context=256,task='free',chunk_index=chunk)
        changed=(a['decoder_input']!=b['decoder_input']).nonzero()
        self.assertTrue(len(changed)>0)
        first=int(changed[0,1]);self.assertGreater(first,0)
        with torch.no_grad():
            self.assertTrue(torch.equal(self.model(**a)['tokens'][:,:first],
                                        self.model(**b)['tokens'][:,:first]))

    def test_supplied_notes_reach_planner_and_unknown_material_is_masked(self):
        inputs,_,_=make_training_example(fixture(),2,random.Random(2),context=256,task='given_melody')
        altered=copy.deepcopy(inputs)
        from four_pillar_codec import PITCH_BASE
        i=int(((altered['material'][0]>=PITCH_BASE)&(altered['material'][0]<PITCH_BASE+127)).nonzero()[0])
        altered['material'][0,i]+=1
        with torch.no_grad():
            self.assertFalse(torch.allclose(self.model(**inputs)['plan'],self.model(**altered)['plan']))
        inputs['material_known'][0,i]=False
        altered=copy.deepcopy(inputs);altered['material'][0,i]=999999
        with torch.no_grad():
            self.assertTrue(torch.equal(self.model(**inputs)['tokens'],self.model(**altered)['tokens']))

    def test_actual_loop_signal_boundary_and_resume_in_temporary_synthetic_run(self):
        import train_four_pillar_v2 as trainer
        model=copy.deepcopy(self.model).train()
        stop=SimpleNamespace(requested=False)
        inputs,targets,audit=make_training_example(fixture(1),2,random.Random(2),context=128,task='free')
        def sample(rows,rng,choose,context,**kwargs):
            choose();stop.requested=True
            return 'synthetic-test',0,'none',inputs,targets,audit
        with tempfile.TemporaryDirectory() as directory:
            args=SimpleNamespace(output_dir=Path(directory),max_seconds=100,seed=3,lr=1e-4,
                                 threads=1,warmup_steps=100,checkpoint_seconds=300,resume=False,context=256)
            config={'context':256,'history_bars':512,'width':192,'heads':6,'planner_layers':3,'decoder_layers':4}
            pool={'symphony-classical':[0]}
            parser=SimpleNamespace(error=lambda message: (_ for _ in ()).throw(ValueError(message)))
            with patch.object(trainer,'sample_midi',sample),patch('builtins.print'):
                trainer.run_training(args,parser,model,random.Random(3),pool,pool,None,None,config,stop)
                first=torch.load(Path(directory)/'state.pt',weights_only=False)
                self.assertEqual(first['step'],1)
                stop.requested=False;args.resume=True
                trainer.run_training(args,parser,model,random.Random(9),pool,pool,None,None,config,stop)
                second=torch.load(Path(directory)/'state.pt',weights_only=False)
            self.assertEqual(second['step'],2)
            self.assertEqual(second['counts']['tasks']['free'],2)
            from four_pillar_v2_runtime import initialize_from_checkpoint
            child=copy.deepcopy(self.model)
            lineage=initialize_from_checkpoint(child,Path(directory)/'state.pt')
            self.assertTrue(lineage['optimizerReset'])
            self.assertEqual(lineage['parentStep'],2)
            for name,value in child.state_dict().items():
                self.assertTrue(torch.equal(value,second['model'][name]),name)

    def test_exact_next_optimizer_update_after_restore(self):
        model=copy.deepcopy(self.model).train()
        optimizer=torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),lr=1e-4)
        rng=random.Random(5)
        cycler=SourceCycler({'a':[0,1,2]},rng)
        item=fixture(1)
        def update():
            cycler.next_index('a')
            inputs,targets,_=make_training_example(item,2,rng,context=128,task='free')
            optimizer.zero_grad(set_to_none=True)
            loss,_=expressive_objective(model(**inputs),targets)
            loss.backward();optimizer.step()
            return float(loss.detach())
        update()
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'state.pt'
            save_checkpoint(pack_state(model,optimizer,rng,cycler,step=1,elapsed=1,
                                       manifest_hash='test'),p)
            baseline=update()
            expected={n:v.clone() for n,v in model.state_dict().items()}
            restore_state(torch.load(p,weights_only=False),model,optimizer,rng,cycler,'test')
            self.assertEqual(update(),baseline)
            for n,v in model.state_dict().items():self.assertTrue(torch.equal(v,expected[n]),n)
            with exclusive_run(Path(directory)):
                with self.assertRaises(RuntimeError):
                    with exclusive_run(Path(directory)):pass

    def test_numeric_conflict_masks_until_next_unambiguous_mark(self):
        labels=SourceLabels.__new__(SourceLabels)
        labels.performance={'fixture':{'events':[
            {'kind':'tempo-qpm','bar':0,'offsetQuarter':'0','value':80,'parts':['a']},
            {'kind':'tempo-qpm','bar':1,'offsetQuarter':'0','value':90,'parts':['a']},
            {'kind':'tempo-qpm','bar':1,'offsetQuarter':'0','value':100,'parts':['b']},
            {'kind':'tempo-qpm','bar':3,'offsetQuarter':'0','value':110,'parts':['a']} ]}}
        _,tempos=labels.expression(fixture().score)
        self.assertEqual(tempos,(80.,None,None,110.,110.))

    def test_changed_midi_content_fails_even_when_filename_is_unchanged(self):
        import four_pillar_v2_integrity as integrity
        from four_pillar_midi_data import sha256
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'same.mid';path.write_bytes(b'original')
            row={'source':'SymphonyNet','name':'same.mid'}
            checker=integrity.SourceIntegrity.__new__(integrity.SourceIntegrity)
            checker.hashes={integrity.key(row):sha256(path)}
            with patch.object(integrity,'source_path',lambda row:path):
                checker.check(row)
                path.write_bytes(b'changed')
                with self.assertRaises(RuntimeError):checker.check(row)


if __name__=='__main__':unittest.main()
