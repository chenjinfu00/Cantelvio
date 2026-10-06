#!/usr/bin/env python3
"""Original phrase grammar + CC0 OpenScore Lieder -> conditional melody Transformer.
Use the project .venv-training Python environment.
"""
import argparse, copy, hashlib, json, math, random, time
from pathlib import Path
import torch
from torch import nn
from torch.nn import functional as F
ROOT=Path(__file__).resolve().parents[1]
Q=json.loads((ROOT/'data/chord-qualities.json').read_text()); QI={q['id']:i for i,q in enumerate(Q)}
D,H,L,FF,CTX,SEED=96,8,4,224,96,927511
DURS=[1,2,3,4,6,8,12,16]; REST=24; BOS=25
MAJ=[0,2,4,5,7,9,11]; MIN=[0,2,3,5,7,8,10]
# Independently authored contour and harmonic-template families; validation holds out families.
TRAIN_MOTIFS=[[0,1,2,1,0,-1],[0,0,2,1,3,2],[0,2,1,-1,0,1],[0,1,3,2,1,0],[0,-1,0,2,1,-1],[0,2,3,1,2,0],[0,1,0,-2,-1,0],[0,-2,-1,1,0,-1],[0,2,0,1,3,2],[0,1,2,4,3,1],[0,0,-1,1,2,0],[0,3,2,1,0,1]]
VALID_MOTIFS=[[0,1,3,1,2,0],[0,-1,1,3,2,1],[0,2,1,0,-2,-1]]
TRAIN_PROGRESSIONS=[[0,4,5,3,0,4,3,0],[0,5,1,4,0,5,4,0],[1,4,0,5,1,4,0,0],[0,2,3,0,1,4,0,4],[0,3,0,0,3,3,4,0],[0,2,5,3,0,2,3,0],[0,3,1,4,0,5,1,4]]
VALID_PROGRESSIONS=[[0,5,3,4,2,5,1,0],[1,4,0,3,5,1,4,0]]
RHYTHMS={
0:[[4,2,2,4,4],[3,3,2,4,4],[4,4,2,2,4],[2,2,4,4,4]],
1:[[2,2,2,2,4,2,2],[2,2,4,2,2,2,2],[4,2,2,2,2,4],[2,2,2,2,2,2,2,2]],
2:[[4,2,2,4,4],[3,3,2,2,2,4],[2,2,4,2,2,4],[4,4,4,4]],
3:[[2,2,2,2,2,2,2,2],[4,2,2,4,2,2],[2,2,4,2,2,4],[4,4,2,2,4]],
4:[[8,8],[4,4,8],[12,4],[8,4,4]]}

def near(values,target):return min(values,key=lambda x:abs(x-target))
def motif_reference(theme,bar,slot,root,scale):
 if bar<2 or not theme[bar%2]:return BOS,8
 source=min(theme[bar%2],key=lambda e:abs(e[0]-slot))
 _,token,duration,oldroot=source
 if token==REST:return REST,duration
 # Revoice a remembered relative contour to the current harmony, preserving register.
 shift=(root-oldroot+6)%12-6
 value=max(0,min(23,token+shift))
 return near([n for n in range(24) if n%12 in scale],value),duration

