"""Rebuild the Chopin Op.21/I score-to-performance map from traceable source files.

Run with the dedicated local alignment environment (Verovio 6.3, Music21 10.5,
NumPy, SciPy, Numba). Source download is explicit; no network calls occur here.
Only the derived timing map is published, not the downloaded score encoding.
"""
from pathlib import Path
import argparse,bisect,hashlib,json,math,subprocess,time,xml.etree.ElementTree as E
import numpy as np
from scipy.ndimage import maximum_filter1d
from numba import njit
ROOT=Path(__file__).resolve().parents[2]

def prepare(P,source,midi,refresh=False):
    import verovio
    from music21 import converter,stream
    P.mkdir(parents=True,exist_ok=True)
    identity=json.loads((ROOT/'site/concerto/assets/chopin-op21-alignment.json').read_text())
    assert hashlib.sha256(source.read_bytes()).hexdigest()==identity['source']['symbolicSha256']
    assert hashlib.sha256(midi.read_bytes()).hexdigest()==identity['midiSha256']
    local=P/'021-1a-BH-001.krn'
    if source.resolve()!=local.resolve():local.write_bytes(source.read_bytes())
    if not refresh and all((P/f).exists() for f in ['score-events.json','music21-notes.json','performance.json']):return
    code="import fs from 'node:fs';import {parseMidi} from "+json.dumps((ROOT/'site/concerto/midi.mjs').as_uri())+";const m=parseMidi(fs.readFileSync(process.argv[1]));process.stdout.write(JSON.stringify({tracks:m.tracks.map(t=>({id:t.id,name:t.name,notes:t.intervals.sort((a,b)=>a.beat-b.beat)})),tempos:m.tempos,endBeat:m.endBeat}));"
    output=subprocess.run(['node','--input-type=module','-e',code,str(midi)],capture_output=True,text=True,check=True)
    (P/'performance.json').write_text(output.stdout)
    toolkit=verovio.toolkit();toolkit.setOptions({'breaks':'none','midiNoCue':False})
    assert toolkit.loadFile(str(local))
    mei=toolkit.getMEI();(P/'first-edition.mei').write_text(mei)
    tm=toolkit.renderToTimemap({'includeMeasures':True});tm=json.loads(tm) if isinstance(tm,str) else tm
    (P/'first-edition-timemap.json').write_text(json.dumps(tm))
    r=E.fromstring(mei);ns={'m':'http://www.music-encoding.org/ns/mei'};xm='{http://www.w3.org/XML/1998/namespace}id'
    measures={m.get(xm):int(m.get('n','0')) for m in r.findall('.//m:measure',ns)}
    lines=local.read_text().splitlines();notes={}
    import re
    for m in r.findall('.//m:measure',ns):
        for staff in m.findall('./m:staff',ns):
            for n in staff.findall('.//m:note',ns):
                nid=n.get(xm);match=re.match(r'note-L(\d+)F(\d+)(?:S(\d+))?$',nid)
                if not match:continue
                line,col,sub=map(int,[match[1],match[2],match[3] or 1]);token=lines[line-1].split('\t')[col-1].split(' ')[sub-1]
                pitch=re.search(r'([a-gA-G]+)([#n-]*)',token);assert pitch,token
                chars,acc=pitch.groups();octave=4-len(chars) if chars[0].isupper() else 3+len(chars)
                value=(octave+1)*12+{'c':0,'d':2,'e':4,'f':5,'g':7,'a':9,'b':11}[chars[0].lower()]+acc.count('#')-acc.count('-')
                notes[nid]={'pitch':value,'staff':int(staff.get('n')),'measure':int(m.get('n','0')),'cue':n.get('cue')=='true','token':token}
    events=[];bars=[]
    for t in tm:
        q=float(t['qstamp'])
        if 'measureOn' in t:bars.append({'measure':measures[t['measureOn']],'beat':q})
        for op in ['on','off']:
            for nid in t.get(op,[]):
                if nid in notes:events.append({'beat':q,'op':op,'id':nid,**notes[nid]})
    (P/'score-events.json').write_text(json.dumps({'bars':bars,'events':events,'endBeat':tm[-1]['qstamp']}))
    parsed=converter.parse(str(local));out=[]
    for part in parsed.parts:
        for bar in part.getElementsByClass(stream.Measure):
            for n in bar.recurse().notes:
                for note in [n] if n.isNote else n.notes:
                    out.append({'bar':bar.number,'beat':float(bar.offset+n.getOffsetInHierarchy(bar)),'duration':float(n.duration.quarterLength),'pitch':int(note.pitch.midi),'tie':note.tie.type if note.tie else None,'grace':n.duration.isGrace,'staff':part.id})
    (P/'music21-notes.json').write_text(json.dumps(out))

