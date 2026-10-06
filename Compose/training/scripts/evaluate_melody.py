#!/usr/bin/env python3
"""Evaluate the bundled melody checkpoint on held-out real-score event prefixes.
These works were used for checkpoint selection, so this is validation, not an
untouched test or evidence of listening preference.
"""
import argparse, importlib.util, json
from pathlib import Path
import torch
ROOT=Path(__file__).resolve().parents[1]
def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--checkpoint',type=Path,default=ROOT/'checkpoints/melody-v5.pt')
 p.add_argument('--corpus',type=Path,default=ROOT/'data/openscore-cc0.json')
 p.add_argument('--output',type=Path,default=ROOT/'reports/current-melody-evaluation.json')
 args=p.parse_args();torch.set_num_threads(1)
 spec=importlib.util.spec_from_file_location('training',ROOT/'scripts/train_melody.py')
 training=importlib.util.module_from_spec(spec);spec.loader.exec_module(training)
 data,meta=training.load_real(args.corpus)
 valid=tuple(t[:,:64] for t in data['validation'])
 model=training.MelodyTransformer()
 model.load_state_dict(torch.load(args.checkpoint,map_location='cpu',weights_only=True));model.eval()
 counts=torch.bincount(data['train'][1][data['train'][1]>=0],minlength=25).float()+1
 out={'current':training.evaluate(model,valid),'trainRealUnigramPitchCE':float(-(counts/counts.sum()).log()[valid[1][valid[1]>=0]].mean()),'protocol':{'events':'identical first 64 events per held-out excerpt','works':meta['worksUsed'],'excerpts':meta['excerpts'],'interpretation':'Validation used for checkpoint selection; inferred harmony; no perceptual quality claim'}}
 args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
if __name__=='__main__':main()
