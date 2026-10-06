"""Traceable exact JSON/MusicXML and explicitly audited playback MIDI export."""
from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from fractions import Fraction


def record(score):
    return {'scoreId':score.score_id,'source':score.source,
        'parts':[{'id':p.id,'name':p.name,'sound':p.sound,'group':p.group,
                  'program':p.program,'mapping':p.mapping} for p in score.parts],
        'measures':[{'on':str(m.onset),'dur':str(m.duration),'meter':list(m.meter),
                     'irregular':m.irregular,'key':m.key} for m in score.measures],
        'notes':[{'sourceIndex':n.source_index,'bar':n.bar,'on':str(n.onset),
                  'dur':str(n.duration),'part':n.part,'staff':n.staff,'voice':n.voice,
                  'pitch':n.pitch,'writtenPitch':n.written_pitch,'group':n.group,
                  'role':n.role,'tuplet':n.tuplet,'dynamic':n.dynamic,'wedge':n.wedge,
                  'accent':n.accent,'grace':n.grace,'unpitched':n.unpitched} for n in score.events]}


def _element(parent,name,value=None,**attributes):
    node=ET.SubElement(parent,name,{k:str(v) for k,v in attributes.items()})
    if value is not None:node.text=str(value)
    return node


def musicxml(score,path,tempo_map=()):
    # Sounding-pitch score: preserve exact timing and voice identities, with
    # ties for sustained notes crossing barlines. Enharmonic spelling is plain.
    denominators=[x.denominator for n in score.events for x in (n.onset,n.duration)]
    denominators += [x.denominator for m in score.measures for x in (m.onset,m.duration)]
    divisions=math.lcm(1,*denominators)
    measures=list(score.measures)
    latest=max((n.end for n in score.events),default=Fraction(0))
    from dataclasses import replace
    while measures[-1].onset+measures[-1].duration<latest:
        last=measures[-1]
        measures.append(replace(last,index=last.index+1,onset=last.onset+last.duration))
    root=ET.Element('score-partwise',version='4.0')
    partlist=_element(root,'part-list')
    ids={p.id:f'P{i+1}' for i,p in enumerate(score.parts)}
    for p in score.parts:
        part=_element(partlist,'score-part',id=ids[p.id]);_element(part,'part-name',p.name or p.id)
    spellings=[('C',0),('C',1),('D',0),('D',1),('E',0),('F',0),
               ('F',1),('G',0),('G',1),('A',0),('A',1),('B',0)]
    for part in score.parts:
        node=_element(root,'part',id=ids[part.id])
        for measure in measures:
            bar=_element(node,'measure',number=measure.index+1)
            attrs=_element(bar,'attributes');_element(attrs,'divisions',divisions)
            time=_element(attrs,'time');_element(time,'beats',measure.meter[0]);_element(time,'beat-type',measure.meter[1])
            if part.index==0:
                for at,qpm in tempo_map:
                    if measure.onset<=at<measure.onset+measure.duration:
                        direction=_element(bar,'direction')
                        metro=_element(_element(direction,'direction-type'),'metronome')
                        _element(metro,'beat-unit','quarter');_element(metro,'per-minute',qpm)
                        _element(direction,'offset',int((at-measure.onset)*divisions))
                        _element(direction,'sound',tempo=str(qpm))
            # A separate backup-based lane for each note handles arbitrary
            # overlapping voices, including unequal simultaneous durations.
            notes=[n for n in score.events if n.part==part.id and
                   ((n.onset<measure.onset+measure.duration and n.end>measure.onset)
                    or (n.grace and measure.onset<=n.onset<measure.onset+measure.duration))]
            if not notes:
                note=_element(bar,'note');_element(note,'rest');_element(note,'duration',int(measure.duration*divisions))
            cursor=Fraction(0)
            for n in notes:
                if cursor:
                    _element(_element(bar,'backup'),'duration',int(cursor*divisions))
                offset=max(n.onset,measure.onset)-measure.onset
                if offset:_element(_element(bar,'forward'),'duration',int(offset*divisions))
                duration=min(n.end,measure.onset+measure.duration)-max(n.onset,measure.onset)
                note=_element(bar,'note')
                if n.grace:_element(note,'grace')
                if n.pitch is None:
                    unpitched=_element(note,'unpitched');_element(unpitched,'display-step','C');_element(unpitched,'display-octave',5)
                else:
                    step,alter=spellings[n.pitch%12]
                    pitch=_element(note,'pitch');_element(pitch,'step',step)
                    if alter:_element(pitch,'alter',alter)
                    _element(pitch,'octave',n.pitch//12-1)
                if not n.grace:_element(note,'duration',int(duration*divisions))
                ties=[]
                if n.onset<measure.onset:ties.append('stop')
                if n.end>measure.onset+measure.duration:ties.append('start')
                for kind in ties:_element(note,'tie',type=kind)
                _element(note,'voice',f'{n.staff}:{n.voice}')
                if ties or n.accent or n.dynamic:
                    notation=_element(note,'notations')
                    for kind in ties:_element(notation,'tied',type=kind)
                    if n.accent:_element(_element(notation,'articulations'),'accent')
                    if n.dynamic:
                        dynamics=_element(notation,'dynamics')
                        if n.dynamic.isalpha():_element(dynamics,n.dynamic)
                        else:_element(dynamics,'other-dynamics',n.dynamic)
                cursor=offset+(Fraction(0) if n.grace else duration)
    ET.indent(root)
    ET.ElementTree(root).write(path,encoding='utf-8',xml_declaration=True)


def midi(score,path,velocities,tempo_map):
    import struct
    def vlq(value):
        if not 0<=value<=0x0fffffff:
            raise ValueError('MIDI delta exceeds SMF range')
        data=[value & 127]
        while value>=128:
            value >>= 7;data.insert(0,128|(value&127))
        return bytes(data)
    def meta(kind,payload):
        return bytes((255,kind))+vlq(len(payload))+payload
    def track(events):
        previous=0;data=bytearray()
        for tick,order,payload in sorted(events,key=lambda e:(e[0],e[1])):
            data.extend(vlq(tick-previous));data.extend(payload);previous=tick
        data.extend(b'\x00\xff\x2f\x00')
        return b'MTrk'+struct.pack('>I',len(data))+bytes(data)
    exact=math.lcm(1,*(v.denominator for n in score.events for v in (n.onset,n.end)),
                   *(at.denominator for at,_ in tempo_map))
    tpq=math.lcm(480,exact)
    exact_midi=tpq<=32767
    if not exact_midi:tpq=960
    tempo=[]
    for at,qpm in sorted(tempo_map):
        micros=round(60000000/qpm)
        tempo.append((round(at*tpq),0,meta(81,micros.to_bytes(3,'big'))))
    tracks=[track(tempo)]
    skipped=[];maximum_error=0.;grace_adjustments=[]
    channels=[i for i in range(16) if i!=9]
    for i,part in enumerate(score.parts):
        if i//15>127:raise ValueError('too many parts for MIDI port representation')
        channel=channels[i%15]
        events=[(0,-3,meta(33,bytes((i//15,)))),
                (0,-2,meta(3,(part.name or part.id).encode('utf-8'))),
                (0,-1,bytes((192|channel,part.program or 0)))]
        for n in score.events:
            if n.part!=part.id:continue
            if n.pitch is None:
                skipped.append(n.source_index);continue
            start,end=round(n.onset*tpq),round(n.end*tpq)
            if end<=start:
                end=start+1
                if n.grace:grace_adjustments.append(n.source_index)
            maximum_error=max(maximum_error,abs(start/tpq-float(n.onset)),abs(end/tpq-float(n.end)))
            velocity=velocities.get(n.source_index,72)
            events.extend([(start,1,bytes((144|channel,n.pitch,velocity))),
                           (end,0,bytes((128|channel,n.pitch,0)))])
        tracks.append(track(events))
    path.write_bytes(b'MThd'+struct.pack('>IHHH',6,1,len(tracks),tpq)+b''.join(tracks))
    return {'exactTiming':exact_midi and maximum_error<1e-10,'ticksPerQuarter':tpq,
            'maxTimingErrorQuarter':maximum_error,
            'unpitchedNotesWithoutMidiDrumIdentity':skipped,
            'graceNotesWithOneTickPlayback':grace_adjustments,
            'promptVelocityDefault':72,
            'samePitchOverlaps':'MIDI note identity depends on player; JSON/MusicXML retain voices'}


def export(score,audit,directory):
    directory.mkdir(parents=True,exist_ok=False)
    musicxml(score,directory/'score.musicxml',audit['tempoMap'])
    playback=midi(score,directory/'preview.mid',audit['velocities'],audit['tempoMap'])
    payload={'score':record(score),'generation':audit,'midiAudit':playback}
    (directory/'score.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2,default=str)+'\n')
    return playback
