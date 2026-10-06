"""Performance constraints and bounded-context preservation, without training."""
import sys,unittest
from pathlib import Path
from fractions import Fraction
from dataclasses import replace
import torch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from four_pillar_v2_performance import plan_chords,PerformanceCursor
from four_pillar_v2_stream import compact
from score_events_v2 import ScoreEvents
from four_pillar_v2_model import FourPillarExpressiveV2
from four_pillar_v2_inference_cache import install
from four_pillar_v2_decode import Cursor


def prompt():
 return ScoreEvents.from_candidate({'scoreId':'p','parts':[{'id':'p','group':'keys'}],
   'measures':[{'on':str(i*4),'dur':'4','meter':[4,4]} for i in range(4)],
   'notes':[{'on':'0','dur':'13','bar':0,'pitch':60,'part':'p','staff':'1','voice':'1','group':'keys'}]})

class PerformanceTest(unittest.TestCase):
 def test_harmony_planning_independent_of_event_prefix_length(self):
  torch.set_num_threads(1);torch.manual_seed(31)
  model=FourPillarExpressiveV2(history_bars=32,context=256).eval()
  a=Cursor(model,prompt(),torch.Generator().manual_seed(3),1.)
  b=Cursor(model,prompt(),torch.Generator().manual_seed(3),1.)
  for name in ('tokens','feedback','snapshots','timelines'):setattr(b,name,getattr(b,name)[-1:])
  with torch.inference_mode():
   expected,actual=a.predict(),b.predict()
   for head in ('plan','harmony_root','harmony_quality','motif_recall','key_direction','tempo'):
    torch.testing.assert_close(actual[head],expected[head],atol=2e-6,rtol=2e-5)

 def test_forced_choice_skips_model_and_preserves_sampler_rng(self):
  from types import SimpleNamespace
  from four_pillar_codec import NOTE,END_ONSET
  from four_pillar_v2_decode import pick
  class Stub:
   model=SimpleNamespace(performance_policy={'density':.5})
   now=Fraction(0);active=[]
   generator=torch.Generator().manual_seed(17)
   def coverage(self):return {0:Fraction(0),1:Fraction(0),2:Fraction(0)}
   def predict(self):raise AssertionError('Forced choices must not run inference')
  expected=torch.Generator().manual_seed(17)
  pick(torch.zeros(END_ONSET+1),[NOTE],expected,1.)
  stub=Stub()
  self.assertEqual(PerformanceCursor.choose(stub,[NOTE,END_ONSET]),NOTE)
  self.assertTrue(torch.equal(stub.generator.get_state(),expected.get_state()))

 def test_compaction_preserves_held_sound_and_absolute_clock(self):
  result=compact(prompt(),2)
  self.assertEqual([m.onset for m in result.measures],[Fraction(8),Fraction(12)])
  self.assertEqual(result.events[0].onset,Fraction(8));self.assertEqual(result.events[0].end,Fraction(13))
  self.assertEqual(result.events[0].source_index,0);self.assertEqual(result.events[0].bar,0)

 def test_fraction_near_barline_has_legal_progress(self):
  from types import SimpleNamespace
  class Stub:
   model=SimpleNamespace(performance_policy={'spans':[]})
   feedback=[];now=Fraction(0);timelines=[torch.zeros(24)];cached=None
   def uint(self,values):return min(values)
   def force(self,tokens):pass
   def clock(self):return torch.zeros(24)
   def coverage(self):return {0:Fraction(17,96),1:Fraction(1),2:Fraction(1)}
  stub=Stub()
  value=PerformanceCursor.fraction(stub,Fraction(17,96),(1,2,3,4,6,8,12,16,24,32),clock=True)
  self.assertGreater(value,0);self.assertLessEqual(value,Fraction(17,96))
  tiny=PerformanceCursor.fraction(stub,Fraction(1,96),(1,2,3,4,6,8,12,16,24,32),clock=True)
  self.assertEqual(tiny,Fraction(1,96))

 def test_incremental_registry_cache_matches_reference(self):
  from four_pillar_v1_codec import VOICE_CHOICE
  from four_pillar_codec import END_ONSET
  torch.set_num_threads(1);torch.manual_seed(9)
  model=FourPillarExpressiveV2(history_bars=32,context=256).eval();install(model,last_only=True,event_only=True)
  a=Cursor(model,prompt(),torch.Generator().manual_seed(3),1.)
  b=PerformanceCursor(model,prompt(),torch.Generator().manual_seed(3),1.)
  with torch.inference_mode():
   for i in range(260):
    if i==2:
     for c in (a,b):c.feed(VOICE_CHOICE,len(c.registry))
    else:
     for c in (a,b):c.feed(END_ONSET)
    if i in (0,2,3,20,200,259):
     expected,actual=a.predict(),b.predict()
     for head in ('tokens','voice_pointer','midi_velocity'):
      torch.testing.assert_close(actual[head][:,-1],expected[head][:,-1],atol=3e-6,rtol=3e-5)
     # A clock update changes the last row without changing token count.
     for c in (a,b):c.timelines[-1]=c.timelines[-1]+.01;c.cached=None
     expected,actual=a.predict(),b.predict()
     for head in ('tokens','voice_pointer','midi_velocity'):
      torch.testing.assert_close(actual[head][:,-1],expected[head][:,-1],atol=3e-6,rtol=3e-5)

 def test_last_token_fast_path_matches_full_heads(self):
  import copy
  from four_pillar_codec import ONSET,END_ONSET
  torch.set_num_threads(1);torch.manual_seed(8)
  base=FourPillarExpressiveV2(history_bars=32,context=256).eval()
  fast=copy.deepcopy(base);install(fast,last_only=True,event_only=True)
  a=Cursor(base,prompt(),torch.Generator().manual_seed(3),1.)
  b=Cursor(fast,prompt(),torch.Generator().manual_seed(3),1.)
  with torch.inference_mode():
   for token in (None,ONSET,END_ONSET):
    if token is not None:a.feed(token);b.feed(token)
    expected,actual=a.predict(),b.predict()
    for head in ('tokens','voice_pointer','midi_velocity'):
     torch.testing.assert_close(actual[head][:,-1],expected[head][:,-1],atol=3e-6,rtol=3e-5)

 def test_event_cache_matches_original_with_new_voice_eviction_and_conditions(self):
  import copy
  from four_pillar_v1_codec import VOICE_CHOICE
  from four_pillar_codec import END_ONSET,GROUP_BASE
  torch.set_num_threads(1);torch.manual_seed(15)
  base=FourPillarExpressiveV2(history_bars=32,context=256).eval()
  fast=copy.deepcopy(base);install(fast,last_only=True,event_only=True)
  a=Cursor(base,prompt(),torch.Generator().manual_seed(3),1.)
  b=Cursor(fast,prompt(),torch.Generator().manual_seed(3),1.)
  with torch.inference_mode():
   for i in range(260):
    for c in (a,b):
     if i==2:c.feed(VOICE_CHOICE,len(c.registry))
     elif i==3:c.feed(GROUP_BASE+3,group=(len(c.registry)-1,'keys'))
     else:c.feed(END_ONSET)
     if i==20:
      c.conditions.update(log_qpm=torch.tensor([4.5]),tempo_known=torch.tensor([True]));c.cached=None
     if i==22:
      c.conditions['allowed_groups']=torch.tensor([[True]*6]);c.cached=None
     if i==23:c.conditions.pop('allowed_groups');c.cached=None
    if i in (0,2,3,20,21,22,23,200,259):
     expected,actual=a.predict(),b.predict()
     for head in ('tokens','voice_pointer','midi_velocity','numeric_dynamic','harmony_root','harmony_quality'):
      torch.testing.assert_close(actual[head][:,-1],expected[head][:,-1],atol=3e-6,rtol=3e-5)

 def test_real_model_cached_cursor_logits_and_harmony_controls(self):
  torch.set_num_threads(1);torch.manual_seed(7)
  model=FourPillarExpressiveV2(history_bars=32,context=256).eval()
  rng=torch.Generator().manual_seed(7)
  with torch.inference_mode():
   ordinary=Cursor(model,prompt(),rng,1.).predict()
   install(model)
   cached=Cursor(model,prompt(),rng,1.).predict()
   for head in ('tokens','voice_pointer','harmony_root','harmony_quality','midi_velocity'):
    torch.testing.assert_close(cached[head],ordinary[head],atol=3e-6,rtol=3e-5)
   options={'beats':4,'key':{'tonic':0,'mode':'major'},'tempo':92,'mode':'hold','changeMode':'bar','harmonyT':.8,'fixed':[]}
   spans,_,last,age=plan_chords(model,prompt(),rng,options,{'root':0,'q':0},Fraction(0))
   self.assertEqual(len(spans),1);self.assertEqual(last,{'root':0,'q':0})
   options['mode']='auto';options['changeMode']='bar'
   spans,_,last,_=plan_chords(model,prompt(),rng,options,{'root':0,'q':0},Fraction(0))
   self.assertEqual(len(spans),1);self.assertNotEqual(last,{'root':0,'q':0})
   options['changeMode']='free';options['fixed']=[{'offset':2,'root':7,'q':0,'bassPc':11}]
   spans,_,_,_=plan_chords(model,prompt(),rng,options,{'root':0,'q':0},Fraction(8))
   self.assertTrue(spans[0]['change']);self.assertTrue(all(Fraction(s['offset']).denominator==1 for s in spans))
   self.assertEqual(next(s for s in spans if s['offset']=='2')['bassPc'],11)

if __name__=='__main__':unittest.main()