def make_phrase(rng,motifs,progressions,index):
 style=index%5;mode=rng.randrange(2);pattern=rng.randrange(4);rhythm=rng.choices(range(5),[12,1,2,2,2])[0];density=rng.randrange(3);meter=12 if rng.random()<.14 else 16
 scale=MIN if mode else MAJ;degrees=rng.choice(progressions)
 chords=[]
 for deg in degrees+[0]:
  root=scale[deg];kind=(['min','dim','maj','min','min','maj','maj'] if mode else ['maj','min','min','maj','maj','min','dim'])[deg]
  quality=kind
  if style in [1,4]:quality={'maj':rng.choice(['maj7','six']), 'min':'min7','dim':'half'}[kind]
  if deg==4:quality='dom7'
  if style==2 and deg in [0,3,4]:quality='dom7'
  if rng.random()<.13:root=rng.randrange(12);quality=rng.choice(Q)['id']
  q=QI[quality];inv=rng.choices(range(len(Q[q]['intervals'])),[6]+[1]*(len(Q[q]['intervals'])-1))[0];chords.append((root,q,inv))
 notes=[n for n in range(24) if n%12 in scale];previous=rng.choice([7,9,12,14,16]);prev_token=BOS;prev_dur=3
 rows=[];targets=[];dur_targets=[];harmony_targets=[];theme=[[],[]]
 # New two-bar themes each time, with stylistic durations and a coherent contour.
 contours=[]
 for t in range(2):
  pos=rng.randrange(-1,2);line=[]
  for i in range(12):
   pos=max(-4,min(5,pos+rng.choices([-2,-1,0,1,2],[1,4,2,4,1])[0]));line.append(pos)
  contours.append(line)
 rhythms=[rng.choice(RHYTHMS[style]) for _ in range(2)]
 for bar in range(8):
  root,q,inv=chords[bar];nroot,nq,_=chords[bar+1];pcs=[(root+x)%12 for x in Q[q]['intervals']];npcs=[(nroot+x)%12 for x in Q[nq]['intervals']]
  tones=[n for n in range(24) if n%12 in pcs];guide=near(tones,12 if bar==0 else previous);center=notes.index(near(notes,guide));slot=0;i=0;pending=None
  while slot<meter:
   ref,refdur=motif_reference(theme,bar,slot,root,scale)
   ds=rhythms[bar%2]
   duration=ds[i%len(ds)] if refdur==8 else DURS[refdur]
   if rhythm==1:duration=4
   elif rhythm in [2,3]:duration=2 if rng.random()<.8 else 4
   elif rhythm==4 and i%3<2:duration=3
   if density==0:duration=max(4,duration)
   if density==2 and style in [1,3]:duration=min(2,duration)
   if bar in [3,7]:
    arrival=meter-8;duration=(4 if slot==0 and meter==16 else 2) if slot<arrival else 4
   if bar in [4,5] and style!=4 and rng.random()<.15:duration=2
   duration=max(d for d in DURS if d<=min(duration,meter-slot))
   desired=notes[max(0,min(len(notes)-1,center+contours[bar%2][i%12]))]
   if ref<BOS and ref!=REST:desired=ref
   if bar in [4,5]:desired+=rng.choice([-2,0,2])
   if pattern==1:desired=guide+round(5*math.sin(math.pi*(bar%4+slot/meter)/4))
   elif pattern==3:desired=near(tones,desired)
   if bar in [3,7]:
    landing=near([n for n in tones if n%12==root] or tones,12)
    offset=round(7*max(0,(meter-8-slot)/(meter-8)))
    desired=near(notes,landing+offset*(1 if landing<=16 else -1))
   strong=slot%8==0
   candidates=tones if pattern==3 else [n for n in range(24) if n%12 in set(scale+pcs)]
   if style==2 and pattern!=3:candidates=[n for n in range(24) if n%12 in set([0,3,5,6,7,10]+pcs)]
   if pending is not None:
    close=[n for n in tones if abs(n-pending)<=2];candidates=close or tones;desired=near(candidates,pending)
   elif strong and not (bar not in [3,7] and i and rng.random()<.18):candidates=tones
   def cost(n):return .9*abs(n-desired)+.22*abs(n-previous)+.22*max(0,abs(n-previous)-5)**2+rng.random()*.18
   token=min(candidates,key=cost)
   if style==1 and slot>=meter-2 and bar not in [3,7]:
    landing=near([n for n in range(24) if n%12 in npcs],previous);token=max(0,min(23,landing+rng.choice([-1,1])))
   rest=(bar in [3,7] and slot>=meter-4) or (pattern==2 and bar%4==2 and slot==0) or (ref==REST and bar not in [4,5]) or (i>1 and slot%4!=0 and rng.random()<.08)
   if rest:token=REST
   condition=[float(p in npcs) for p in range(12)]
   rows.append([prev_token,prev_dur,root,q,inv,mode,style,pattern,rhythm,slot,bar,density,0 if meter==16 else 1,ref,refdur])
   targets.append(token);dur_targets.append(DURS.index(duration));harmony_targets.append(condition)
   if bar<2:theme[bar].append((slot,token,DURS.index(duration),root))
   pending=token if token!=REST and token%12 not in pcs else None
   prev_token=token;prev_dur=DURS.index(duration)
   if token!=REST:previous=token
   slot+=duration;i+=1
 return rows[:CTX],targets[:CTX],dur_targets[:CTX],harmony_targets[:CTX]

def pack(rows):
 count=len(rows);x=torch.zeros(count,CTX,15,dtype=torch.long);y=torch.full((count,CTX),-100,dtype=torch.long);d=y.clone();n=torch.zeros(count,CTX,12)
 signatures=set()
 for i,(a,b,c,e) in enumerate(rows):
  size=min(len(a),CTX);x[i,:size]=torch.tensor(a[:size]);y[i,:size]=torch.tensor(b[:size]);d[i,:size]=torch.tensor(c[:size]);n[i,:size]=torch.tensor(e[:size]);signatures.add(json.dumps([a,b,c]))
 return (x,y,d,n),signatures

