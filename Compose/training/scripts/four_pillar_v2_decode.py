"""Bounded offline autoregressive score decoder; no copied rhythm scaffold.

Grammar and caller resources constrain sampling. Exact fractions are sampled
as canonical byte sequences. No generated note is committed before its onset
slice is complete. The model is not presumed musically competent.
"""
from __future__ import annotations

import math
from dataclasses import replace
from fractions import Fraction

import torch

from four_pillar_codec import (ACCENT_BASE, BAR, BOS, DYNAMIC_BASE, DYNAMICS,
    END_BAR, END_ONSET, END_SCORE, GRACE_NO, GRACE_YES, GROUP_BASE, GROUPS,
    NONE, NOTE, ONSET, PITCH_BASE, ROLE_BASE, ROLES, UNPITCHED, WEDGE_BASE, WEDGES,
    _fraction, _label, _uint)
from four_pillar_v1_codec import VOICE_CHOICE, encode_dynamic_score, causal_teacher_forcing_inputs
from four_pillar_v1_pilot_data import PairedScore
from four_pillar_trial_data import summarize_bars
from four_pillar_v2_examples import timeline_features
from four_pillar_v2_data import add_motif_targets
from score_events_v2 import Measure, NoteEvent, Part


def pick(logits, choices, generator, temperature):
    if not choices or not math.isfinite(temperature) or temperature <= 0:
        raise ValueError('invalid sampling choices or temperature')
    values = logits[choices].float() / temperature
    if not torch.isfinite(values).all() or (values <= torch.finfo(values.dtype).min/2).all():
        raise ValueError('no finite permitted model choice')
    index = torch.multinomial(torch.softmax(values,dim=0),1,generator=generator).item()
    return choices[index]


