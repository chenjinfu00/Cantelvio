"""Build local rehearsal stems and timing data from documented score sources.

Run with the existing chopin-op21-accompanist environment (mido, soundfile).
The downloaded Mutopia MIDI is public domain. Mendelssohn's opening melody
is entered from the public-domain Hans Sitt edition; chord cues are a reduction.
"""
from pathlib import Path
import json
import subprocess
import mido
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/media/concertos'
OUT.mkdir(parents=True, exist_ok=True)
FLUID = '/opt/anaconda3/envs/chopin-op21-accompanist/bin/fluidsynth'
SOUNDFONT = '/Applications/MuseScore 4.app/Contents/Resources/sound/MS Basic.sf3'

def note_number(name):
    if name == 'r': return None
    pcs = {'C':0,'D':2,'E':4,'F':5,'G':7,'A':9,'B':11}
    return (int(name[-1])+1)*12 + pcs[name[0]] + name.count('#') - name.count('b')

def note_name(midi):
    return ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'][midi%12]+str(midi//12-1)

def write_midi(path, notes, programs):
    midi = mido.MidiFile(ticks_per_beat=1000)
    control = mido.MidiTrack([mido.MetaMessage('set_tempo', tempo=1000000)])
    midi.tracks.append(control)
    for channel, program in programs.items():
        events=[]
        for n in notes:
            if n['channel'] != channel: continue
            start=round(n['time']*1000); end=round((n['time']+n['duration'])*1000)
            events.extend([(start,1,n['midi'],n.get('velocity',80)),(max(start+1,end),0,n['midi'],0)])
        track=mido.MidiTrack([mido.Message('program_change',channel=channel,program=program)])
        previous=0
        for tick,on,pitch,velocity in sorted(events):
            track.append(mido.Message('note_on' if on else 'note_off',channel=channel,note=pitch,velocity=velocity,time=tick-previous));previous=tick
        midi.tracks.append(track)
    midi.save(path)

