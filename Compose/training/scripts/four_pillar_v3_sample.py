#!/usr/bin/env python3
"""Bounded complete-event sampling; outputs original pitches and explicit drum IDs.
Diagnostic generator, not evidence of musical quality or the deployed v2 API.
"""
import argparse
import json
import math
from fractions import Fraction
from pathlib import Path
import torch
from four_pillar_codec import GROUPS,DYNAMICS,WEDGES
from four_pillar_v3_model import FourPillarStreamingV3
from four_pillar_v3_data import vector

def choice(logits,rng,allowed=None,temperature=1):
    x=logits.flatten().float().clone()
    if allowed is not None:
        mask=torch.zeros_like(x,dtype=torch.bool);mask[allowed]=True;x.masked_fill_(~mask,-torch.inf)
    if not torch.isfinite(x).any():raise ValueError('empty event mask')
    return int(torch.multinomial(torch.softmax(x/temperature,0),1,generator=rng))

def uint_choice(logits,rng,minimum,maximum):
    prefix=0
    for index,row in enumerate(logits.reshape(-1,256)):
        shift=7*index;allowed=[]
        for byte in range(256):
            value=prefix+((byte&127)<<shift)
            if byte<128:
                if minimum<=value<=maximum and (index==0 or byte>0):allowed.append(byte)
            elif index+1<logits.shape[-2] and value+(1<<(shift+7))<=maximum:
                allowed.append(byte)
        byte=choice(row,rng,allowed)
        prefix+=(byte&127)<<shift
        if byte<128:return prefix
    raise ValueError('unterminated time integer')

def exact_fraction(num_logits,den_logits,rng,maximum,positive=False):
    denominator=uint_choice(den_logits,rng,1,3840)
    numerator=uint_choice(num_logits,rng,1 if positive else 0,int(Fraction(maximum)*denominator))
    # Reduction preserves exact performed time. Source targets are canonical.
    return Fraction(numerator,denominator)

class EventStream:
    def __init__(self,model,seed=41977,tempo=92,beats=4,groups=GROUPS):
        self.model=model.eval();self.rng=torch.Generator().manual_seed(seed)
        self.tempo,self.beats=tempo,Fraction(beats);self.groups=tuple(groups)
        if not self.groups or any(g not in GROUPS for g in self.groups):raise ValueError('invalid enabled groups')
        self.caches=None;self.hidden=None;self.absolute=Fraction(0);self.summaries=[]
        with torch.inference_mode():self.hidden,self.caches=model.backbone(torch.zeros(1,1,32))

    def commit(self,event):
        features=torch.tensor([[vector(event,self.absolute,self.beats,self.tempo)]])
        self.hidden,self.caches=self.model.backbone(features,caches=self.caches)

    @torch.inference_mode()
    def next_bar(self,max_notes=128):
        width=self.model.config['width'];history=self.summaries[-self.model.config['history_bars']:]
        if history:
            raw=torch.tensor([history]);plan=self.model.plan_history(raw,torch.ones(raw.shape[:2],dtype=torch.bool))
        else:plan=torch.zeros(1,1,width)
        now=Fraction(0);events=[];summary=[0.]*20
        for _ in range(max_notes):
            base=self.model.heads(self.hidden[:,-1:],plan)
            kind=choice(base['event_kind'],self.rng,[0,1])
            if kind==1:break
            group=choice(base['group'],self.rng,[GROUPS.index(g) for g in self.groups])
            out=self.model.heads(self.hidden[:,-1:],plan,torch.tensor([[group]]))
            # A pitched note needs a strictly positive remaining bar budget.
            if now>=self.beats:break
            delta=exact_fraction(out['delta_num'],out['delta_den'],self.rng,self.beats-now)
            if now+delta>=self.beats:break
            now+=delta
            duration=exact_fraction(out['duration_num'],out['duration_den'],self.rng,min(8,self.beats*2),True)
            pitch=choice(out['pitch'],self.rng,list(range(129)) if GROUPS[group]=='percussion' else list(range(128)))
            drum=pitch==128
            identity=choice(out['drum_identity'],self.rng,list(range(35,82))) if drum else None
            event={'event_kind':0,'group':group,'pitch':pitch,'voice':choice(out['voice'],self.rng),
                   'delta_num':delta.numerator,'delta_den':delta.denominator,
                   'duration_num':duration.numerator,'duration_den':duration.denominator,
                   'velocity':choice(out['velocity'],self.rng,list(range(1,128))),'drum_identity':identity or 0,
                   'dynamic':choice(out['dynamic'],self.rng),'accent':choice(out['accent'],self.rng),'wedge':choice(out['wedge'],self.rng)}
            self.commit(event)
            events.append({'group':GROUPS[group],'pitch':None if drum else pitch,'drum':drum,'drumIdentity':identity,
                'onset':str(now),'duration':str(duration),'voice':event['voice'],'velocity':event['velocity'],
                'dynamic':DYNAMICS[event['dynamic']-1] if event['dynamic'] else None,
                'wedge':WEDGES[event['wedge']-1] if event['wedge'] else None,'accent':event['accent']})
            summary[12+group]+=1
            if not drum:summary[pitch%12]+=1;summary[19]+=pitch
        end_delta=self.beats-now
        end={'event_kind':1,'delta_num':end_delta.numerator,'delta_den':end_delta.denominator}
        self.commit(end)
        n=max(1,len(events));pitched=max(1,sum(not e['drum'] for e in events));summary[:12]=[v/pitched for v in summary[:12]]
        summary[12:18]=[v/n for v in summary[12:18]];summary[18]=math.log1p(len(events))/math.log(129);summary[19]/=pitched*127
        self.summaries.append(summary);self.summaries=self.summaries[-self.model.config['history_bars']:]
        self.absolute+=self.beats
        return {'bar':int(self.absolute/self.beats)-1,'notes':events,'resourceClosure':len(events)==max_notes}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--checkpoint',type=Path,required=True)
    parser.add_argument('--bars',type=int,default=8);parser.add_argument('--seed',type=int,default=41977)
    parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    if not 1<=args.bars<=128:parser.error('bars must be 1..128')
    torch.set_num_threads(2);weights=torch.load(args.checkpoint,map_location='cpu',weights_only=False)
    if weights['schema']!='four-pillar-v3-weights-1':parser.error('requires v3 weights, never v2 checkpoint')
    model=FourPillarStreamingV3(weights['architecture']);model.load_state_dict(weights['model'],strict=True)
    stream=EventStream(model,args.seed);bars=[stream.next_bar() for _ in range(args.bars)]
    args.output.write_text(json.dumps({'schema':'v3-event-audition-1','step':weights['step'],'qualityValidated':False,'bars':bars},indent=2))
    print(json.dumps({'bars':len(bars),'notes':sum(len(b['notes']) for b in bars),'output':str(args.output)}))
if __name__=='__main__':main()
