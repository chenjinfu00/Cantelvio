#!/usr/bin/env python3
"""Original phrase corpus -> conditional melody Transformer. No third-party compositions.
Use tonnetz-karaoke/.venv-harmony-training/bin/python (existing PyTorch environment).
"""
import argparse, copy, hashlib, json, math, random, time
from pathlib import Path
import torch
from torch import nn
from torch.nn import functional as F
ROOT=Path(__file__).resolve().parents[1]
Q=json.loads((ROOT/'scripts/tonnetz-chord-qualities.json').read_text()); QI={q['id']:i for i,q in enumerate(Q)}
D,H,L,FF,CTX,SEED=64,8,4,160,64,926908
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
def make_phrase(rng,motifs,progressions,index):
 style=index%5;mode=rng.randrange(2);pattern=rng.randrange(4);rhythm=rng.choices(range(5),[7,1,2,2,2])[0];density=rng.randrange(3);meter=12 if rng.random()<.15 else 16
 scale=MIN if mode else MAJ;degrees=rng.choice(progressions);motif=rng.choice(motifs)
 chords=[]
 for deg in degrees+[0]:
  root=scale[deg];kind=('min','dim','maj','min','maj','maj','maj')[deg] if mode else ('maj','min','min','maj','maj','min','dim')[deg]
  if style==1:quality={'maj':rng.choice(['maj7','six','maj9']), 'min':rng.choice(['min7','min9']), 'dim':'half'}[kind];quality='dom7' if deg==4 else quality
  elif style==2:quality='dom7' if deg in [0,3,4] and not mode else kind
  elif style==4:quality={'maj':'maj7','min':'min7','dim':'half'}[kind]
  else:quality='dom7' if deg==4 and rng.random()<.5 else kind
  if rng.random()<.045:root=rng.randrange(12);quality=rng.choice(Q)['id']
  q=QI[quality];inv=rng.choices(range(len(Q[q]['intervals'])),[7]+[1]*(len(Q[q]['intervals'])-1))[0]
  chords.append((root,q,inv))
 scale_notes=[n for n in range(24) if n%12 in scale]
 previous=rng.choice([7,9,12,14,16]);prev_token=BOS;prev_dur=3;rows=[];targets=[];dur_targets=[];harmony_targets=[]
 for bar in range(8):
  root,q,inv=chords[bar];nroot,nq,_=chords[bar+1];pcs=[(root+x)%12 for x in Q[q]['intervals']];npcs=[(nroot+x)%12 for x in Q[nq]['intervals']]
  tones=[n for n in range(24) if n%12 in pcs];guide=near(tones,previous)
  center=scale_notes.index(near(scale_notes,guide));phase=bar%4
  if rhythm==1:durations=[4]*4
  elif rhythm in [2,3]:durations=rng.choice(RHYTHMS[1 if rhythm==3 else 3])
  elif rhythm==4:durations=rng.choice(RHYTHMS[0])
  else:durations=rng.choice(RHYTHMS[style])
  if density==0:durations=[8,4,4] if style!=4 else [8,8]
  elif density==2 and style in [1,3]:durations=[2]*8
  if phase==3:durations=[4,4,4,4] if density else [8,4,4]
  slot=0;i=0
  while slot<meter:
   duration=min(durations[i%len(durations)],meter-slot)
   if duration not in DURS:duration=max(d for d in DURS if d<=duration)
   is_rest=(phase==3 and slot>=meter-4) or (pattern==2 and phase%2==1 and slot==0) or (i>0 and slot%4 and rng.random()<.05)
   desired=scale_notes[max(0,min(len(scale_notes)-1,center+motif[(i+(0 if phase in [0,2] else 2))%len(motif)]))]
   if pattern==1:desired=guide+round(7*math.sin(math.pi*slot/meter))-(2 if phase==3 else 0)
   elif pattern==3:desired=tones[(tones.index(guide)+i)%len(tones)]
   if phase==3:desired=guide-round(slot/4)
   if style==2 and not slot%2:
    blues=[n for n in range(24) if n%12 in [0,3,5,6,7,10]];desired=near(blues,desired)
   strong=slot%8==0
   candidates=tones if strong or pattern==3 or style==4 else [n for n in range(24) if n%12 in set(scale+pcs)]
   if style==2 and not strong:candidates=[n for n in range(24) if n%12 in set([0,3,5,6,7,10]+pcs)]
   def cost(n):return .7*abs(n-desired)+.32*abs(n-previous)+.55*max(0,abs(n-previous)-5)**2+(.7 if n==previous and i>1 else 0)+rng.random()*.2
   token=min(candidates,key=cost)
   if style==1 and slot>=meter-2 and phase!=3:
    target=near([n for n in range(24) if n%12 in npcs],previous);choices=[n for n in [target-1,target+1] if 0<=n<24 and abs(n-previous)<=4]
    if choices:token=near(choices,previous)
   if phase==3 and slot==0:token=near(tones,previous-2)
   if is_rest:token=REST
   condition=[0.0]*12
   for p in npcs:condition[p]=1.0
   # Pitch/duration targets have shifted inputs. The affinity head never sees condition.
   rows.append([prev_token,prev_dur,root,q,inv,mode,style,pattern,rhythm,slot,bar,density,0 if meter==16 else 1])
   targets.append(token);dur_targets.append(DURS.index(duration));harmony_targets.append(condition)
   prev_token=token;prev_dur=DURS.index(duration)
   if token!=REST:previous=token
   slot+=duration;i+=1
 return rows[:CTX],targets[:CTX],dur_targets[:CTX],harmony_targets[:CTX]

