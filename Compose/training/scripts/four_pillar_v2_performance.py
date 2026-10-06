"""v2 performance-console bridge. Controls constrain inference, never weights."""
import json,sys,math
from pathlib import Path
from fractions import Fraction
from dataclasses import replace
import torch
from four_pillar_codec import PITCH_BASE,ONSET,END_BAR,NOTE,END_ONSET,GROUPS,GROUP_BASE,ROLE_BASE,NONE
from four_pillar_v2_decode import Cursor,generate,pick
from four_pillar_v2_model import FourPillarExpressiveV2
from four_pillar_v2_inference_cache import install
from four_pillar_midi_data import sha256
from four_pillar_v2_stream import compact
from score_events_v2 import ScoreEvents,Measure,Part,NoteEvent

ROOT=Path(__file__).resolve().parents[1]
QUALITIES=json.loads((ROOT/'data/chord-qualities.json').read_text())


def role_for(role,group,pitch=None,pointer=0):
    if group=='low_strings':return 1
    if role and 'mel' in role or group=='woodwinds':return 2
    return 0


class PerformanceCursor(Cursor):
    def feed(self,*args,**kwargs):
        previous=len(self.tokens)
        super().feed(*args,**kwargs)
        if len(self.tokens)!=previous+1:
            self.feature_cache=None;self.feature_filled=0
            self.input_filled=0

    def predict(self):
        if self.cached is not None:return self.cached
        if self.memory_inputs is None:
            return super().predict()
        length=len(self.tokens);n=len(self.registry)
        features=getattr(self,'feature_cache',None)
        known=getattr(self,'known_cache',None)
        filled=getattr(self,'feature_filled',0)
        if features is None or filled>length:
            features=torch.zeros(1,self.context,n,16)
            known=torch.zeros(1,self.context,n,dtype=torch.bool);filled=0
        elif features.shape[2]!=n:
            extra=n-features.shape[2]
            if extra<0:
                features=torch.zeros(1,self.context,n,16)
                known=torch.zeros(1,self.context,n,dtype=torch.bool);filled=0
            else:
                features=torch.cat((features,torch.zeros(1,self.context,extra,16)),dim=2)
                known=torch.cat((known,torch.zeros(1,self.context,extra,dtype=torch.bool)),dim=2)
        for i in range(filled,length):
            rows=self.snapshots[i];features[0,i,:len(rows)]=rows;known[0,i,:len(rows)]=True
        self.feature_cache,self.known_cache,self.feature_filled=features,known,length
        # Append to causal input buffers rather than converting the entire
        # 2048-token Python history again at every sampling decision.
        if not hasattr(self,'token_cache'):
            self.token_cache=torch.zeros(1,self.context,dtype=torch.long)
            self.pointer_cache=torch.zeros(1,self.context,dtype=torch.long)
            self.timeline_cache=torch.zeros(1,self.context,24)
            self.input_filled=0
        filled=self.input_filled
        if filled<length:
            self.token_cache[0,filled:length]=torch.tensor(self.tokens[filled:length])
            self.pointer_cache[0,filled:length]=torch.tensor(self.feedback[filled:length])
            self.timeline_cache[0,filled:length]=torch.stack(self.timelines[filled:length])
        # Clock fractions can update the final row without adding a token.
        self.timeline_cache[0,length-1]=self.timelines[-1]
        self.input_filled=length
        inputs=dict(**self.memory_inputs,decoder_input=self.token_cache[:,:length],
            voice_features=features[:,:length],voice_known=known[:,:length],
            voice_pointer_input=self.pointer_cache[:,:length],timeline=self.timeline_cache[:,:length],
            task_id=torch.zeros(1,dtype=torch.long),intent_id=torch.zeros(1,dtype=torch.long),
            material=torch.empty(1,0,dtype=torch.long),material_known=torch.empty(1,0,dtype=torch.bool))
        inputs.update(self.conditions)
        self.cached=self.model(**inputs)
        return self.cached

    def voice_role(self,pointer):
        from four_pillar_codec import ROLES
        if pointer>=len(self.registry):return None
        row=self.registry[pointer]
        group=GROUPS[int(row[:6].argmax())] if row[:6].sum() else 'keys'
        annotation=ROLES[int(row[6:14].argmax())] if row[6:14].sum() else None
        return role_for(annotation,group)

    def coverage(self):
        ends={role:self.now for role in (0,1,2)}
        for n in self.active:
            if n.pitch is not None and n.onset<=self.now:
                role=role_for(n.role,n.group)
                ends[role]=max(ends[role],n.end)
        return ends

    def choose(self,choices,head='tokens'):
        temperature=1.
        policy=self.model.performance_policy
        if head=='voice_pointer':
            missing=[role for role,end in self.coverage().items() if end<=self.now]
            self.required_role=None
            if missing:
                required=missing[0]
                permitted=[p for p in choices if self.voice_role(p)==required]
                if permitted:choices=permitted
                elif len(self.registry) in choices:
                    self.required_role=required;choices=[len(self.registry)]
                else:raise ValueError('No available voice for required console line')
        if head=='tokens' and all(GROUP_BASE<=t<GROUP_BASE+6 for t in choices) and getattr(self,'required_role',None) is not None:
            choices=[GROUP_BASE+[3,5,0][self.required_role]]
        if head=='tokens' and NONE in choices and any(ROLE_BASE<=t<ROLE_BASE+8 for t in choices) and getattr(self,'required_role',None) is not None:
            choices=[ROLE_BASE+(1 if self.required_role==2 else 4)]
        if head=='tokens' and set(choices)=={NOTE,END_ONSET}:
            if any(end<=self.now for end in self.coverage().values()):choices=[NOTE]
            elif sum(n.onset==self.now for n in self.active)>=5:choices=[END_ONSET]
        if head=='tokens' and set(choices)=={ONSET,END_BAR}:
            # A full-console bar must keep all three independent lines sounding
            # through its end. Early END_BAR is legal only if held notes cover it.
            if self.bar_on+self.duration-self.now<=Fraction(1,32):choices=[END_BAR]
            elif any(end<self.bar_on+self.duration for end in self.coverage().values()):choices=[ONSET]
        if head=='tokens' and all(PITCH_BASE<=t<PITCH_BASE+128 for t in choices):
            offset=self.now-self.bar_on
            chord=next(s for s in reversed(policy['spans']) if Fraction(s['offset'])<=offset)
            role=role_for(policy.get('role'),policy.get('group'))
            # Infer the role from the most recently fed voice registry.
            pointer=self.feedback[-1] if self.feedback[-1]>=0 else None
            for token,p in zip(reversed(self.tokens),reversed(self.feedback)):
                if p>=0:pointer=p;break
            if pointer is not None and pointer<len(self.registry):
                row=self.registry[pointer]
                from four_pillar_codec import ROLES
                group=GROUPS[int(row[:6].argmax())] if row[:6].sum() else 'keys'
                annotation=ROLES[int(row[6:14].argmax())] if row[6:14].sum() else None
                role=role_for(annotation,group)
            tones={(chord['root']+i)%12 for i in QUALITIES[chord['q']]['intervals']}
            low,high=(28,62) if role==1 else ((57,81) if role==2 else (48,84))
            allowed=[t for t in choices if low<=t-PITCH_BASE<=high and
                     (role==2 or (t-PITCH_BASE)%12 in tones)]
            if chord.get('bassPc') is not None and role==1 and offset==Fraction(chord['offset']):
                inversion=[t for t in allowed if (t-PITCH_BASE)%12==chord['bassPc']]
                if inversion:allowed=inversion
            if role==2:
                scale=[0,2,3,5,7,8,10] if policy['key']['mode']=='minor' else [0,2,4,5,7,9,11]
                pcs={(policy['key']['tonic']+i)%12 for i in scale}
                allowed=[t for t in allowed if (t-PITCH_BASE)%12 in pcs]
            choices=allowed or choices
            temperature=policy['melodyT'] if role==2 else policy['harmonyT']
        if len(choices)==1:
            # A performance mask has already fixed the answer. Preserve the
            # sampler's RNG advance without running a redundant model forward.
            torch.multinomial(torch.ones(1),1,generator=self.generator)
            return choices[0]
        logits=self.predict()[head][0,-1].clone()
        if head=='tokens' and set(choices) in ({ONSET,END_BAR},{NOTE,END_ONSET}):
            logits[ONSET if ONSET in choices else NOTE]+=2.4*(policy['density']-.5)
        return pick(logits,choices,self.generator,temperature)

    def fraction(self,maximum,denominators,*,zero=False,clock=False):
        policy=self.model.performance_policy
        if clock and zero and policy.get('cut',0)>0:
            # Preserve exact committed prefix; the first fresh onset is the edit
            # boundary. Subsequent onsets are sampled freely after that boundary.
            from four_pillar_codec import _fraction
            value=Fraction(policy['cut'])
            self.force(_fraction(value))
            self.now+=value;self.timelines[-1]=self.clock();self.cached=None
            return value
        if clock and zero and any(end<=self.now for end in self.coverage().values()):
            from four_pillar_codec import _fraction
            self.force(_fraction(Fraction(0)));self.timelines[-1]=self.clock();self.cached=None
            return Fraction(0)
        if clock and not zero:
            # Do not jump past the earliest ending independent line. A tiny
            # positive step remains required by the exact event grammar.
            covered=min(self.coverage().values())-self.now
            maximum=min(maximum,max(Fraction(1,32),covered))
        if not clock:
            role=0
            for pointer in reversed(self.feedback):
                if pointer>=0:
                    role=self.voice_role(pointer) or 0;break
            maximum=min(maximum,Fraction(2 if role==2 else 4))
            # Harmony notes end by the next planned chord change. Existing notes
            # already heard remain in the score as held context.
            next_change=next((Fraction(s['offset']) for s in policy['spans'] if Fraction(s['offset'])>self.now-self.bar_on),None)
            if role==0:
                maximum=min(maximum,self.bar_on+self.duration-self.now)
                if next_change is not None:maximum=min(maximum,next_change-(self.now-self.bar_on))
        floor=Fraction(1,max(denominators))
        if maximum<floor:
            from four_pillar_codec import _fraction
            self.force(_fraction(maximum))
            if clock:
                self.now+=maximum;self.timelines[-1]=self.clock();self.cached=None
            return maximum
        wanted=Fraction(1,4) if clock else Fraction(1,2)
        minimum=wanted if maximum>=wanted else floor
        upper=int(maximum*max(denominators))
        nums=[n for n in range(0 if zero else 1,upper+1)
              if any(math.gcd(n,d)==1 and minimum<=Fraction(n,d)<=maximum for d in denominators)]
        numerator=self.uint(nums)
        denominator=self.uint([d for d in denominators if math.gcd(numerator,d)==1 and minimum<=Fraction(numerator,d)<=maximum])
        value=Fraction(numerator,denominator)
        if clock:
            self.now+=value;self.timelines[-1]=self.clock();self.cached=None
        return value


