"""Extract conservative monophonic excerpts from the CC0 OpenScore Lieder corpus.

Usage: python prepare-openscore.py PATH_TO_PINNED_LIEDER_CHECKOUT OUTPUT_JSON
No audio, lyrics or copyrighted third-party performances are used. Harmony and
major/minor are estimates, not human annotations. Unsupported timing is excluded.
"""
import sys, json, hashlib, subprocess, collections
from pathlib import Path
from fractions import Fraction
import xml.etree.ElementTree as ET

DUR = {'long':16, 'breve':8, 'whole':4, 'half':2, 'quarter':1,
       'eighth':.5, '16th':.25, '32nd':.125, '64th':.0625}
MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88]
MINOR = [6.33,2.68,3.52,5.38,2.6,3.53,2.54,4.75,3.98,2.69,3.34,3.17]
QUALITIES={'maj':[0,4,7], 'min':[0,3,7], 'dim':[0,3,6],
           'dom7':[0,4,7,10], 'maj7':[0,4,7,11], 'min7':[0,3,7,10], 'half':[0,3,6,10]}

def fraction(s): return float(Fraction(s))*4

def staff_events(staff, meter, melody=False):
    time=0.; events=[]; bars=[]
    for measure in staff.findall('Measure'):
        length=fraction(measure.get('len')) if measure.get('len') else meter
        bars.append((time,length))
        voices=measure.findall('voice')
        if not voices: raise ValueError('legacy_format')
        if melody and len(voices)>1: raise ValueError('polyphonic_melody')
        for voice in voices:
            cursor=0.
            for item in voice:
                if item.tag=='location':
                    if item.find('measures') is not None: raise ValueError('cross_measure_location')
                    cursor+=fraction(item.findtext('fractions','0'))
                elif item.tag in ('Tuplet','tick'): raise ValueError('unsupported_timing')
                elif item.tag in ('Chord','Rest'):
                    if item.find('Tuplet') is not None: raise ValueError('tuplets')
                    if any(item.find(tag) is not None for tag in ('grace','acciaccatura','appoggiatura','grace4','grace16','grace32')): continue
                    kind=item.findtext('durationType')
                    if kind=='measure': duration=fraction(item.findtext('duration')) if item.findtext('duration') else length
                    elif kind in DUR: duration=DUR[kind]*(2-2**(-int(item.findtext('dots','0'))))
                    else: raise ValueError('unknown_duration')
                    if cursor<-.001 or cursor+duration>length+.001: raise ValueError('measure_timing')
                    if item.tag=='Chord':
                        notes=item.findall('Note')
                        if melody and len(notes)!=1: raise ValueError('polyphonic_melody')
                        for note in notes:
                            midi=int(note.findtext('pitch'))
                            continuation=any(s.get('type')=='Tie' and s.find('prev') is not None for s in note.findall('Spanner')) or note.find('endSpanner') is not None
                            events.append({'onset':round(time+cursor,6),'duration':duration,'midi':midi,'continuation':continuation})
                    cursor+=duration
        time+=length
    if melody:
        merged=[]
        for e in events:
            if e['continuation'] and merged and merged[-1]['midi']==e['midi'] and abs(merged[-1]['onset']+merged[-1]['duration']-e['onset'])<.001:
                merged[-1]['duration']+=e['duration']
            else: merged.append({k:v for k,v in e.items() if k!='continuation'})
        return merged,bars
    return events,bars

def key_estimate(notes, accidental):
    hist=[0.]*12
    for n in notes: hist[n['midi']%12]+=n['duration']
    major=accidental*7%12; candidates=[(major,'major',MAJOR),((major+9)%12,'minor',MINOR)]
    def correlation(c):
        tonic,mode,profile=c; x=[hist[(i+tonic)%12] for i in range(12)]; ax=sum(x)/12; ay=sum(profile)/12
        return sum((a-ax)*(b-ay) for a,b in zip(x,profile))/max(1e-8,(sum((a-ax)**2 for a in x)*sum((b-ay)**2 for b in profile))**.5)
    tonic,mode,_=max(candidates,key=correlation)
    return {'tonic':tonic,'mode':mode,'inferred':True}