def coarse_alignment(P):
    S=json.loads((P/'score-events.json').read_text());M=json.loads((P/'performance.json').read_text())
    STEP=.125
    # Equal-tempered pitch classes split by register plus onset features.
    def features(events,end):
     n=math.ceil(end/STEP)+1;delta=np.zeros((n+1,36),np.float32);on=np.zeros((n,12),np.float32)
     for a,b,pitch in events:
      i=max(0,min(n-1,round(a/STEP)));j=max(i+1,min(n,round(b/STEP)));ch=(0 if pitch<48 else 1 if pitch<72 else 2)*12+pitch%12
      delta[i,ch]+=1;delta[j,ch]-=1;on[i,pitch%12]=1
     roll=np.minimum(np.cumsum(delta,axis=0)[:n],1)
     on=maximum_filter1d(on,size=3,axis=0)*.6
     f=np.concatenate([roll,on],axis=1);f/=np.maximum(np.linalg.norm(f,axis=1,keepdims=True),1e-6)
     return f
    # Pair note on/off for notated references, including tied segment continuity.
    notes={};intervals=[]
    for e in S['events']:
     if e['op']=='on':notes[e['id']]=e
     elif e['id'] in notes:
      a=notes.pop(e['id']);intervals.append((a['beat'],e['beat'],a['pitch'],a['cue']))
    score_solo=features([(a,b,p) for a,b,p,c in intervals if not c],S['endBeat'])
    score_cue=features([(a,b,p) for a,b,p,c in intervals if c],S['endBeat'])
    perf_solo=features([(n['beat'],n['end'],n['note']) for n in M['tracks'][13]['notes']],M['endBeat'])
    perf_cue=features([(n['beat'],n['end'],n['note']) for t in M['tracks'] if t['id'] not in [0,13] for n in t['notes']],M['endBeat'])
    # Non-cue bars use the pianist; written tutti cues use the orchestra.
    solo_bars={e['measure'] for e in S['events'] if e['op']=='on' and not e['cue']}
    bar_at=np.floor(np.maximum(0,np.arange(len(score_solo))*STEP-1.25)/4).astype(int)+1;bar_at[np.arange(len(score_solo))*STEP<1.25]=0
    mode=np.array([x in solo_bars for x in bar_at]);score=np.where(mode[:,None],score_solo,score_cue)
    seeds=np.array([[0,.975],[1.25,2.05],[281.25,259.3],[1345.25,1486.5083333333334],[1389.25,1530.2583333333334],[1393.25,1536.8666666666666]])
    @njit
    def section(A,B,C,mode,si,sj,ei,ej,band):
     nr=ei-si+1;nc=ej-sj+1;W=2*band+1
     trace=np.zeros((nr,W),np.uint8);prev=np.full(W,1e18,np.float64);out=np.empty(nr,np.float64)
     prevstart=-1
     for r in range(nr):
      center=int(round(r*(nc-1)/max(1,nr-1)));left=center-band
      cur=np.full(W,1e18,np.float64)
      for k in range(W):
       j=left+k
       if j<0 or j>=nc:continue
       vec=B[sj+j] if mode[si+r] else C[sj+j]
       dot=0.
       for x in range(A.shape[1]):dot+=A[si+r,x]*vec[x]
       cost=1-dot
       if r==0 and j==0:cur[k]=cost;continue
       best=1e18;which=0
       if r>0:
        pk=j-1-prevstart
        if 0<=pk<W:best=prev[pk];which=1
        pk=j-prevstart
        if 0<=pk<W and prev[pk]+.045<best:best=prev[pk]+.045;which=2
       if k>0 and cur[k-1]+.045<best:best=cur[k-1]+.045;which=3
       cur[k]=cost+best;trace[r,k]=which
      prev=cur;prevstart=left
     # Backtrace each score frame to median visited performance frame.
     r=nr-1;j=nc-1;ys=[];xs=[]
     while True:
      xs.append(si+r);ys.append(sj+j)
      if r==0 and j==0:break
      center=int(round(r*(nc-1)/max(1,nr-1)));k=j-(center-band)
      d=trace[r,k]
      if d==1:r-=1;j-=1
      elif d==2:r-=1
      elif d==3:j-=1
      else:raise ValueError('broken DTW path')
     return np.array(xs[::-1]),np.array(ys[::-1]),prev[-1 if nc-1-prevstart>=W else nc-1-prevstart]
    allx=[];ally=[];beg=time.time()
    for (a,b),(c,d) in zip(seeds,seeds[1:]):
     si,sj,ei,ej=[round(x/STEP) for x in [a,b,c,d]]
     x,y,cost=section(score,perf_solo,perf_cue,mode,si,sj,ei,ej,800)
     allx.extend(x.tolist());ally.extend(y.tolist());print('section',a,c,len(x),'cost',cost,flush=True)
    x=np.array(allx)*STEP;y=np.array(ally)*STEP
    qx=np.unique(x);qy=np.array([np.median(y[x==v]) for v in qx]);np.savez(P/'coarse-alignment.npz',score=qx,midi=qy)
    print('seconds',time.time()-beg,'path',len(x),flush=True)
    for bar in [0,1,2,5,15,31,49,61,65,70,71,81,100,125,150,175,199,214,227,239,259,273,299,317,334,337,348]:
     sq=0 if bar==0 else 1.25+(bar-1)*4;mq=float(np.interp(sq,qx,qy));print(bar,round(mq,4),flush=True)

