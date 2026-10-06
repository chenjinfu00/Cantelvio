#!/usr/bin/env python3
"""Separate v3 migration/new-run training. Never overwrites v2 weights or optimizer."""
import argparse
import json
import math
import random
import time
from pathlib import Path
import torch
from four_pillar_v2_examples import SourceLabels,LABELS,JOINT
from four_pillar_v3_model import FourPillarStreamingV3,CONFIG
from four_pillar_v3_data import make_batch,load_midi
from four_pillar_midi_data import ROOT,sha256,verify_manifest
from four_pillar_score_index import get_score,index_rows,open_index
from four_pillar_v2_integrity import SourceIntegrity,FINGERPRINTS
from four_pillar_v2_runtime import exclusive_run,StopAtBoundary,save_checkpoint
from train_four_pillar_v1_all_data import SourceCycler

MIX={'symphony-classical':.20,'symphony-contemporary':.35,'curated-midi':.10,'Lieder':.20,'classical-scores':.15}
CODE=('four_pillar_v3_model.py','four_pillar_v3_data.py','train_four_pillar_v3.py','four_pillar_v3_sample.py')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--init-checkpoint',type=Path)
    parser.add_argument('--resume',action='store_true')
    parser.add_argument('--initialize-only',action='store_true',help='save migrated step-zero state without training')
    parser.add_argument('--preflight',action='store_true')
    parser.add_argument('--max-seconds',type=float,default=39600)
    parser.add_argument('--steps',type=int,default=0,help='optional limit on additional complete optimizer steps')
    parser.add_argument('--threads',type=int,default=4)
    parser.add_argument('--seed',type=int,default=20261001)
    parser.add_argument('--lr',type=float,default=1e-4)
    parser.add_argument('--context',type=int,default=256)
    parser.add_argument('--checkpoint-seconds',type=float,default=300)
    args=parser.parse_args()
    if args.resume and (args.preflight or args.init_checkpoint or args.initialize_only):parser.error('resume is separate from parent initialization/preflight')
    if args.threads<1 or args.steps<0 or not 16<=args.context<=256 or any(not math.isfinite(n) or n<=0 for n in (args.lr,args.max_seconds,args.checkpoint_seconds)):parser.error('invalid config')
    if not args.output_dir.resolve().is_relative_to((ROOT/'runs').resolve()):parser.error('output must be under training/runs')
    if args.init_checkpoint and args.init_checkpoint.resolve().is_relative_to(args.output_dir.resolve()):parser.error('parent must be outside new run')
    torch.set_num_threads(args.threads);torch.manual_seed(args.seed);rng=random.Random(args.seed+1)
    membership=ROOT/'data/four-pillar-midi-all-train-v1.json';index=ROOT/'data/four-pillar-score-all-train-v1.sqlite'
    frozen=json.loads(membership.read_text());verify_manifest(frozen);integrity=SourceIntegrity(frozen)
    db=open_index(index)
    try:
        rows=frozen['rows'];pool={
            'symphony-classical':[r for r in rows if r['source']=='SymphonyNet' and '/classical/' in r['name']],
            'symphony-contemporary':[r for r in rows if r['source']=='SymphonyNet' and '/contemporary/' in r['name']],
            'curated-midi':[r for r in rows if r['source']=='MIDI-Library']}
        pool.update({s:index_rows(db,source=s,split='train') for s in ('Lieder','classical-scores')})
        cycler=SourceCycler(pool,rng);model=FourPillarStreamingV3();labels=SourceLabels()
        transfer=None
        if args.init_checkpoint:
            state=torch.load(args.init_checkpoint,map_location='cpu',weights_only=False)
            if state['manifestSha256']!=sha256(args.init_checkpoint.parent/'manifest.json'):raise ValueError('parent checkpoint/manifest mismatch')
            if not all(torch.isfinite(t).all() for t in state['model'].values()):raise FloatingPointError('nonfinite parent')
            if state['schema']=='four-pillar-v2-state-2':
                transfer=model.initialize_v2(state)
            elif state['schema']=='four-pillar-v3-state-1':
                parent_manifest=json.loads((args.init_checkpoint.parent/'manifest.json').read_text())
                if parent_manifest['architecture']!=CONFIG:raise ValueError('v3 parent architecture changed')
                model.load_state_dict(state['model'],strict=True)
                transfer={'parentStep':int(state['step']),'copiedParameters':sum(p.numel() for p in model.parameters()),
                          'totalParameters':sum(p.numel() for p in model.parameters()),'optimizerReset':True,
                          'strictResumeCompatible':False,'initializationKind':'v3 weights only; new run'}
            else:raise ValueError('unsupported parent checkpoint schema')
            transfer.update(parentCheckpointSha256=sha256(args.init_checkpoint),parentPath=str(args.init_checkpoint.resolve()))
        code={n:sha256(ROOT/'scripts'/n) for n in CODE}
        code['streaming_event_model.py']=sha256(ROOT/'experiments/streaming_event_model.py')
        # Dependency hashes also protect exact-source loading and resume semantics.
        for n in ('four_pillar_midi_data.py','four_pillar_score_index.py','score_events_v2.py','four_pillar_trial_data.py','orchestra_midi_groups.py','four_pillar_v2_integrity.py','train_four_pillar_v1_all_data.py','four_pillar_v2_runtime.py','four_pillar_v2_examples.py','four_pillar_v1_alignment.py','joint_data.py'):code[n]=sha256(ROOT/'scripts'/n)
        manifest={'schema':'four-pillar-v3-training-1','architecture':CONFIG,'seed':args.seed,'lr':args.lr,
                  'context':args.context,'sourceHashes':{'membership':sha256(membership),'index':sha256(index),'fingerprints':sha256(FINGERPRINTS),'labels':sha256(LABELS),'joint':sha256(JOINT)},
                  'codeSha256':code,'transfer':transfer,'sourceCounts':{s:len(r) for s,r in pool.items()},
                  'allTrainingSources':True,'qualityValidated':False,'runtimeDeployed':False}
        optimizer=torch.optim.AdamW(model.parameters(),lr=args.lr,weight_decay=.01)
        step=0;elapsed_before=0.;counts={s:0 for s in pool};rejected={}
        def sample(source):
            for _ in range(30):
                row=pool[source][cycler.next_index(source)]
                try:
                    if source in ('Lieder','classical-scores'):
                        score=get_score(db,row[0]);velocities=drums={};tempos=None
                    else:
                        integrity.check(row);score,velocities,drums,tempos=load_midi(row)
                    if len(score.measures)<2:raise ValueError('fewer than two bars')
                    target=rng.randrange(1,len(score.measures))
                    harmony={}
                    if source=='Lieder':
                        rows_for_bar=[r for r in labels.harmony(score,0,target,0) if r[0]==0]
                        if len(rows_for_bar)==1 and rows_for_bar[0][1]==0:
                            _,_,root,quality=rows_for_bar[0];harmony[target]=(root,quality)
                    # Dense bars train their beginning, middle and end, with only
                    # bounded past event rows retained alongside 512 bar summaries.
                    count=sum(n.bar==target and not n.grace for n in score.events)+1
                    return make_batch(score,target,velocities,drums,tempos,args.context,
                                      harmony=harmony,target_count=rng.randrange(1,count+1))
                except (ValueError,IndexError,OverflowError) as error:
                    reason=str(error);rejected[reason]=rejected.get(reason,0)+1
            raise ValueError('30 rejected examples from '+source+'; '+json.dumps(rejected))
        if args.preflight:
            coverage={}
            for source in pool:
                batch=sample(source);loss,objectives=model.loss(batch);loss.backward()
                if not all(torch.isfinite(p.grad).all() for p in model.parameters() if p.grad is not None):raise FloatingPointError('nonfinite preflight gradient')
                model.zero_grad(set_to_none=True);coverage[source]={'loss':float(loss.detach()),'events':batch['events'].shape[1],'objectives':objectives}
            print(json.dumps({'phase':'preflight','parameters':sum(p.numel() for p in model.parameters()),'transfer':transfer,'sources':coverage,'rejected':rejected,'noWeightUpdate':True}),flush=True);return
        path=args.output_dir
        if args.resume:
            previous=json.loads((path/'manifest.json').read_text())
            # Parent migration is recorded once, not re-applied on resume.
            manifest['transfer']=previous['transfer']
            if previous!=manifest:raise ValueError('source/code/config changed; refusing v3 resume')
        else:path.mkdir(parents=True,exist_ok=False)
        with exclusive_run(path),StopAtBoundary() as stop:
            if args.resume:
                state=torch.load(path/'state.pt',map_location='cpu',weights_only=False)
                if state['schema']!='four-pillar-v3-state-1' or state['manifestSha256']!=sha256(path/'manifest.json'):raise ValueError('not this v3 checkpoint')
                model.load_state_dict(state['model'],strict=True);optimizer.load_state_dict(state['optimizer'])
                torch.set_rng_state(state['torchRng']);rng.setstate(state['pythonRng']);cycler.load_state_dict(state['sourceCycler'])
                step=state['step'];elapsed_before=state['elapsedSeconds'];counts=state['counts'];rejected=state['rejected']
            else:(path/'manifest.json').write_text(json.dumps(manifest,indent=2))
            started=time.monotonic();initial_step=step
            def elapsed():return elapsed_before+time.monotonic()-started
            def save():
                save_checkpoint({'schema':'four-pillar-v3-state-1','model':model.state_dict(),'optimizer':optimizer.state_dict(),
                    'step':step,'elapsedSeconds':elapsed(),'manifestSha256':sha256(path/'manifest.json'),'pythonRng':rng.getstate(),
                    'torchRng':torch.get_rng_state(),'sourceCycler':cycler.state_dict(),'counts':counts,'rejected':rejected},path/'state.pt')
                save_checkpoint({'schema':'four-pillar-v3-weights-1','architecture':CONFIG,'model':model.state_dict(),
                    'step':step,'manifestSha256':sha256(path/'manifest.json'),'qualityValidated':False},path/'weights.pt')
            if not args.resume:save()
            last=time.monotonic()
            while not args.initialize_only and elapsed()<args.max_seconds and not stop.requested and (not args.steps or step-initial_step<args.steps):
                source=rng.choices(tuple(pool),weights=[MIX[s] for s in pool])[0];batch=sample(source)
                optimizer.zero_grad(set_to_none=True)
                for group in optimizer.param_groups:group['lr']=args.lr*min(1,(step+1)/100)
                loss,coverage=model.loss(batch);loss.backward()
                gradient=nn_clip(model)
                optimizer.step();step+=1;counts[source]+=1
                row={'step':step,'source':source,'loss':float(loss.detach()),'gradient':gradient,'elapsedSeconds':elapsed(),'objectives':coverage}
                with (path/'metrics.jsonl').open('a') as stream:stream.write(json.dumps(row)+'\n')
                if step%25==0:print(json.dumps(row),flush=True)
                if time.monotonic()-last>=args.checkpoint_seconds:save();last=time.monotonic()
            save();print(json.dumps({'phase':'saved','step':step,'parameters':sum(p.numel() for p in model.parameters()),'weightsBytes':(path/'weights.pt').stat().st_size,'checkpointBytes':(path/'state.pt').stat().st_size,'counts':counts,'rejected':rejected,'runtimeUnchanged':True}),flush=True)
    finally:db.close()

def nn_clip(model):
    gradient=torch.nn.utils.clip_grad_norm_(model.parameters(),1.)
    if not torch.isfinite(gradient):raise FloatingPointError('nonfinite gradient; preceding checkpoint retained')
    return float(gradient)

if __name__=='__main__':main()
