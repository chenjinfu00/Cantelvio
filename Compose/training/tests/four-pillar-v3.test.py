import unittest,sys,pathlib,torch
from fractions import Fraction
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from four_pillar_v3_model import FourPillarStreamingV3,CONFIG
from four_pillar_v3_data import make_batch,integer_bytes,fraction_fields
from four_pillar_v3_sample import uint_choice,exact_fraction,EventStream
from score_events_v2 import ScoreEvents

class V3Tests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(2);torch.manual_seed(99)
        self.config={**CONFIG,'width':32,'heads':4,'layers':2,'planner_layers':1,'history_bars':8,'window':8}
        self.model=FourPillarStreamingV3(self.config).eval()
    def score(self):
        return ScoreEvents.from_candidate({'scoreId':'test','parts':[{'id':'w','group':'woodwinds'},{'id':'d','group':'percussion'}],
        'measures':[{'on':'0','dur':'4','meter':[4,4]},{'on':'4','dur':'4','meter':[4,4]}],
        'notes':[{'on':'0','dur':'1','bar':0,'pitch':60,'part':'w','staff':'1','voice':'1','group':'woodwinds'},
                 {'on':'4','dur':'1919/480','bar':1,'pitch':67,'part':'w','staff':'1','voice':'1','group':'woodwinds'},
                 {'on':'13/3','dur':'1/3','bar':1,'pitch':None,'part':'d','staff':'1','voice':'1','group':'percussion','unpitched':True}]})
    def test_exact_time_and_original_drum_identity(self):
        batch=make_batch(self.score(),1,velocities={2:88},drums={2:42},config=self.config)
        self.assertEqual(fraction_fields(Fraction(1919,480),self.config),(1919,480))
        self.assertEqual(integer_bytes(480,self.config)[:2],[224,3])
        self.assertEqual(int(batch['known']['drum_identity'].sum()),1)
        self.assertIn(42,batch['targets']['drum_identity'].flatten().tolist())
        loss,report=self.model.loss(batch);loss.backward();self.assertTrue(torch.isfinite(loss))
        self.assertTrue(all(torch.isfinite(p.grad).all() for p in self.model.parameters() if p.grad is not None))
    def test_unknown_drum_and_velocity_stay_masked(self):
        batch=make_batch(self.score(),1,config=self.config)
        self.assertEqual(int(batch['known']['drum_identity'].sum()),0)
        self.assertEqual(int(batch['known']['velocity'].sum()),0)
        self.assertEqual(int(batch['known']['harmony_root'].sum()),0)
    def test_streaming_parity_and_plan_independence(self):
        events=torch.randn(1,20,32)
        with torch.no_grad():
            full,_=self.model.backbone(events);cache=None;rows=[]
            for i in range(20):
                row,cache=self.model.backbone(events[:,i:i+1],caches=cache);rows.append(row)
            torch.testing.assert_close(torch.cat(rows,1),full,atol=2e-6,rtol=2e-5)
            before=[layer[0].clone() for layer in cache]
            self.model.heads(rows[-1],torch.randn(1,1,32),torch.tensor([[2]]))
            for old,new in zip(before,cache):self.assertTrue(torch.equal(old,new[0]))
    def test_bounded_unsigned_time_never_rounds_or_overflows(self):
        rng=torch.Generator().manual_seed(2);logits=torch.randn(10,256)
        for _ in range(20):
            value=uint_choice(logits,rng,1,3840);self.assertTrue(1<=value<=3840)
            result=exact_fraction(logits,logits,rng,Fraction(1,3),True)
            self.assertTrue(0<result<=Fraction(1,3))
    def test_event_kind_is_independent_of_teacher_group(self):
        hidden=torch.randn(1,1,32);plan=torch.randn(1,1,32)
        a=self.model.heads(hidden,plan,torch.tensor([[0]]));b=self.model.heads(hidden,plan,torch.tensor([[5]]))
        torch.testing.assert_close(a['event_kind'],b['event_kind'])
    def test_live_sampler_cache_and_native_groups(self):
        stream=EventStream(self.model,groups=['keys'],beats=4)
        for _ in range(3):
            bar=stream.next_bar(max_notes=4)
            self.assertTrue(all(n['group']=='keys' and not n['drum'] and 0<=n['pitch']<=127 and 0<=Fraction(n['onset'])<4 and Fraction(n['duration'])>0 for n in bar['notes']))
            self.assertLessEqual(stream.caches[0][0].shape[2],8)
        self.assertEqual(stream.absolute,12)

if __name__=='__main__':unittest.main()