def plan_chords(model,score,rng,options,last,age):
    cursor=Cursor(model,score,rng,1.,{'log_qpm':torch.tensor([math.log(options['tempo'])]),'tempo_known':torch.tensor([True])})
    # Harmony heads depend on the complete planner history and motif memory,
    # never on event-decoder outputs. Do not decode 2048 past event positions
    # merely to read those heads. The score/history/motif inputs stay intact.
    for name in ('tokens','feedback','snapshots','timelines'):
        setattr(cursor,name,getattr(cursor,name)[-1:])
    with torch.inference_mode():out=cursor.predict()
    root_logits=out['harmony_root'][0,0].float()
    quality_logits=out['harmony_quality'][0,0].float()
    scale=[0,2,3,5,7,8,10] if options['key']['mode']=='minor' else [0,2,4,5,7,9,11]
    roots={(options['key']['tonic']+i)%12 for i in scale}
    root_logits=root_logits.clone()
    for root in range(12):
        if root not in roots:root_logits[root]=torch.finfo(root_logits.dtype).min
    # Unknown/unused quality class is never exposed as a browser chord.
    probs=torch.softmax((root_logits[:,None]+quality_logits[None,:len(QUALITIES)]).flatten(),dim=0)
    top=probs.topk(6)
    cands=[{'root':int(i)//len(QUALITIES),'q':int(i)%len(QUALITIES),'p':float(p)} for p,i in zip(top.values,top.indices)]
    duration=Fraction(options['beats'])
    spans=[];current=dict(last);last_offset=Fraction(0)
    fixed={Fraction(s['offset']):s for s in options.get('fixed',[])}
    for beat in range(math.ceil(float(duration))):
        offset=Fraction(beat)
        if offset>=duration:break
        forced=fixed.get(offset)
        change=False
        if forced:current={k:forced[k] for k in ('root','q','bassPc') if k in forced};change=True
        elif options.get('forceTonic') and beat==0:current={'root':options['key']['tonic'],'q':1 if options['key']['mode']=='minor' else 0};change=True
        elif options['mode']=='auto':
            if options['changeMode']=='bar':change=beat==0
            else:
                present=current['root']*len(QUALITIES)+current['q']
                # Event decision uses temperature 1. Temperatures only govern
                # the subsequent choice among new harmony events.
                change=bool(torch.rand((),generator=rng)<1-float(probs[present])) or age>=2*duration
            if change:
                values=(root_logits[:,None]+quality_logits[None,:len(QUALITIES)]).flatten()
                allowed=[i for i in range(len(values)) if i//len(QUALITIES) in roots and i!=current['root']*len(QUALITIES)+current['q']]
                chosen=pick(values,allowed,rng,options['harmonyT'])
                current={'root':chosen//len(QUALITIES),'q':chosen%len(QUALITIES)}
        if not spans or change:
            spans.append({'offset':str(offset),**current,'change':change,'candidates':cands})
        age=Fraction(1) if change else age+1
    # Prefix chord spans for suffix edits can have non-integer positions only
    # at sixteenth grid slots; preserve them before inserting the new chord.
    if options.get('cut',0):
        cut=Fraction(options['cut'])
        prefix=[s for s in options.get('fixed',[]) if Fraction(s['offset'])<cut]
        suffix=[s for s in spans if Fraction(s['offset'])>=cut]
        edited=fixed.get(cut)
        if edited and not any(Fraction(s['offset'])==cut for s in suffix):suffix.insert(0,{**edited,'change':True,'candidates':cands})
        spans=prefix+suffix
    chord={
        'root':torch.tensor([[s['root'] for s in spans]]),
        'quality':torch.tensor([[s['q'] for s in spans]]),
        'bar':torch.zeros(1,len(spans),dtype=torch.long),
        'offset_num':torch.tensor([[Fraction(s['offset']).numerator for s in spans]]),
        'offset_den':torch.tensor([[Fraction(s['offset']).denominator for s in spans]]),
        'known':torch.ones(1,len(spans),dtype=torch.bool),
        'hard_lock':torch.ones(1,len(spans),dtype=torch.bool)}
    return spans,chord,current,age


def main():
    init=json.loads(sys.stdin.readline());checkpoint=ROOT/'runs/four-pillar-v2-preview-20261001-step19193/state.pt'
    manifest_path=checkpoint.with_name('manifest.json');manifest=json.loads(manifest_path.read_text())
    state=torch.load(checkpoint,map_location='cpu',weights_only=False)
    if state['schema']!='four-pillar-v2-state-2' or state['manifestSha256']!=sha256(manifest_path):raise ValueError('Checkpoint mismatch')
    torch.set_num_threads(2)
    model=FourPillarExpressiveV2(**manifest['runConfig']['architecture']);model.load_state_dict(state['model'],strict=True);install(model,last_only=True,event_only=True)
    chord=init['chord'];key=init['key'];beats=Fraction(init['beats'])
    tones=QUALITIES[chord['q']]['intervals']
    seed_notes=[{'on':'0','dur':str(beats),'bar':0,'pitch':48+chord['root']+tone,
                 'part':'console-harmony','staff':'1','voice':str(i+1),'group':'keys','role':'harm'}
                for i,tone in enumerate(tones)]
    seed_notes += [
        {'on':'0','dur':str(beats),'bar':0,'pitch':36+chord['root'],'part':'console-bass','staff':'1','voice':'1','group':'low_strings','role':'harm'},
        {'on':'0','dur':str(beats),'bar':0,'pitch':72+chord['root'],'part':'console-melody','staff':'1','voice':'1','group':'woodwinds','role':'mel'}]
    prompt=ScoreEvents.from_candidate({'scoreId':'console-seed','parts':[
        {'id':'console-harmony','group':'keys'}, {'id':'console-bass','group':'low_strings'},
        {'id':'console-melody','group':'woodwinds'}],
        'measures':[{'on':'0','dur':str(beats),'meter':init['meter']}], 'notes':seed_notes})
    rng=torch.Generator().manual_seed(init['seed']);snapshots={0:(prompt,rng.get_state(),chord,Fraction(0))};results={}
    for line in sys.stdin:
        options=json.loads(line);index=options['index']
        if index not in snapshots:raise ValueError('Generation context expired or requested out of order')
        score,rng_state,last,age=snapshots[index];rng.set_state(rng_state)
        original=score.measures[-1]
        spans,conditions,last,age=plan_chords(model,score,rng,options,last,age)
        cut=Fraction(options.get('cut',0));locked=()
        if cut and index in results:
            old_score,old_audit,_=results[index];start=old_score.measures[-1].onset
            locked=tuple(n for n in old_score.events if n.bar==len(old_score.measures)-1 and n.onset<start+cut)
        # The previous measure may have a different meter. Explicitly create the
        # next measure duration from the selected meter without changing history.
        score=replace(score,measures=score.measures[:-1]+(replace(original,meter=tuple(options['meter']),irregular=True),))
        model.performance_policy={**options,'spans':spans}
        result,audit=generate(model,score,bars=1,seed=init['seed'],generator=rng,
            cursor_factory=PerformanceCursor,temperature=1.,qpm=options['tempo'],
            conditions={'chords':conditions},groups=GROUPS,max_notes=128,locked_notes=locked)
        # Restore the true past meter. The next measure has the requested meter.
        result=replace(result,measures=result.measures[:-2]+(original,result.measures[-1]))
        start=result.measures[-1].onset
        notes=[]
        for n in result.events:
            if n.bar!=len(result.measures)-1 or n.pitch is None:continue
            role=role_for(n.role,n.group,n.pitch)
            notes.append({'pitch':n.pitch,'onsetQuarter':float(n.onset-start),'durationQuarter':float(n.duration),
                'role':role,'group':n.group or 'keys','voice':'/'.join(n.voice_id),'velocity':audit['velocities'].get(n.source_index,72)/127,
                'ratioText':n.tuplet or 'none','dynamicText':n.dynamic or 'unknown',
                'accent':n.accent,'wedge':0,'key':f'v2:{index}:{n.source_index}'})
        if locked:
            old_notes=results[index][2]['notes'];old_map={n['key']:n for n in old_notes}
            for n in notes:
                if n['key'] in old_map:n.update(old_map[n['key']])
        spans=[{**s,'offset':float(Fraction(s['offset']))} for s in spans]
        payload={'index':index,'notes':notes,'spans':spans,'checkpointStep':state['step'],'resourceClosures':audit['resourceClosures']}
        results[index]=(result,audit,payload)
        for k in list(snapshots):
            if k>index:del snapshots[k]
        for k in list(results):
            if k>index:del results[k]
        snapshots[index+1]=(compact(result,model.score.config['history_bars']),rng.get_state(),last,age)
        for store in (snapshots,results):
            for k in list(store):
                if k<index-16:del store[k]
        print(json.dumps(payload),flush=True)

if __name__=='__main__':main()
