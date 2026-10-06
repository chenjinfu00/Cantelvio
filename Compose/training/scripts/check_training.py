#!/usr/bin/env python3
"""Verify bundled training inputs, both model forwards/backwards and export parity.
Optionally reconstruct a Harmony state_dict from the deployed, rounded JS weights.
No training loop or live runtime weight replacement is performed.
"""
import argparse,importlib.util,json,hashlib
from pathlib import Path
import torch
ROOT=Path(__file__).resolve().parents[1]
PROJECT=ROOT.parent

def load_module(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/f'{name}.py')
 mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod

def read_weights(name):
 source=(PROJECT/'vendor/lib'/name).read_text()
 return json.loads(source.split(' = ',1)[1].strip().removesuffix(';'))

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--restore-harmony',action='store_true');a=p.parse_args();torch.set_num_threads(1)
 harmony=load_module('train_harmony');melody=load_module('train_melody')
 hw=read_weights('harmony-transformer.js');mw=read_weights('melody-transformer-weights.js')
 h=harmony.HarmonyTransformer();state={}
 for name in ['root','quality','inversion','mode','style','position']:state[name+'.weight']=torch.tensor(hw[name+'Embedding'])
 for i,block in enumerate(hw['blocks']):
  for layer,params in block.items():
   for key,value in params.items():state[f'blocks.{i}.{layer}.{key}']=torch.tensor(value)
 for source,destination in [('lnFinal','ln_final'),('output','output'),('inversionOutput','inv_output')]:
  for key,value in hw[source].items():state[destination+'.'+key]=torch.tensor(value)
 h.load_state_dict(state);h.eval();h_error=0.
 with torch.no_grad():
  for probe in hw['parityProbes']:
   logits,_,_,_=h(torch.tensor([probe['tokens']]),torch.tensor([probe['inversions']]),torch.tensor([probe['mode']]),torch.tensor([probe['style']]))
   h_error=max(h_error,float((logits[0,-1]-torch.tensor(probe['logits'])).abs().max()))
 assert h_error<1e-4,h_error
 m=melody.MelodyTransformer();m.load_state_dict(torch.load(ROOT/'checkpoints/melody-v5.pt',weights_only=True,map_location='cpu'));m.eval();m_error=0.
 with torch.no_grad():
  for probe in mw['parityProbes']:
   pitch,duration,affinity,_=m(torch.tensor([probe['features']]),torch.tensor([probe['nextChord']]))
   for actual,key in [(pitch,'pitch'),(duration,'duration'),(affinity,'affinity')]:m_error=max(m_error,float((actual[0]-torch.tensor(probe[key])).abs().max()))
 assert m_error<1e-4,m_error
 data,metadata=melody.load_real(ROOT/'data/openscore-cc0.json')
 assert metadata['worksUsed']==mw['training']['realCorpus']['worksUsed'],metadata['worksUsed']
 # One backward pass checks that both shipped training implementations remain usable.
 h.train();hd,_=harmony.dataset(4,harmony.SEED,harmony.TRAIN);hl=harmony.loss_on(h,hd);hl.backward();assert torch.isfinite(hl)
 m.train();md,_=melody.dataset(4,melody.SEED);ml=melody.losses(m,md,torch.arange(4));ml.backward();assert torch.isfinite(ml)
 if a.restore_harmony:torch.save(state,ROOT/'checkpoints/harmony-from-browser-v2.pt')
 source=json.loads((ROOT/'data/sources/SOURCE.json').read_text());archive=ROOT/'data/sources'/source['archive'];assert hashlib.sha256(archive.read_bytes()).hexdigest()==source['sha256']
 print(json.dumps({'harmonyParameters':sum(p.numel() for p in h.parameters()),'melodyParameters':sum(p.numel() for p in m.parameters()),'harmonyProbeMaxError':h_error,'melodyProbeMaxError':m_error,'realWorks':metadata['worksUsed'],'realExcerpts':metadata['excerpts'],'backwardPasses':2,'rawArchiveSHA256':'verified','harmonyCheckpointReconstructed':a.restore_harmony},indent=2))
if __name__=='__main__':main()