class Cursor:
    def __init__(self, model, score, generator, temperature, conditions=None):
        self.model,self.score,self.generator,self.temperature=model,score,generator,temperature
        self.context=model.score.config['context']
        self.history_bars=model.score.config['history_bars']
        encoded=encode_dynamic_score(score)
        start=max(0,len(encoded.tokens)-1-self.context)
        start=next((i for i in range(start,len(encoded.tokens)-1)
                    if i==0 or encoded.tokens[i] in (END_ONSET,END_BAR)),start)
        teacher=causal_teacher_forcing_inputs(encoded,start=start)
        self.tokens=teacher['decoder_input'][0].tolist()
        self.feedback=teacher['voice_pointer_input'][0].tolist()
        self.snapshots=[teacher['voice_features'][0,i,:int(teacher['voice_known'][0,i].sum())].clone()
                        for i in range(len(self.tokens))]
        self.registry=self.snapshots[-1].clone()
        self.identities=list(encoded.voice_definitions)
        item=PairedScore(score,None,encoded,summarize_bars(score),())
        self.timelines=list(timeline_features(item,start,len(encoded.tokens)-1)[0])
        self.active=list(score.events)
        self.now=score.measures[-1].onset+score.measures[-1].duration
        self.bar_on=self.now
        self.duration=score.measures[-1].duration
        self.conditions=dict(conditions or {})
        self.memory_inputs=None
        self.cached=None

    def clock(self):
        self.active=[n for n in self.active if n.end>self.now]
        row=torch.zeros(24)
        pitches=[n.pitch for n in self.active if n.pitch is not None]
        for p in pitches:row[p%12]+=1/len(pitches)
        for n in self.active:
            if n.group in GROUPS:row[12+GROUPS.index(n.group)]+=1/max(len(self.active),1)
        row[18]=math.log1p(len(self.active))/math.log(129)
        row[19]=sum(pitches)/max(len(pitches),1)/127
        row[20]=float((self.now-self.bar_on)/self.duration)
        row[21]=math.log1p(float(self.duration))/4
        row[22]=math.log1p(max((float(n.end-self.now) for n in self.active),default=0))/8
        row[23]=bool(self.active)
        return row

    def feed(self, token, pointer=-1, *, group=None, role=None, note=None, clock=None):
        self.snapshots.append(self.registry.clone())
        self.tokens.append(int(token));self.feedback.append(pointer)
        if token==VOICE_CHOICE and pointer==len(self.registry):
            row=torch.zeros(1,16);row[0,-1]=1
            self.registry=torch.cat((self.registry,row))
        if group is not None:
            voice,name=group
            self.registry[voice,:6]=0
            if name in GROUPS:self.registry[voice,GROUPS.index(name)]=1
        if role is not None:
            voice,name=role
            self.registry[voice,6:14]=0
            if name in ROLES:self.registry[voice,6+ROLES.index(name)]=1
        if clock is not None:self.now,self.bar_on,self.duration=clock
        if note is not None:self.active.append(note)
        self.timelines.append(self.clock())
        self.cached=None
        # Evict complete preceding slices. A single oversized onset is an
        # explicit resource failure, never a truncated polyphonic chord.
        if len(self.tokens)>self.context:
            excess=len(self.tokens)-self.context
            boundary=next((i for i in range(excess,len(self.tokens))
                           if self.tokens[i] in (END_ONSET,END_BAR)),None)
            if boundary is None:
                raise ValueError('generated onset exceeds context resource limit')
            for name in ('tokens','feedback','snapshots','timelines'):
                setattr(self,name,getattr(self,name)[boundary:])

    def force(self,tokens,**kwargs):
        for i,token in enumerate(tokens):self.feed(token,**kwargs if i==len(tokens)-1 else {})

    def predict(self):
        if self.cached is not None:return self.cached
        length=len(self.tokens);n=len(self.registry)
        features=torch.zeros(1,length,n,16);known=torch.zeros(1,length,n,dtype=torch.bool)
        for i,rows in enumerate(self.snapshots):
            features[0,i,:len(rows)]=rows;known[0,i,:len(rows)]=True
        if self.memory_inputs is None:
            summary=summarize_bars(self.score)
            history=torch.zeros(1,self.history_bars,20);count=min(self.history_bars,len(summary))
            history[0,:count]=torch.from_numpy(summary[-count:])
            self.memory_inputs=dict(history=history,history_known=torch.arange(self.history_bars)[None]<count)
            m=Measure(len(self.score.measures),self.bar_on,self.duration,self.score.measures[-1].meter,False,None)
            future=replace(self.score,measures=self.score.measures+(m,))
            item=PairedScore(future,None,encode_dynamic_score(future),summarize_bars(future),())
            add_motif_targets(item,self.memory_inputs,{},m.index,history_bars=self.history_bars)
        inputs=dict(**self.memory_inputs,
                    decoder_input=torch.tensor([self.tokens]),voice_features=features,
                    voice_known=known,voice_pointer_input=torch.tensor([self.feedback]),
                    timeline=torch.stack(self.timelines)[None],
                    task_id=torch.zeros(1,dtype=torch.long),intent_id=torch.zeros(1,dtype=torch.long),
                    material=torch.empty(1,0,dtype=torch.long),material_known=torch.empty(1,0,dtype=torch.bool))
        inputs.update(self.conditions)
        self.cached=self.model(**inputs)
        return self.cached

    def choose(self,choices,head='tokens'):
        return pick(self.predict()[head][0,-1],choices,self.generator,self.temperature)

    def uint(self,values):
        paths={v:_uint(v) for v in values}
        if not paths:raise ValueError('no legal exact fraction within resource limits')
        index=0
        while True:
            choices=sorted({path[index] for path in paths.values()})
            token=self.choose(choices) if len(choices)>1 else choices[0]
            self.feed(token)
            paths={v:path for v,path in paths.items() if path[index]==token}
            index+=1
            finished=[v for v,path in paths.items() if len(path)==index]
            if finished:return finished[0]

    def fraction(self,maximum,denominators,*,zero=False,clock=False):
        upper=int(maximum*max(denominators))
        nums=[n for n in range(0 if zero else 1,upper+1)
              if any(math.gcd(n,d)==1 and Fraction(n,d)<=maximum for d in denominators)]
        numerator=self.uint(nums)
        denominator=self.uint([d for d in denominators
                               if math.gcd(numerator,d)==1 and Fraction(numerator,d)<=maximum])
        value=Fraction(numerator,denominator)
        if clock:
            self.now+=value
            self.timelines[-1]=self.clock()
            self.cached=None
        return value