def dataset(count,seed,valid=False):
 rng=random.Random(seed);rows=[]
 for i in range(count):rows.append(make_phrase(rng,VALID_MOTIFS if valid else TRAIN_MOTIFS,VALID_PROGRESSIONS if valid else TRAIN_PROGRESSIONS,i))
 x=torch.zeros(count,CTX,13,dtype=torch.long);y=torch.full((count,CTX),-100,dtype=torch.long);d=y.clone();n=torch.zeros(count,CTX,12)
 signatures=set()
 for i,(a,b,c,e) in enumerate(rows):
  size=len(a);x[i,:size]=torch.tensor(a);y[i,:size]=torch.tensor(b);d[i,:size]=torch.tensor(c);n[i,:size]=torch.tensor(e);signatures.add(json.dumps([a,b,c]))
 return (x,y,d,n),signatures

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

FEATURES=['pitch','duration','root','quality','inversion','mode','style','pattern','rhythm','slot','phrase','density','meter']
SIZES=[26,8,12,40,7,2,5,4,5,16,8,3,2]
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
def export(model,meta,data):
 probes=[]
 for idx in [0,1,3]:
  x,y,d,n=[a[idx:idx+1,:9] for a in data]
  with torch.no_grad():p,du,h,attention=model(x,n)
  probes.append({'features':x[0].tolist(),'nextChord':n[0].tolist(),'pitch':arr(p[0]),'duration':arr(du[0]),'affinity':arr(h[0]),'attention':arr(torch.stack([a[0] for a in attention]))})
 w={'format':1,'architecture':{'dModel':D,'heads':H,'layers':L,'dHead':D//H,'dFF':FF,'contextLength':CTX,'layerNormEpsilon':1e-5,'relativeAttention':True},'training':meta,'featureNames':FEATURES,'durations':DURS,
 'embeddings':{name:arr(e.weight) for name,e in zip(FEATURES,model.embeddings)},'blocks':[{**{k:linear(getattr(b,k)) for k in ['ln1','q','k','v','o','ln2','ff1','ff2']},'relative':arr(b.relative)} for b in model.blocks],
 'lnFinal':linear(model.ln_final),'nextChord':linear(model.next_chord),'pitchOutput':linear(model.pitch),'durationOutput':linear(model.duration),'affinityOutput':linear(model.affinity),'parityProbes':probes}
 payload=json.dumps(w,ensure_ascii=False,separators=(',',':'));(ROOT/'public/tonnetz/lib/melody-transformer-weights.js').write_text('// Learned weights; see scripts/train-tonnetz-melody.py and training provenance.\nexport const MELODY_WEIGHTS = '+payload+';\n')
 torch.save(model.state_dict(),ROOT/'scripts/tonnetz-melody-training.pt')
 meta['weightsSHA256']=hashlib.sha256(payload.encode()).hexdigest();(ROOT/'docs/tonnetz-melody-training.json').write_text(json.dumps(meta,indent=2))

def main():
 p=argparse.ArgumentParser();p.add_argument('--steps',type=int,default=1200);args=p.parse_args();torch.manual_seed(SEED);torch.set_num_threads(1)
 train,seen=dataset(3000,SEED);valid,held=dataset(240,SEED+1,True);assert not seen.intersection(held)
 model=MelodyTransformer();initial=evaluate(model,valid);counts=torch.bincount(train[1][train[1]>=0],minlength=25).float()+1;baseline=float(-(counts/counts.sum()).log()[valid[1][valid[1]>=0]].mean())
 opt=torch.optim.AdamW(model.parameters(),lr=.0017,weight_decay=.035);best=1e9;best_state=None;curve=[];begin=time.time()
 print(json.dumps({'initial':initial,'unigramPitchCE':baseline,'parameters':sum(p.numel() for p in model.parameters())}),flush=True)
 for step in range(1,args.steps+1):
  model.train();idx=torch.randint(len(train[0]),(24,));opt.zero_grad(set_to_none=True);loss=losses(model,train,idx);loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1);opt.step()
  for group in opt.param_groups:group['lr']=.00015+.00155*.5*(1+math.cos(math.pi*step/args.steps))
  if step%150==0 or step==args.steps:
   metrics=evaluate(model,valid);curve.append({'step':step,**metrics});print(json.dumps({'step':step,'seconds':round(time.time()-begin),**metrics}),flush=True)
   score=metrics['pitchCE']+.55*metrics['durationCE']
   if score<best:best=score;best_state=copy.deepcopy(model.state_dict());best_step=step
 model.load_state_dict(best_state);model.eval();metrics=evaluate(model,valid)
 meta={'trained':True,'seed':SEED,'steps':args.steps,'selectedStep':best_step,'parameterCount':sum(p.numel() for p in model.parameters()),'optimizer':'AdamW','trainingPhrases':3000,'validationPhrases':240,'validation':metrics,'initial':initial,'unigramPitchCE':baseline,'corpus':'Original eight-bar melodic motif, rhythm and harmony grammar. No third-party compositions or composer emulation.','split':'Disjoint held-out contour families and harmonic templates; exact sequence intersection zero.','styles':['pop','jazz','blues','classical','ambient'],'feedback':'Learned 12-class next-harmony pitch-class affinity. The affinity head cannot see the upcoming-chord condition.','curve':curve}
 assert metrics['pitchCE']<baseline and metrics['durationCE']<initial['durationCE']
 export(model,meta,valid);print(json.dumps({'done':True,'selectedStep':best_step,'metrics':metrics}),flush=True)
if __name__=='__main__':main()