def dataset(count,seed,valid=False):
 rng=random.Random(seed)
 rows=[make_phrase(rng,VALID_MOTIFS if valid else TRAIN_MOTIFS,VALID_PROGRESSIONS if valid else TRAIN_PROGRESSIONS,i) for i in range(count)]
 return pack(rows)

def load_real(path):
 corpus=json.loads(Path(path).read_text());out={'train':[],'validation':[]};works={'train':set(),'validation':set()};rejected={};used={}
 for record in corpus['records']:
  split=record['split'];meter=record['beatsPerBar'];tonic=record['key']['tonic'];mode=int(record['key']['mode']=='minor');scale=MIN if mode else MAJ
  bars=record['bars'];chords={round(c['onset'],6):c for c in record['chords']}
  for start in range(0,len(bars)-7,4):
   window=bars[start:start+8]
   if any(abs(b['duration']-meter)>.001 for b in window):continue
   begin=window[0]['onset'];end=window[-1]['onset']+meter
   ns=[n for n in record['notes'] if n['onset']<end and n['onset']+n['duration']>begin]
   if len(ns)<12:continue
   pitches=[n['midi']-tonic for n in ns]
   shifts=[12*k for k in range(3,8) if min(pitches)-12*k>=0 and max(pitches)-12*k<=23]
   if not shifts:rejected['range']=rejected.get('range',0)+1;continue
   shift=min(shifts,key=lambda k:abs(sum(pitches)/len(pitches)-k-12))
   # Quantize to the model's sixteenth-note grid, with rests explicit. Sustain
   # across a bar is segmented because v5 playback remains safely bar-bounded.
   grid=[REST]*(meter*4*8);attacks=set()
   for n in ns:
    left=max(0,round((n['onset']-begin)*4));right=min(len(grid),round((n['onset']+n['duration']-begin)*4))
    attacks.add(left)
    for tick in range(left,right):grid[tick]=n['midi']-tonic-shift
   rows=[];ys=[];ds=[];hs=[];theme=[[],[]];previous=BOS;prevdur=3
   for bar,b in enumerate(window):
    c=chords.get(round(b['onset'],6))
    if not c:break
    nextc=chords.get(round(b['onset']+meter,6),c)
    root=(c['root']-tonic)%12;q=QI.get(c['quality'],QI['maj']);npcs={(x-tonic)%12 for x in nextc['pcs']}
    slot=0
    while slot<meter*4:
     token=grid[bar*meter*4+slot];length=1
     while slot+length<meter*4 and grid[bar*meter*4+slot+length]==token and bar*meter*4+slot+length not in attacks:length+=1
     length=max(d for d in DURS if d<=length);di=DURS.index(length);ref,refdur=motif_reference(theme,bar,slot,root,scale)
     rows.append([previous,prevdur,root,q,0,mode,3,0,0,slot,bar,1,0 if meter==4 else 1,ref,refdur]);ys.append(token);ds.append(di);hs.append([float(p in npcs) for p in range(12)])
     if bar<2:theme[bar].append((slot,token,di,root))
     previous=token;prevdur=di;slot+=length
   if len(rows)>CTX or len(rows)<16 or len(window)!=8:continue
   if not rows or rows[-1][10]!=7:continue
   out[split].append((rows,ys,ds,hs));works[split].add(record.get('workId',record['scoreId']));used[record['scoreId']]=split
 assert not works['train'].intersection(works['validation'])
 metadata={k:v for k,v in corpus.items() if k!='records'}
 metadata.update({'excerpts':{k:len(v) for k,v in out.items()},'worksUsed':{k:len(v) for k,v in works.items()},'usedScores':used,'rangeRejectedWindows':rejected.get('range',0),'representation':'8 contiguous full bars, sixteenth-grid rounded; explicit rests; bar-crossing sustains segmented; one whole-window octave shift, never pitch-class folding; only classical style; piano harmony and key inferred.'})
 return {k:pack(v)[0] for k,v in out.items()},metadata

