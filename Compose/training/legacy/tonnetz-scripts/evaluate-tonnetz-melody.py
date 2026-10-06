#!/usr/bin/env python3
"""Compare teacher-forced models on identical held-out real score event prefixes.
Usage: python scripts/evaluate-tonnetz-melody.py --baseline-root OLD_CHECKOUT
This is prediction evaluation, not evidence of listening preference.
"""
import argparse, importlib.util, json
from pathlib import Path
import torch
ROOT=Path(__file__).resolve().parents[1]
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
p=argparse.ArgumentParser();p.add_argument('--baseline-root',type=Path,required=True);a=p.parse_args();torch.set_num_threads(1)
v5=module('v5',ROOT/'scripts/train-tonnetz-melody.py');v4=module('v4',a.baseline_root/'scripts/train-tonnetz-melody.py')
data,meta=v5.load_real(ROOT/'scripts/data/tonnetz-openscore-cc0.json');valid=tuple(t[:,:64] for t in data['validation']);out={}
for name,mod,root,nfeatures in [('v4',v4,a.baseline_root,13),('v5',v5,ROOT,15)]:
 model=mod.MelodyTransformer();model.load_state_dict(torch.load(root/'scripts/tonnetz-melody-training.pt',map_location='cpu',weights_only=True));model.eval()
 aligned=(valid[0][:,:,:nfeatures],*valid[1:]);out[name]=mod.evaluate(model,aligned)
counts=torch.bincount(data['train'][1][data['train'][1]>=0],minlength=25).float()+1
out['trainRealUnigramPitchCE']=float(-(counts/counts.sum()).log()[valid[1][valid[1]>=0]].mean())
out['protocol']={'split':'Composition-level held-out15works','events':'identical first64events of each excerpt','leakage':'no validation compositions in training; these works were used for checkpoint selection, so this is validation, not an untouched test','interpretation':'Teacher-forced prediction only; inferred harmony; no perceptual quality claim'}
(ROOT/'docs/tonnetz-melody-real-comparison.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