def refine_alignment(P):
    S=json.loads((P/'score-events.json').read_text());N=json.loads((P/'music21-notes.json').read_text());M=json.loads((P/'performance.json').read_text());A=np.load(P/'coarse-alignment.npz')
    solo_bars={e['measure'] for e in S['events'] if e['op']=='on' and not e['cue']}
    perf=[{},{}]
    for t in M['tracks']:
     for n in t['notes']:perf[t['id']==13].setdefault(n['note'],[]).append(n['beat'])
    for p in perf:
     for pitch in p:p[pitch]=np.array(sorted(p[pitch]))
    groups={}
    lookup={}
    for e in S['events']:
     if e['op']=='on':lookup.setdefault((e['measure'],e['pitch']),[]).append(e)
    for n in N:
     if n['grace'] or n['tie'] in ['stop','continue']:continue
     q=round(n['beat'],8);candidates=lookup.get((n['bar'],n['pitch']),[])
     if not candidates:continue
     near=min(candidates,key=lambda e:abs(e['beat']-q)+(0 if e['staff']==(1 if n['staff']=='spine_2' else 2) else .02))
     groups.setdefault(q,{'bar':n['bar'],'pitches':set()})['pitches'].add((n['pitch'],near['cue']))
    raw=[]
    for q,g in sorted(groups.items()):
     expected=float(np.interp(q,A['score'],A['midi']));matched=[]
     for pitch,cue in g['pitches']:
      table=perf[not cue]
      candidates=table.get(pitch,np.array([]));i=np.searchsorted(candidates,expected)
      nearby=candidates[max(0,i-2):i+2]
      if len(nearby):
       pick=float(min(nearby,key=lambda x:abs(x-expected)))
       if abs(pick-expected)<.5:matched.append(pick)
     if matched:
      y=float(np.median(matched));inliers=[v for v in matched if abs(v-y)<.18]
      if inliers:y=float(np.median(inliers))
      raw.append({'q':q,'midi':y,'bar':g['bar'],'hits':len(inliers),'total':len(g['pitches']),'expected':expected,'coverage':len(inliers)/len(g['pitches'])})
    # Weighted monotone chain keeps supported downbeats over weaker repeated-tone matches.
    values=sorted(set(r['midi'] for r in raw));tree=[(0.,-1)]*(len(values)+1);parent=[]
    for i,r in enumerate(raw):
     rank=bisect.bisect_left(values,r['midi']-.00001);best=(0.,-1);k=rank
     while k:
      if tree[k][0]>best[0]:best=tree[k]
      k-=k&-k
     parent.append(best[1]);quarter=abs((r['q']-1.25)-round(r['q']-1.25))<1e-6
     downbeat=r['bar']>0 and abs(r['q']-(1.25+4*(r['bar']-1)))<1e-6
     weight=(.2+r['coverage'])*(1+np.log1p(r['hits']))*(1.5 if quarter else 1)*(2 if downbeat else 1)
     value=(best[0]+weight,i);k=bisect.bisect_left(values,r['midi'])+1
     while k<len(tree):
      if value[0]>tree[k][0]:tree[k]=value
      k+=k&-k
    best=max(tree);keep=set();i=best[1]
    while i>=0:keep.add(i);i=parent[i]
    knots=[r for i,r in enumerate(raw) if i in keep]
    (P/'note-matches-v3.json').write_text(json.dumps({'all':raw,'accepted':knots}))
    print('score notes',len(N),'groups',len(groups),'matched',len(raw),'monotone',len(knots))
    qx=np.array([r['q'] for r in knots]);qy=np.array([r['midi'] for r in knots]);report=[]
    for b in range(1,349):
     q=1.25+4*(b-1);points=[r for r in raw if r['bar']==b];near=min(abs(qx-q));mq=float(np.interp(q,qx,qy));cov=np.mean([r['coverage'] for r in points]) if points else 0
     report.append({'bar':b,'q':q,'midi':mq,'near':near,'matchedGroups':len(points),'coverage':float(cov),'coarse':float(np.interp(q,A['score'],A['midi']))})
    (P/'bar-diagnostics-v3.json').write_text(json.dumps(report))
    for r in report:
     if r['matchedGroups']<2 or r['coverage']<.55 or r['near']>.51:print(r)
    print('selected',[(b,report[b-1]['midi']) for b in [1,2,15,71,168,169,214,231,334,335,337,348]])