class Block(nn.Module):
 def __init__(self):
  super().__init__();self.ln1=nn.LayerNorm(D);self.q=nn.Linear(D,D);self.k=nn.Linear(D,D);self.v=nn.Linear(D,D);self.o=nn.Linear(D,D);self.ln2=nn.LayerNorm(D);self.ff1=nn.Linear(D,FF);self.ff2=nn.Linear(FF,D);self.relative=nn.Parameter(torch.zeros(H,CTX))
 def forward(self,x):
  b,t,d=x.shape;z=self.ln1(x);q,k,v=[f(z).view(b,t,H,D//H).transpose(1,2) for f in [self.q,self.k,self.v]]
  dist=(torch.arange(t)[:,None]-torch.arange(t)[None,:]).clamp(0,CTX-1)
  scores=q@k.transpose(-1,-2)/math.sqrt(D//H)+self.relative[:,dist][None]
  scores=scores.masked_fill(torch.triu(torch.ones(t,t,dtype=torch.bool),1),float('-inf'));attention=scores.softmax(-1)
  z=(attention@v).transpose(1,2).reshape(b,t,D);x=x+F.dropout(self.o(z),.08,self.training)
  x=x+F.dropout(self.ff2(F.gelu(self.ff1(self.ln2(x)),approximate='tanh')),.08,self.training)
  return x,attention

FEATURES=['pitch','duration','root','quality','inversion','mode','style','pattern','rhythm','slot','phrase','density','meter','motifPitch','motifDuration']
SIZES=[26,8,12,40,7,2,5,4,5,16,8,3,2,26,9]
class MelodyTransformer(nn.Module):
 def __init__(self):
  super().__init__();self.embeddings=nn.ModuleList([nn.Embedding(n,D) for n in SIZES]);self.blocks=nn.ModuleList([Block() for _ in range(L)]);self.ln_final=nn.LayerNorm(D);self.next_chord=nn.Linear(12,D);self.pitch=nn.Linear(D,25);self.duration=nn.Linear(D,8);self.affinity=nn.Linear(D,12)
  for e in self.embeddings:nn.init.normal_(e.weight,std=.16)
 def forward(self,x,next_chord):
  z=sum(e(x[:,:,i]) for i,e in enumerate(self.embeddings));attention=[]
  for b in self.blocks:z,a=b(z);attention.append(a)
  h=self.ln_final(z);conditioned=torch.tanh(h+.6*self.next_chord(next_chord))
  return self.pitch(conditioned),self.duration(h),self.affinity(h),attention

def losses(model,data,idx):
 x,y,d,n=[a[idx] for a in data];p,du,h,_=model(x,n);mask=y!=-100
 loss=F.cross_entropy(p.flatten(0,1),y.flatten(),ignore_index=-100,label_smoothing=.02)
 loss+=.55*F.cross_entropy(du.flatten(0,1),d.flatten(),ignore_index=-100,label_smoothing=.015)
 loss+=.25*F.binary_cross_entropy_with_logits(h[mask],n[mask])
 return loss
@torch.no_grad()
def evaluate(model,data):
 model.eval();pn=dn=hn=acc=dacc=cnt=0
 for i in range(0,len(data[0]),32):
  x,y,d,n=[a[i:i+32] for a in data];p,du,h,_=model(x,n);m=y!=-100;c=int(m.sum());cnt+=c
  pn+=float(F.cross_entropy(p.flatten(0,1),y.flatten(),ignore_index=-100,reduction='sum'));dn+=float(F.cross_entropy(du.flatten(0,1),d.flatten(),ignore_index=-100,reduction='sum'))
  hn+=float(F.binary_cross_entropy_with_logits(h[m],n[m],reduction='sum'))/12;acc+=int(((p.argmax(-1)==y)&m).sum());dacc+=int(((du.argmax(-1)==d)&m).sum())
 return {'pitchCE':pn/cnt,'durationCE':dn/cnt,'affinityBCE':hn/cnt,'pitchTop1':acc/cnt,'durationTop1':dacc/cnt,'events':cnt}

def arr(x):
 def r(a):return [r(v) for v in a] if isinstance(a,list) else round(a,8)
 return r(x.detach().cpu().tolist())
def linear(x):return {'weight':arr(x.weight),'bias':arr(x.bias)}
def export(model,meta,data,output_dir):
 output_dir.mkdir(parents=True,exist_ok=True)
 probes=[]
 for idx in [0,1,3]:
  x,y,d,n=[a[idx:idx+1,:9] for a in data]
  with torch.no_grad():p,du,h,attention=model(x,n)
  probes.append({'features':x[0].tolist(),'nextChord':n[0].tolist(),'pitch':arr(p[0]),'duration':arr(du[0]),'affinity':arr(h[0]),'attention':arr(torch.stack([a[0] for a in attention]))})
 w={'format':1,'architecture':{'dModel':D,'heads':H,'layers':L,'dHead':D//H,'dFF':FF,'contextLength':CTX,'layerNormEpsilon':1e-5,'relativeAttention':True},'training':meta,'featureNames':FEATURES,'durations':DURS,
 'embeddings':{name:arr(e.weight) for name,e in zip(FEATURES,model.embeddings)},'blocks':[{**{k:linear(getattr(b,k)) for k in ['ln1','q','k','v','o','ln2','ff1','ff2']},'relative':arr(b.relative)} for b in model.blocks],
 'lnFinal':linear(model.ln_final),'nextChord':linear(model.next_chord),'pitchOutput':linear(model.pitch),'durationOutput':linear(model.duration),'affinityOutput':linear(model.affinity),'parityProbes':probes}
 payload=json.dumps(w,ensure_ascii=False,separators=(',',':'));(output_dir/'melody-transformer-weights.js').write_text('// Learned weights; see training/scripts/train_melody.py and training provenance.\nexport const MELODY_WEIGHTS = '+payload+';\n')
 torch.save(model.state_dict(),output_dir/'melody.pt')
 meta['weightsSHA256']=hashlib.sha256(payload.encode()).hexdigest();(output_dir/'training.json').write_text(json.dumps(meta,indent=2))

def main():
 p=argparse.ArgumentParser();p.add_argument('--steps',type=int,default=1500);p.add_argument('--corpus',type=Path,default=ROOT/'data/openscore-cc0.json');p.add_argument('--output-dir',type=Path,default=ROOT/'runs/melody');args=p.parse_args();torch.manual_seed(SEED);torch.set_num_threads(1)
 train,seen=dataset(4500,SEED);valid,held=dataset(300,SEED+1,True);assert not seen.intersection(held)
 real=None;corpus_meta=None
 if args.corpus:
  real,corpus_meta=load_real(args.corpus)
  train=tuple(torch.cat([a,b],dim=0) for a,b in zip(train,real['train']))
  print(json.dumps({'sourceExcerpts':corpus_meta['excerpts'],'sourceWorksUsed':corpus_meta['worksUsed']}),flush=True)
 model=MelodyTransformer();initial=evaluate(model,valid);real_initial=evaluate(model,real['validation']) if real else None;counts=torch.bincount(train[1][train[1]>=0],minlength=25).float()+1;baseline=float(-(counts/counts.sum()).log()[valid[1][valid[1]>=0]].mean())
 opt=torch.optim.AdamW(model.parameters(),lr=.0017,weight_decay=.035);best=1e9;best_state=None;curve=[];begin=time.time()
 print(json.dumps({'initial':initial,'unigramPitchCE':baseline,'parameters':sum(p.numel() for p in model.parameters())}),flush=True)
 for step in range(1,args.steps+1):
  model.train();idx=torch.randint(len(train[0]),(16,));opt.zero_grad(set_to_none=True);loss=losses(model,train,idx);loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1);opt.step()
  for group in opt.param_groups:group['lr']=.00015+.00155*.5*(1+math.cos(math.pi*step/args.steps))
  if step%100==0 or step==args.steps:
   metrics=evaluate(model,valid);real_metrics=evaluate(model,real['validation']) if real else None;curve.append({'step':step,**metrics,'realValidation':real_metrics});print(json.dumps({'step':step,'seconds':round(time.time()-begin),**metrics}),flush=True)
   score=metrics['pitchCE']+.55*metrics['durationCE']
   if real_metrics:score+=.3*(real_metrics['pitchCE']+.55*real_metrics['durationCE'])
   if score<best:best=score;best_state=copy.deepcopy(model.state_dict());best_step=step
 model.load_state_dict(best_state);model.eval();metrics=evaluate(model,valid)
 meta={'trained':True,'seed':SEED,'steps':args.steps,'selectedStep':best_step,'parameterCount':sum(p.numel() for p in model.parameters()),'optimizer':'AdamW','trainingPhrases':len(train[0]),'validationPhrases':len(valid[0]),'validation':metrics,'initial':initial,'unigramPitchCE':baseline,'corpus':'Original dynamically authored two-bar themes with antecedent, answer, development and return; explicit motif-memory conditioning, plus CC0 OpenScore Lieder vocal excerpts labeled classical only.','split':'Disjoint held-out harmonic templates and independent theme seeds; exact sequence intersection zero. Real scores, when supplied, split at composition level.','styles':['pop','jazz','blues','classical','ambient'],'feedback':'Learned 12-class next-harmony pitch-class affinity. The affinity head cannot see the upcoming-chord condition.','curve':curve,'realCorpus':corpus_meta,'realValidation':evaluate(model,real['validation']) if real else None,'realInitial':real_initial}
 assert metrics['pitchCE']<baseline and metrics['durationCE']<initial['durationCE']
 export(model,meta,valid,args.output_dir);print(json.dumps({'done':True,'selectedStep':best_step,'metrics':metrics}),flush=True)
if __name__=='__main__':main()