def harmony(events,bars):
    out=[]
    for onset,length in bars:
        weights=[0.]*12; bass=None
        for n in events:
            overlap=min(onset+length,n['onset']+n['duration'])-max(onset,n['onset'])
            if overlap>0:
                weights[n['midi']%12]+=overlap
                if bass is None or n['midi']<bass:bass=n['midi']
        total=sum(weights)
        if not total: continue
        def score(root,quality):
            tones={(root+i)%12 for i in QUALITIES[quality]}; coverage=sum(weights[p] for p in tones)/total
            missing=sum(weights[p]<.1 for p in tones)
            return coverage-.055*(len(tones)-3)-.07*missing+(.06 if bass%12==root else 0)
        root,quality=max(((r,q) for r in range(12) for q in QUALITIES),key=lambda c:score(*c))
        tones=[(root+i)%12 for i in QUALITIES[quality]]
        out.append({'onset':onset,'duration':length,'pcs':tones,'root':root,'quality':quality,
                    'confidence':round(sum(weights[p] for p in tones)/total,4),'inferred':True})
    return out

def extract(path,root):
    score=ET.parse(path).getroot().find('Score'); staves=score.findall('Staff')
    if len(staves)<2: raise ValueError('no_accompaniment')
    part=score.find('Part'); instrument=part.find('Instrument')
    if instrument is None or not any(x in ET.tostring(instrument,encoding='unicode').lower() for x in ('voice','vocal','soprano','tenor','baritone','alto')):raise ValueError('not_vocal')
    melody=staves[0]; times=melody.findall('.//TimeSig'); keys=melody.findall('.//KeySig')
    meters={(int(t.findtext('sigN','4')),int(t.findtext('sigD','4'))) for t in times}
    if len(meters)!=1 or next(iter(meters)) not in {(3,4),(4,4)}:raise ValueError('meter')
    if len({k.findtext('accidental','0') for k in keys})>1: raise ValueError('key_change')
    meter=next(iter(meters))[0]; accidental=int(keys[0].findtext('accidental','0')) if keys else 0
    notes,bars=staff_events(melody,meter,True)
    if len(notes)<32:raise ValueError('short_melody')
    accompaniment=[]
    for s in staves[1:]:
        ev,bs=staff_events(s,meter)
        if bs!=bars:raise ValueError('staff_alignment')
        accompaniment.extend(ev)
    key=key_estimate(notes,accidental)
    # Group all encodings in the same composer/work directory before splitting.
    work=str(path.parent.relative_to(root/'scores'))
    partition='validation' if int(hashlib.sha256(work.encode()).hexdigest()[:8],16)%10==0 else 'train'
    # Trim only leading incomplete pickup; retain notated measure boundaries.
    full_bars=[(t,l) for t,l in bars if abs(l-meter)<.001]
    record={'scoreId':path.stem,'workId':work,'split':partition,'source':str(path.relative_to(root)),
            'key':key,'beatsPerBar':meter,'notes':notes,'bars':[{'onset':t,'duration':l} for t,l in full_bars],
            'chords':harmony(accompaniment,bars)}
    return record

def main():
    root=Path(sys.argv[1]);output=Path(sys.argv[2]);records=[];rejected=collections.Counter();seen=set()
    for p in sorted((root/'scores').glob('**/*.mscx')):
        try: rec=extract(p,root)
        except (ValueError,AttributeError,TypeError) as e: rejected[str(e)]+=1;continue
        ns=rec['notes']; signature=hashlib.sha256(json.dumps([(round(n['onset']-ns[0]['onset'],4),round(n['duration'],4),n['midi']-ns[0]['midi']) for n in ns]).encode()).hexdigest()
        if signature in seen:rejected['duplicate_transposition']+=1;continue
        seen.add(signature);records.append(rec)
    payload={'source':'https://github.com/OpenScore/Lieder','commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
             'license':'CC0-1.0','method':'First vocal staff, monophonic, constant 3/4 or 4/4 and key signature; unsupported timing excluded; ties merged. Piano harmony and key mode inferred. Repeats not unfolded. Work-directory hash split before excerpts; exact transposed melody duplicates removed.',
             'rejected':dict(rejected),'counts':dict(collections.Counter(r['split'] for r in records)),'records':records}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(payload,separators=(',',':')))
    print(json.dumps({k:v for k,v in payload.items() if k!='records'},indent=2))

if __name__=='__main__':main()