@torch.inference_mode()
def generate(model,prompt,*,bars=4,seed=1,temperature=0.9,qpm=90.,tempo_mode='fixed',
             groups=GROUPS,low=24,high=108,max_notes=128,max_voices=64,
             denominators=(1,2,3,4,5,6,7,8,12,16,24,32),conditions=None,
             locked_notes=(),generator=None,cursor_factory=Cursor):
    """Continue a completed score using only its past and explicit constraints.

    Finite timing vocabulary and note/voice ceilings are caller-visible sampling
    constraints, not quantization of training data or promises about quality.
    """
    if (not prompt.measures or bars<1 or bars>64 or not 0<=low<=high<=127
            or not groups or any(g not in GROUPS for g in groups)
            or max_notes<1 or max_voices<len(prompt.voice_ids())
            or not denominators or any(not isinstance(d,int) or not 1<=d<=480 for d in denominators)
            or not math.isfinite(qpm) or not 30<=qpm<=240 or tempo_mode not in ('fixed','walk')):
        raise ValueError('invalid generation resources')
    model.eval()
    if generator is None:
        generator=torch.Generator().manual_seed(seed)
    cursor=cursor_factory(model,prompt,generator,temperature,conditions)
    score=prompt
    velocities={};tempo_map=[(prompt.measures[0].onset,qpm)];limits=[]
    identities={n.voice_id for n in locked_notes}
    all_indices=[n.source_index for n in (*prompt.events,*locked_notes)]
    if len(all_indices)!=len(set(all_indices)):
        raise ValueError('prompt and locked notes need unique source indices')
    if len(set(prompt.voice_ids())|identities)>max_voices:
        raise ValueError('locked voices exceed voice resource limit')
    if any(n.group not in groups or n.pitch is None or not low<=n.pitch<=high
           or not len(prompt.measures)<=n.bar<len(prompt.measures)+bars
           or n.duration<=0 for n in locked_notes):
        raise ValueError('locked material conflicts with generation resources')
    next_index=max(all_indices,default=-1)+1
    for generated_index in range(bars):
        previous=score.measures[-1]
        next_duration=(Fraction(previous.meter[0]*4,previous.meter[1])
                       if previous.irregular else previous.duration)
        measure=Measure(len(score.measures),previous.onset+previous.duration,
                        next_duration,previous.meter,False,None)
        if conditions and 'chords' in conditions:
            original=conditions['chords']
            chord={k:v.clone() for k,v in original.items()}
            chord['bar']=chord['bar']-generated_index
            chord['known'] &= (chord['bar']>=0)&(chord['bar']<4)
            chord['hard_lock'] &= chord['known']
            cursor.conditions['chords']=chord
        locked=tuple(n for n in locked_notes if n.bar==measure.index)
        if any(not measure.onset<=n.onset<measure.onset+measure.duration for n in locked):
            raise ValueError('locked material onset outside its bar')
        if locked:
            parts=list(score.parts)
            for n in locked:
                if n.part not in {p.id for p in parts}:
                    parts.append(Part(n.part,len(parts),n.part,'',n.group,None,'supplied'))
            supplied=replace(score,parts=tuple(parts),measures=(replace(measure,index=0),),
                             events=tuple(replace(n,bar=0) for n in sorted(locked,key=lambda n:n.onset)))
            # Use static voice IDs in supplied-material encoding, as in training.
            from four_pillar_codec import encode_score
            material=encode_score(supplied).tokens
            if len(material)>cursor.context:
                raise ValueError('locked material exceeds context')
            cursor.conditions['material']=torch.tensor([material])
            cursor.conditions['material_known']=torch.ones(1,len(material),dtype=torch.bool)
            cursor.conditions['task_id']=torch.tensor([1])
        cursor.score=score;cursor.bar_on=cursor.now=measure.onset;cursor.duration=measure.duration
        cursor.conditions['log_qpm']=torch.tensor([math.log(qpm)])
        cursor.conditions['tempo_known']=torch.tensor([True])
        cursor.force([BAR,*_fraction(measure.onset),*_fraction(measure.duration),
                      *_uint(measure.meter[0]),*_uint(measure.meter[1])],
                     clock=(measure.onset,measure.onset,measure.duration))
        if tempo_mode=='walk':
            prediction=cursor.predict()['tempo'][0,0]
            if prediction[0]>0:
                qpm=max(30.,min(240.,qpm*math.exp(max(-0.15,min(0.15,float(prediction[1]))))))
            cursor.conditions['log_qpm']=torch.tensor([math.log(qpm)])
            cursor.cached=None
        tempo_map.append((measure.onset,qpm))
        notes=[];first=True
        while len(notes)<max_notes:
            remaining=measure.onset+measure.duration-cursor.now
            if remaining<=0:break
            next_token=cursor.choose([ONSET,END_BAR])
            if next_token==END_BAR:break
            cursor.feed(ONSET)
            # First onset may be at beat zero. Subsequent slices must advance.
            cursor.fraction(remaining,denominators,zero=first,clock=True)
            first=False
            # An onset delta may land exactly on the next barline. It belongs
            # to the next measure and must never create zero-duration notes.
            if cursor.now>=measure.onset+measure.duration:
                cursor.feed(END_ONSET)
                break
            while len(notes)<max_notes:
                cursor.feed(NOTE)
                choices=[]
                for i,row in enumerate(cursor.registry):
                    group=GROUPS[int(row[:6].argmax())] if row[:6].sum() else None
                    if group in groups and cursor.identities[i] not in identities:choices.append(i)
                reserved=len(identities-set(cursor.identities))
                if len(cursor.registry)<max_voices-reserved:choices.append(len(cursor.registry))
                pointer=cursor.choose(choices,'voice_pointer')
                new=pointer==len(cursor.registry)
                cursor.feed(VOICE_CHOICE,pointer)
                if new:
                    group_token=cursor.choose([GROUP_BASE+GROUPS.index(g) for g in groups])
                    group=GROUPS[group_token-GROUP_BASE]
                    identity=(f'generated-{pointer}','1','1')
                    if identity in cursor.identities or identity in identities:
                        identity=(f'generated-{pointer}-{next_index}','1','1')
                    cursor.identities.append(identity)
                else:
                    group=GROUPS[int(cursor.registry[pointer,:6].argmax())]
                    group_token=GROUP_BASE+GROUPS.index(group)
                    identity=cursor.identities[pointer]
                cursor.feed(group_token,group=(pointer,group))
                old_role=cursor.registry[pointer,6:14]
                role_token=(ROLE_BASE+int(old_role.argmax()) if old_role.sum() else
                            (NONE if not new else cursor.choose([NONE]+list(range(ROLE_BASE,ROLE_BASE+len(ROLES))))))
                role=ROLES[role_token-ROLE_BASE] if role_token!=NONE else None
                cursor.feed(role_token,role=(pointer,role))
                pitch=(None if group=='percussion' else
                       cursor.choose(list(range(PITCH_BASE+low,PITCH_BASE+high+1)))-PITCH_BASE)
                cursor.feed(UNPITCHED if pitch is None else PITCH_BASE+pitch)
                duration=cursor.fraction(measure.duration*4,denominators)
                cursor.feed(NONE)  # untransposed sounding-pitch export; no invented spelling
                cursor.feed(NONE)  # no invented notated tuplet ratio
                dynamic=cursor.choose([NONE]+list(range(DYNAMIC_BASE,DYNAMIC_BASE+len(DYNAMICS))))
                cursor.feed(dynamic)
                wedge=cursor.choose([NONE]+list(range(WEDGE_BASE,WEDGE_BASE+len(WEDGES))))
                cursor.feed(wedge)
                accent=cursor.choose(list(range(ACCENT_BASE,ACCENT_BASE+3)))-ACCENT_BASE
                cursor.feed(ACCENT_BASE+accent)
                note=NoteEvent(next_index,cursor.now,duration,measure.index,*identity,pitch,None,
                               group,role,None,None if dynamic==NONE else DYNAMICS[dynamic-DYNAMIC_BASE],
                               None if wedge==NONE else WEDGES[wedge-WEDGE_BASE],accent,False,pitch is None)
                cursor.feed(GRACE_NO,note=note)
                mean=float(cursor.predict()['midi_velocity'][0,-1,0])
                velocities[next_index]=max(1,min(127,round(mean*127)))
                next_index+=1;notes.append(note)
                if len(notes)>=max_notes or cursor.choose([NOTE,END_ONSET])==END_ONSET:break
            cursor.feed(END_ONSET)
        if len(notes)>=max_notes:limits.append({'bar':measure.index,'reason':'max-notes closure'})
        cursor.feed(END_BAR)
        parts=list(score.parts);known_parts={p.id for p in parts}
        for n in (*notes,*locked):
            if n.part not in known_parts:
                programs={'woodwinds':73,'brass':60,'percussion':0,'keys':0,'high_strings':40,'low_strings':42}
                parts.append(Part(n.part,len(parts),n.group,'',n.group,programs[n.group],'generated-group'))
                known_parts.add(n.part)
        order={p.id:p.index for p in parts}
        combined=tuple(sorted((*score.events,*notes,*locked),key=lambda n:
                       (n.onset,order[n.part],n.staff,n.voice,-1 if n.pitch is None else n.pitch,n.source_index)))
        score=replace(score,parts=tuple(parts),measures=score.measures+(measure,),events=combined)
        # Rebuild from committed events so supplied voices and their held notes
        # participate in the next bar's causal registry and local context.
        cursor=cursor_factory(model,score,generator,temperature,dict(conditions or {}))
    supplied_chords=[]
    if conditions and 'chords' in conditions:
        chord=conditions['chords']
        for i in range(chord['root'].shape[1]):
            if chord['known'][0,i]:
                supplied_chords.append({k:(bool(v[0,i]) if v.dtype==torch.bool else int(v[0,i]))
                                        for k,v in chord.items()})
    return score,{'velocities':velocities,'tempoMap':tempo_map,'resourceClosures':limits,
                 'seed':seed,'timingDenominators':list(denominators),
                 'suppliedChords':supplied_chords,
                 'promptBars':len(prompt.measures),'generatedBars':bars}