def publish_map(P):
    r=json.loads((P/'note-matches-v3.json').read_text())['accepted'];pairs={float(x['q']):float(x['midi']) for x in r}
    # Explicitly audited source attacks. q=1.25 is printed measure 1; q=0 starts the pickup.
    fixed={0:.975,.25:1.2083333333333333,1:1.8416666666666666,1.25:2.05,5.25:5.666666666666667,281.25:259.3,1345.25:1486.5083333333334,1389.25:1530.2583333333334,1393.25:1534.2583333333334}
    # Bar 148's fermata and written-out cadenza cannot be aligned by uniform clock bins.
    run=[(3.525,92,624.4),(3.55,89,624.85),(3.575,86,625.1583333333333),(3.6,87,625.4416666666667),(3.625,88,625.7333333333333),(3.65,91,626.1083333333333),(3.675,89,626.5166666666667),(3.7,87,626.7916666666666),(3.725,86,627.0583333333333),(3.75,84,627.3666666666667),(3.775,82,627.6583333333333),(3.8,80,627.9333333333333),(3.825,79,628.225),(3.85,77,628.5666666666667),(3.875,75,628.8333333333334),(3.9,74,629.2166666666667),(3.925,72,629.5333333333333),(3.95,70,629.9),(3.975,68,630.2583333333333)]
    fixed[1.25+147*4+2.5]=622.4916666666667
    for offset,pitch,midi in run:
     assert any(n['note']==pitch and abs(n['beat']-midi)<1e-7 for n in json.loads((P/'performance.json').read_text())['tracks'][13]['notes'])
     fixed[1.25+147*4+offset]=midi
    fixed[1.25+148*4]=630.725
    # Remove weaker neighbouring matches which contradict a manually verified attack.
    items=[]
    for q,m in sorted(pairs.items()):
     if any((q<a and m>=b) or (q>a and m<=b) for a,b in fixed.items() if abs(q-a)<1):continue
     items.append((q,m))
    pairs=dict(items);pairs.update(fixed);items=sorted(pairs.items())
    # Fixed attacks must be monotone after replacing ambiguous tied/arpeggiated matches.
    for a,b in zip(items,items[1:]):
     if b[1]<=a[1]:raise ValueError(('nonmonotone',a,b))
    qx=np.array([x[0] for x in items]);qy=np.array([x[1] for x in items]);targets=sorted(set([0,.25,1]+[1.25+i for i in range(1393)]+list(fixed)))
    knots=[[round(q-1.25,9),round(float(np.interp(q,qx,qy)),9)] for q in targets]
    for a,b in zip(knots,knots[1:]):assert a[0]<b[0] and a[1]<b[1],(a,b)
    sha=lambda path:hashlib.sha256(Path(path).read_bytes()).hexdigest()
    data={'schema':'cantelvio-score-map/1','workId':'chopin-op21-1','midiSha256':sha(ROOT/'site/concerto/assets/chopin-op21-mvt1.mid'),'pdfSha256':sha(ROOT/'site/concerto/assets/chopin-op21-two-pianos.pdf'),'measureCount':348,'pickupQuarters':1.25,'quartersPerMeasure':4,'positionBasis':'chopin-op21-score-v1','freeRanges':[[590.5,592]],'source':{'pdfPages':[13,48],'symbolicUrl':'https://chopinscores.org/krn/021-1a-BH-001.krn','symbolicSha256':sha(P/'021-1a-BH-001.krn'),'edition':'NIFC encoded Breitkopf & Haertel first edition, checked against the supplied Polish National Edition PDF','method':'Register/onset DTW, pitch-specific attack matching, weighted monotone chain, quarter-note interpolation; audited pickup, piano entry, cadenza and final chord. Expressive MIDI untouched.'},'validation':{'referenceAttackGroups':3929,'matchedAttackGroups':3779,'monotoneAttackGroups':len(r),'quarterBoundaries':1393,'auditedAttacks':len(fixed),'playbackMidiChanged':False},'knots':knots}
    out=ROOT/'site/concerto/assets/chopin-op21-alignment.json';out.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':'))+'\n')
    print(out.name,len(knots),out.stat().st_size,sha(out))
    (P/'audited-anchors.json').write_text(json.dumps({'fixed':[{'scoreQuarter':q-1.25,'midiBeat':m} for q,m in sorted(fixed.items())],'cadenza148':run},indent=2))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir',type=Path,default=ROOT/'Concerto/local/alignment-20261018')
    parser.add_argument('--source',type=Path)
    parser.add_argument('--refresh',action='store_true')
    args=parser.parse_args();P=args.work_dir
    prepare(P,args.source or P/'021-1a-BH-001.krn',ROOT/'site/concerto/assets/chopin-op21-mvt1.mid',args.refresh)
    coarse_alignment(P);refine_alignment(P);publish_map(P)
if __name__=='__main__':main()
