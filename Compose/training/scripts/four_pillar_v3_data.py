"""Source-supported complete-event supervision; exact fractions, no guessed drums."""
from fractions import Fraction
import math
import torch
from four_pillar_codec import GROUPS,DYNAMICS,WEDGES
from four_pillar_trial_data import summarize_bars
from four_pillar_v3_model import CONFIG
from four_pillar_midi_data import _load_midi_score, source_path

FIELDS=('group','pitch','voice','delta_num','delta_den','duration_num','duration_den','velocity','drum_identity','event_kind','harmony_root','harmony_quality','dynamic','accent','wedge')

def load_midi(row):
    score,velocities,_,tempos=_load_midi_score(row)
    # v2 kept the unpitched marker but discarded the original drum MIDI number.
    # Recover it from the original file with the identical accepted-note order.
    from symusic import Score
    from orchestra_midi_groups import group_of
    raw=Score(str(source_path(row))); drums={}; index=0
    for track in raw.tracks:
        for note in track.notes:
            if group_of(int(track.program),int(note.pitch),bool(track.is_drum)) is None or note.duration<=0: continue
            if track.is_drum: drums[index]=int(note.pitch)
            index+=1
    if index!=len(score.events): raise ValueError('MIDI sidecar/source-index mismatch')
    return score,velocities,drums,tempos

def integer_bytes(value,config=CONFIG):
    if value<0:raise ValueError('negative time integer')
    out=[]
    while value>=128:out.append((value&127)|128);value>>=7
    out.append(value)
    if len(out)>config['uint_bytes']:raise ValueError('time integer exceeds wire uint length')
    return out+[-1]*(config['uint_bytes']-len(out))

def fraction_fields(value,config=CONFIG):
    value=Fraction(value)
    if value<0:raise ValueError('negative time')
    integer_bytes(value.numerator,config);integer_bytes(value.denominator,config)
    return value.numerator,value.denominator

def vector(event,bar_start,bar_length,tempo=100):
    # Only committed attributes enter the backbone, never future targets.
    result=[0.]*32
    kind=event['event_kind'];result[kind]=1.
    if kind==0:
        if event['group']<6:result[3+event['group']]=1.
        result[9]=event['pitch']/128
        result[10]=event['voice']/64
        result[11]=event['delta_num']/event['delta_den']/16
        result[12]=event['duration_num']/event['duration_den']/16
        result[13]=event.get('velocity',64)/127
        result[14]=event.get('drum_identity',0)/127
    result[15]=float(bar_length)/16
    result[16]=math.log(max(1,tempo))/8
    # Continuous absolute time supplements RoPE, without resetting at barlines.
    for i in range(3):
        phase=float(bar_start)/(2**i)
        result[17+2*i],result[18+2*i]=math.sin(phase),math.cos(phase)
    result[23]=event.get('dynamic',0)/max(1,len(DYNAMICS))
    result[24]=event.get('wedge',0)/max(1,len(WEDGES))
    result[25]=event.get('accent',0)/2
    return result

def make_batch(score,target_bar,velocities=None,drums=None,tempos=None,context=256,config=CONFIG,harmony=None,target_count=None):
    if not 1<=target_bar<len(score.measures):raise ValueError('needs one completed past bar')
    velocities,drums=velocities or {},drums or {}
    summary=summarize_bars(score)
    history=torch.tensor(summary[max(0,target_bar-config['history_bars']):target_bar]).unsqueeze(0)
    registry={};features=[];targets=[];masks=[];previous=[0.]*32
    by_bar={}
    for n in score.events:by_bar.setdefault(n.bar,[]).append(n)
    for bar in range(max(0,target_bar-config['history_bars']),target_bar+1):
        measure=score.measures[bar];now=measure.onset
        tempo=tempos[bar] if tempos and tempos[bar] is not None else 100
        notes=by_bar.get(bar,[])
        sequence=[]
        for note in notes:
            if note.grace:continue # Grace timing has no performed onset label in notation sources.
            if note.voice_id not in registry:registry[note.voice_id]=len(registry)
            if registry[note.voice_id]>=config['voices']:raise ValueError('voice registry exceeds v3 limit')
            delta=note.onset-now;now=note.onset
            dn,dd=fraction_fields(delta,config);tn,td=fraction_fields(note.duration,config)
            if not tn:raise ValueError('zero duration note')
            event={'group':GROUPS.index(note.group) if note.group in GROUPS else 6,'pitch':128 if note.unpitched else note.pitch,
                   'voice':registry[note.voice_id],'delta_num':dn,'delta_den':dd,
                   'duration_num':tn,'duration_den':td,'velocity':velocities.get(note.source_index,64),
                   'drum_identity':drums.get(note.source_index,0),'event_kind':0,
                   'harmony_root':0,'harmony_quality':0,
                   'dynamic':DYNAMICS.index(note.dynamic)+1 if note.dynamic in DYNAMICS else 0,
                   'accent':min(2,max(0,note.accent)), 'wedge':WEDGES.index(note.wedge)+1 if note.wedge in WEDGES else 0}
            if event['pitch'] is None:raise ValueError('unknown pitched event')
            known={name:True for name in FIELDS}
            known['group']=note.group in GROUPS
            known['dynamic']=note.dynamic in DYNAMICS
            known['wedge']=note.wedge in WEDGES
            known['accent']=bool(score.source in ('Lieder','classical-scores') or note.accent)
            known['velocity']=note.source_index in velocities
            known['drum_identity']=note.unpitched and note.source_index in drums
            known['harmony_root']=known['harmony_quality']=False
            if harmony and bar in harmony:
                event['harmony_root'],event['harmony_quality']=harmony[bar];known['harmony_root']=known['harmony_quality']=True
            sequence.append((event,known))
        # END_BAR consumes remaining time in one event, never a zero-duration note.
        dn,dd=fraction_fields(measure.onset+measure.duration-now,config)
        end={name:0 for name in FIELDS};end.update(event_kind=1,delta_num=dn,delta_den=dd,duration_den=1)
        end_known={name:name in ('event_kind','delta_num','delta_den') for name in FIELDS}
        sequence.append((end,end_known))
        if bar==target_bar and target_count is not None:sequence=sequence[:target_count]
        for event,known in sequence:
            features.append(previous);targets.append(event)
            masks.append({name:bool(bar==target_bar and known[name]) for name in FIELDS})
            previous=vector(event,measure.onset,measure.duration,tempo)
        features,targets,masks=features[-context:],targets[-context:],masks[-context:]
    if not any(m['event_kind'] for m in masks):raise ValueError('target empty')
    # Plan is based only on completed history, even for teacher-forced target notes.
    return {'events':torch.tensor(features).unsqueeze(0), 'history':history.float(),
            'history_known':torch.ones(history.shape[:2],dtype=torch.bool),
            'controls':torch.zeros(1,len(features),32),
            'targets':{name:torch.tensor([[integer_bytes(r[name],config) if name in ('delta_num','delta_den','duration_num','duration_den') else r[name] for r in targets]],dtype=torch.long) for name in FIELDS},
            'known':{name:torch.tensor([[[m[name] and byte>=0 for byte in integer_bytes(r[name],config)] if name in ('delta_num','delta_den','duration_num','duration_den') else m[name] for m,r in zip(masks,targets)]],dtype=torch.bool) for name in FIELDS}}