def render_stem(stem, notes, programs, duration):
    mid=OUT/f'{stem}.mid'; wav=OUT/f'{stem}.wav'; ogg=OUT/f'{stem}.ogg'
    write_midi(mid, notes, programs)
    subprocess.run([FLUID,'-ni','-g','0.55','-r','44100','-F',str(wav),SOUNDFONT,str(mid)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    data,rate=sf.read(wav)
    target=round((duration+1.2)*rate)
    if len(data)<target: data=np.pad(data,((0,target-len(data)),(0,0)))
    data=data[:target]
    # Keep a natural tail while guaranteeing silence at the clip boundary.
    fade=min(round(.7*rate),len(data));data[-fade:]*=np.linspace(1,0,fade)[:,None]
    peak=np.max(np.abs(data))
    if peak: data*=min(8.0,.72/peak)
    sf.write(ogg,data,rate,format='OGG',subtype='VORBIS')
    wav.unlink()
    return {'file':ogg.name,'duration':round(len(data)/rate,3),'peak':round(float(np.max(np.abs(data))),4)}

def tchaikovsky():
    source=ROOT/'tmp/concerto-sources/tchaikovsky-midi/tchai_op35.mid'
    midi=mido.MidiFile(source)
    changes=[(0,500000)];tick=0
    for msg in midi.tracks[0]:
        tick+=msg.time
        if msg.type=='set_tempo': changes.append((tick,msg.tempo))
    changes=sorted(dict(changes).items())
    def seconds(tick):
        value=0
        for i,(start,tempo) in enumerate(changes):
            if start>=tick: break
            end=min(tick,changes[i+1][0]) if i+1<len(changes) else tick
            value+=(end-start)*tempo/1e6/midi.ticks_per_beat
        return value
    start_tick=88*midi.ticks_per_beat # m.23, first solo entry after the orchestral introduction.
    end_tick=62548 # m.41 held tonic release, before grace notes leading into the beat-four pickup.
    origin=seconds(start_tick);duration=seconds(end_tick)-origin
    notes=[];programs={};lead=[]
    for tr in midi.tracks[1:]:
        tick=0;active={}
        for msg in tr:
            tick+=msg.time
            if msg.type=='program_change': programs[msg.channel]=msg.program
            if msg.type=='note_on' and msg.velocity>0: active[(msg.channel,msg.note)]=(tick,msg.velocity)
            if msg.type=='note_off' or (msg.type=='note_on' and msg.velocity==0):
                began=active.pop((msg.channel,msg.note),None)
                if not began: continue
                t0,vel=began
                if tick<=start_tick or t0>=end_tick: continue
                n={'time':round(seconds(max(t0,start_tick))-origin,5),'duration':round(seconds(min(tick,end_tick))-seconds(max(t0,start_tick)),5),'midi':msg.note,'velocity':vel,'channel':msg.channel}
                notes.append(n)
                if tr.name=='solo:':lead.append(n)
    lead.sort(key=lambda n:(n['time'],n['midi']))
    groups={}
    for n in lead:groups.setdefault(n['time'],[]).append(n)
    guide=[{'time':t,'duration':max(n['duration'] for n in ns),'midis':[n['midi'] for n in ns],'name':' · '.join(note_name(n['midi']) for n in ns)} for t,ns in sorted(groups.items())]
    backing=[n for n in notes if n['channel']!=10]
    files={kind:render_stem(f'tchaikovsky-{kind}',ns,programs,duration) for kind,ns in [('backing',backing),('reference',notes)]}
    return {'id':'melody','composer':'Tchaikovsky','label':'You play the soloist','mode':'classic','duration':round(duration,5),'beatSeconds':.75,'excerpt':'Movement I, m.23–41, ending before the last-beat pickup in m.41.','source':'Mutopia-2017/11/06-466; Will Oram; Eulenburg 1920; public domain.','sourceUrl':'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=466','guide':guide,'files':files}

def mendelssohn():
    # Durations are quarter-note units. Slurred notes remain separate;
    # the final held B is the opening tonic cadence at rehearsal letter A.
    bars=[
        [('r',4)], [('r',2),('B5',1.5),('B5',.5)],
        [('B5',2),('G5',1),('E6',1)], [('E6',2),('B5',1),('G6',1)],
        [('F#6',1),('E6',1),('C6',1),('E6',1)], [('B5',3),('B5',1)],
        [('C6',1),('B5',.5),('A5',.5),('A5',1),('A5',1)], [('E6',3),('B5',1)],
        [('C6',1),('B5',.5),('A5',.5),('A5',1),('A5',1)], [('D#6',2),('B5',1.5),('B5',.5)],
        [('B5',2),('G5',1),('E6',1)], [('E6',2),('B5',1),('G6',1)],
        [('F#6',1),('E6',1),('C6',1),('E6',1)], [('B5',3),('G5',.5),('A5',.5)],
        [('B5',1),('B5',.5),('B5',.5),('D6',.5),('C6',.5),('C6',.5),('B5',.5)],
        [('E6',.5),('C6',.5),('B5',.5),('A5',.5),('A5',1),('A5',1)],
        [('F#5',1),('G5',1),('A5',1),('B5',1)], [('B5',2),('G5',1),('G5',.5),('A5',.5)],
        [('B5',1),('B5',.5),('B5',.5),('D6',.5),('C6',.5),('C6',.5),('B5',.5)],
        [('E6',.5),('C6',.5),('B5',.5),('A5',.5),('A5',1),('A5',1)],
        [('G#5',1),('B5',1),('E6',1),('E6',1)], [('E6',2),('B5',1),('B5',1)],
        [('C6',1),('E6',1),('A6',1),('A6',1)], [('B6',2),('B5',1.5),('B5',.5)],
        [('B5',2)]
    ]
    chord_names=['Em','Em','Em','Em','Am','Em','Am','Am','Am','B7','Em','Em','Am','Em','E7','Am','B7','Em','E7','Am','E','Am','Am','B7','Em']
    shapes={'Em':{'coords':[[0,1],[1,1],[1,0]],'midis':[64,67,71]},'Am':{'coords':[[-1,1],[0,0],[0,1]],'midis':[57,60,64]},'B7':{'coords':[[1,1],[1,2],[2,1],[3,0]],'midis':[59,63,66,69]},'C':{'coords':[[0,0],[0,1],[1,0]],'midis':[60,64,67]},'E':{'coords':[[0,1],[0,2],[1,1]],'midis':[64,68,71]},'E7':{'coords':[[0,1],[0,2],[1,1],[2,0]],'midis':[64,68,71,74]}}
    beat=.6 # quarter=100: a deliberate, playable rehearsal tempo.
    solo=[];chords=[];guide=[];q=0
    for bar_i,bar in enumerate(bars):
        beats=sum(d for _,d in bar)
        assert beats==(2 if bar_i==24 else 4),(bar_i,beats)
        name=chord_names[bar_i];shape=shapes[name]
        guide.append({'time':round(q*beat,5),'duration':beats*beat,'name':name,'bar':bar_i+1,**shape})
        for pitch in shape['midis']:chords.append({'time':q*beat,'duration':beats*beat*.94,'midi':pitch-12,'channel':1,'velocity':58})
        for name,d in bar:
            pitch=note_number(name)
            if pitch is not None:solo.append({'time':round(q*beat,5),'duration':round(d*beat*.97,5),'midi':pitch,'channel':0,'velocity':83})
            q+=d
    duration=q*beat
    files={kind:render_stem(f'mendelssohn-{kind}',ns,{0:40,1:0},duration) for kind,ns in [('backing',solo),('reference',solo+chords)]}
    return {'id':'harmony','composer':'Mendelssohn','label':'You play the chords','mode':'harmonic','duration':round(duration,5),'beatSeconds':beat,'excerpt':'Movement I, m.1–24 and the first half of m.25 (letter A), quarter=100 rehearsal tempo.','source':'Hans Sitt / Ernst Eulenburg score, printed pp.2–3. Violin line transcribed from the public-domain score; chord cues are a simplified harmonic reduction, not an orchestral transcription.','guide':guide,'files':files}

if __name__=='__main__':
    for make in [tchaikovsky,mendelssohn]:
        item=make()
        (OUT/f"{item['id']}.json").write_text(json.dumps(item,ensure_ascii=False,indent=2)+'\n')
        print(item['composer'],item['duration'],len(item['guide']),item['files'])
