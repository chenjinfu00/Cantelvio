import sys, json, subprocess
sys.path.insert(0,'/tmp/amt'); sys.path.insert(0,'/tmp/w/training/scripts')
import torch; torch.set_num_threads(1)
from fractions import Fraction as F
import mido, fluidsynth, numpy as np, wave
import eval_four_pillar_v31_tasks as E
from pathlib import Path
BPM=92.; SPB=60/BPM; SF='/usr/share/sounds/sf2/TimGM6mb.sf2'
def write(name, melody, acc):
    """melody: [(beat, pitch, dur)], acc: [(beat, dur, pitch)] -> mp3 (flute melody, piano accompaniment)"""
    ev=[]
    for b,p,d in melody: ev += [(b,1,0,p,92),(b+d-0.02,0,0,p,0)]
    for b,d,p in acc:
        if b<0: continue
        ev += [(b,1,1,p,70),(b+max(d,.1)-0.01,0,1,p,0)]
    ev.sort(key=lambda e:(e[0],e[1]))
    fs=fluidsynth.Synth(samplerate=44100.); sid=fs.sfload(SF); fs.program_select(0,sid,0,73); fs.program_select(1,sid,0,0)
    out=[]; t=0.
    for b,on,ch,p,v in ev:
        s=b*SPB
        n=int((s-t)*44100)
        if n>0: out.append(fs.get_samples(n)); t+=n/44100
        (fs.noteon(ch,p,v) if on else fs.noteoff(ch,p))
    out.append(fs.get_samples(int(2*44100))); fs.delete()
    a=np.concatenate(out).astype(np.int16)
    with wave.open(f'/tmp/amt/listen/{name}.wav','wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100); w.writeframes(a.tobytes())
    subprocess.run(['ffmpeg','-y','-loglevel','error','-i',f'/tmp/amt/listen/{name}.wav','-af','loudnorm=I=-16','-b:a','128k',f'/tmp/amt/listen/{name}.mp3'],check=True)
model,vocab,w=E.load(Path('/tmp/w/training/runs/four-pillar-v31-ready-20261001/weights.pt'))
orig=E.TaskComposer.best_of
E.TaskComposer.best_of=lambda self,c,**kw: orig(self,c,clash_penalty=4,**kw)
pi=json.load(open('/tmp/amt/out/amt-piano-intro.json'))['pieces']
for tune,(mel,ch,key) in E.TUNES.items():
    m=[(4*i+float(o),p,float(d)) for i,bar in enumerate(mel) for o,p,d in bar]
    for label,k in (('v31-k1',1),('v31-k8-pen4',8)):
        bars,_=E.accompany(model,vocab,tune,1,k,False)
        acc=[(4*i+float(F(n['onset'])),float(F(n['duration'])),n['pitch']) for i,b in enumerate(bars) for n in b['notes'] if not n.get('locked') and n['pitch'] is not None]
        write(f'{tune}--{label}',m,acc)
    acc=[(x[0],x[1],x[2]) for x in pi[f'{tune}-1']['notes']]
    write(f'{tune}--amt-intro',m,acc)
    print(tune,flush=True)
