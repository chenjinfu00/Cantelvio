#!/usr/bin/env python3
"""Offline free continuation from a v2 checkpoint; does not use future rhythm."""
import argparse
import json
from pathlib import Path

import torch

from four_pillar_midi_data import slice_score
from four_pillar_score_index import open_index,get_score
from four_pillar_v2_model import FourPillarExpressiveV2
from four_pillar_v2_decode import generate
from four_pillar_v2_export import export


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoint',type=Path,required=True)
    p.add_argument('--score-id',required=True)
    p.add_argument('--prompt-bars',type=int,default=4)
    p.add_argument('--bars',type=int,default=4)
    p.add_argument('--seed',type=int,default=1)
    p.add_argument('--qpm',type=float,default=90)
    p.add_argument('--tempo-mode',choices=('fixed','walk'),default='fixed')
    p.add_argument('--temperature',type=float,default=0.9)
    p.add_argument('--max-notes',type=int,default=128)
    p.add_argument('--output-dir',type=Path,required=True)
    args=p.parse_args()
    if args.output_dir.exists():p.error('output directory must be new')
    manifest=json.loads(args.checkpoint.with_name('manifest.json').read_text())
    if manifest['schema']!='four-pillar-v2-complete-training-paths-2':
        p.error('checkpoint is not the revised v2 architecture')
    torch.set_num_threads(4)
    state=torch.load(args.checkpoint,map_location='cpu',weights_only=False)
    from four_pillar_midi_data import sha256
    if state['manifestSha256']!=sha256(args.checkpoint.with_name('manifest.json')):
        p.error('checkpoint and manifest do not match')
    model=FourPillarExpressiveV2(**manifest['runConfig']['architecture'])
    model.load_state_dict(state['model'],strict=True)
    root=Path(__file__).resolve().parents[1]
    db=open_index(root/'data/four-pillar-score-all-train-v1.sqlite')
    try:score=get_score(db,args.score_id)
    finally:db.close()
    if not 1<=args.prompt_bars<=len(score.measures):p.error('invalid prompt length')
    prompt=slice_score(score,0,args.prompt_bars)
    result,audit=generate(model,prompt,bars=args.bars,seed=args.seed,
                          temperature=args.temperature,qpm=args.qpm,
                          tempo_mode=args.tempo_mode,max_notes=args.max_notes)
    audit['checkpointSha256']=sha256(args.checkpoint)
    audit['promptSource']=args.score_id
    audit['evaluationStatus']='training-source prompt; not held-out quality evidence'
    print(json.dumps({'output':str(args.output_dir),'midiAudit':export(result,audit,args.output_dir)},ensure_ascii=False))


if __name__=='__main__':main()
