"""Representation checks: repeated attacks, rests, register and work split."""
import importlib.util, json, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('training',Path(__file__).resolve().parents[1]/'scripts/train_melody.py');t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
class CorpusRepresentation(unittest.TestCase):
 def load(self,transform=lambda n:n):
  records=[]
  for split in ['train','validation']:
   notes=transform([{'onset':bar*4+beat,'duration':1,'midi':60+(2 if beat==1 else 0)} for bar in range(8) for beat in range(3)])
   records.append({'scoreId':split,'workId':split,'split':split,'key':{'tonic':0,'mode':'major'},'beatsPerBar':4,'notes':notes,'bars':[{'onset':i*4,'duration':4} for i in range(8)],'chords':[{'onset':i*4,'root':0,'quality':'maj','pcs':[0,4,7]} for i in range(8)]})
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'data.json';p.write_text(json.dumps({'records':records}));return t.load_real(p)
 def test_pitch_intervals_attacks_and_explicit_rests(self):
  data,meta=self.load();x,y,d,n=data['train'];self.assertEqual(meta['excerpts']['train'],1)
  self.assertEqual(y[0,:4].tolist(),[12,14,12,24]);self.assertEqual(d[0,:4].tolist(),[3,3,3,3]);self.assertEqual(int((y>=0).sum()),32)
 def test_repeated_pitch_keeps_distinct_attacks(self):
  data,_=self.load(lambda notes:[dict(n,midi=60) for n in notes]);self.assertEqual(data['train'][1][0,:4].tolist(),[12,12,12,24])
 def test_range_is_rejected_instead_of_octave_folding(self):
  _,meta=self.load(lambda notes:[dict(n,midi=90 if i==2 else n['midi']) for i,n in enumerate(notes)]);self.assertEqual(meta['excerpts']['train'],0)
if __name__=='__main__':unittest.main()
