#!/usr/bin/env python3
"""Train the Cantelvio Compose 4-layer / 8-head conditional causal Transformer.
Reproducible, original synthetic phrase grammar; no copyrighted music corpus.
Use the project .venv-training Python environment.
"""
import argparse, copy, hashlib, json, math, random, time
from pathlib import Path
import torch
from torch import nn
from torch.nn import functional as F

ROOT=Path(__file__).resolve().parents[1]
QUALITIES=json.loads((ROOT/'data/chord-qualities.json').read_text())
QI={q['id']:i for i,q in enumerate(QUALITIES)}
V=len(QUALITIES)*12
VARIANTS=[(q*12+r,inv) for q,quality in enumerate(QUALITIES) for r in range(12) for inv in range(len(quality["intervals"]))]
D,HEADS,LAYERS,FF,CONTEXT,SEED=64,8,4,192,24,926734
# Validation holds out these exact degree templates, not alternate spellings of training phrases.
TRAIN=[[0,3,4,0],[0,5,1,4,0],[0,4,5,3],[0,2,5,1,4,0],[3,4,2,5,1,4,0],[0,3,1,4,0],[0,5,3,4,0],[1,4,0],[2,5,1,4,0],[0,6,3,4,0],[0,3,0,4,0],[5,3,1,4,0],[0,2,3,4,0],[3,2,1,4,0]]
VALID=[[0,5,2,3,1,4,0],[3,4,5,1,4,0],[0,1,3,4,0],[2,3,5,1,4,0]]
MAJOR=[0,2,4,5,7,9,11];MINOR=[0,2,3,5,7,8,10]

def weighted(rng, items):
 return rng.choices([a for a,b in items],weights=[b for a,b in items])[0]

def quality(rng, kind, style, root, mode):
 if kind=='major':
  sets=[[('maj',14),('add9',2),('sus2',1),('six',1)], [('maj',15),('six',2),('maj7',1)], [('maj7',8),('maj9',6),('six9',4),('maj13',1),('maj7s11',2),('maj9s11',1)], [('maj',5),('maj7',3),('add11',1),('aug',1),('power',1)]]
 elif kind=='minor':
  sets=[[('min',15),('min7',2),('minadd9',1)], [('min',14),('min6',2),('minmaj7',1)], [('min7',8),('min9',5),('min11',3),('min6',2),('min13',1)], [('min',6),('min7',3),('minmaj9',1),('minadd9',1)]]
 elif kind=='diminished':
  sets=[[('dim',7),('half',3)], [('dim',5),('dim7',7),('half',3)], [('half',9),('dim7',3)], [('dim',4),('dim7',5),('half',3)]]
 else:
  sets=[[('maj',8),('dom7',10),('sus4',2),('sus7',2)], [('maj',4),('dom7',15),('dom7b9',2),('dim7',1)], [('dom7',6),('dom9',7),('dom13',5),('dom7b9',3),('dom7s9',3),('dom7s11',1),('dom9s11',1),('dom7b13',2),('dom13b9',2),('dom7b5',1),('dom7s5',1)], [('dom7',7),('dom9',2),('dom11',1),('sus27',1),('dom7s5',2),('dom7b5',2)]]
 return QI[weighted(rng,sets[style])]

def inversion(rng,q,degree,final=False,force_first=False):
 n=len(QUALITIES[q]['intervals'])
 if force_first:return 1
 if final:return 0
 w=[.64,.24,.08,.03,.006,.003,.001][:n]
 if degree==4 and n>=4:w=[.55,.18,.17,.10]+w[4:]
 return rng.choices(range(n),weights=w)[0]

def make_phrase(rng,templates,index,coverage=False):
 mode=rng.randrange(2); style=rng.randrange(4); scale=MINOR if mode else MAJOR
 roots=[]
 for segment in range(rng.randint(2,3)):
  degrees=rng.choice(templates)
  for j,degree in enumerate(degrees):
   root=scale[degree]
   kind=('minor','diminished','major','minor','dominant','major','major')[degree] if mode else ('major','minor','minor','major','dominant','minor','diminished')[degree]
   # Secondary dominants and chromatic leading tones target the next local degree.
   if j>0 and degree!=4 and rng.random()<.19:
    aq=quality(rng,'dominant',style,(root+7)%12,mode)
    roots.append((aq*12+(root+7)%12,inversion(rng,aq,4)))
   if j>0 and rng.random()<.08:
    q=QI['dim7'];roots.append((q*12+(root-1)%12,inversion(rng,q,6)))
   if degree==4 and rng.random()<.12:
    roots.append((QI['maj']*12+1,1)) # Neapolitan sixth, then dominant.
   q=quality(rng,kind,style,root,mode)
   token=q*12+root; inv=inversion(rng,q,degree,final=j==len(degrees)-1)
   if not roots or roots[-1][0]!=token:roots.append((token,inv))
 # Coverage examples teach rare qualities/roots/inversions in a resolving context.
 # Deterministic enumeration covers every symbol; these are not corpus-frequency claims.
 if coverage and index<len(VARIANTS):
  token,inv=VARIANTS[index];q,root=divmod(token,12)
  target=(root+5)%12 if QUALITIES[q]['id'].startswith('dom') else (root+1)%12 if 'dim' in QUALITIES[q]['id'] else root
  tq=QI['min' if mode else 'maj']
  # Put rare voicings after a musically related preparation, not all after tonic.
  # Otherwise the coverage exercise would teach C -> every exotic chord at an unrealistically high rate.
  prep_q=QI['min7'] if QUALITIES[q]['id'].startswith('dom') else QI['dom7']
  prep_root=(root+7)%12
  roots=[(prep_q*12+prep_root,0),(q*12+root,inv),(tq*12+target,0)]+roots
 return roots[:CONTEXT+1],mode,style

def dataset(count,seed,templates,exclude=None,coverage=False):
 rng=random.Random(seed); rows=[];seen=set();attempt=0
 while len(rows)<count:
  seq,mode,style=make_phrase(rng,templates,attempt,coverage);attempt+=1
  signature=(tuple(seq),mode,style)
  if signature in seen or exclude and signature in exclude:continue
  seen.add(signature);rows.append((seq,mode,style))
 bases=torch.zeros(count,CONTEXT,dtype=torch.long);invs=bases.clone();targets=torch.full_like(bases,-100);invtargets=targets.clone()
 modes=torch.zeros(count,dtype=torch.long);styles=modes.clone()
 for i,(seq,m,s) in enumerate(rows):
  modes[i]=m;styles[i]=s
  for t in range(len(seq)-1):
   bases[i,t],invs[i,t]=seq[t];targets[i,t],invtargets[i,t]=seq[t+1]
 return (bases,invs,modes,styles,targets,invtargets),seen

class Block(nn.Module):
 def __init__(self):
  super().__init__();self.ln1=nn.LayerNorm(D);self.q=nn.Linear(D,D);self.k=nn.Linear(D,D);self.v=nn.Linear(D,D);self.o=nn.Linear(D,D);self.ln2=nn.LayerNorm(D);self.ff1=nn.Linear(D,FF);self.ff2=nn.Linear(FF,D)
 def forward(self,x,return_attention=False):
  b,t,d=x.shape;z=self.ln1(x)
  q,k,v=[layer(z).view(b,t,HEADS,D//HEADS).transpose(1,2) for layer in (self.q,self.k,self.v)]
  score=q@k.transpose(-1,-2)/math.sqrt(D//HEADS)
  score=score.masked_fill(torch.triu(torch.ones(t,t,dtype=torch.bool,device=x.device),1),float('-inf'))
  attention=score.softmax(-1)
  out=(attention@v).transpose(1,2).reshape(b,t,D)
  x=x+F.dropout(self.o(out),p=.08,training=self.training)
  x=x+F.dropout(self.ff2(F.gelu(self.ff1(self.ln2(x)),approximate='tanh')),p=.08,training=self.training)
  return x,attention

class HarmonyTransformer(nn.Module):
 def __init__(self):
  super().__init__();self.root=nn.Embedding(12,D);self.quality=nn.Embedding(len(QUALITIES),D);self.inversion=nn.Embedding(7,D);self.mode=nn.Embedding(2,D);self.style=nn.Embedding(4,D);self.position=nn.Embedding(CONTEXT,D);self.blocks=nn.ModuleList([Block() for _ in range(LAYERS)]);self.ln_final=nn.LayerNorm(D);self.output=nn.Linear(D,V);self.inv_output=nn.Linear(D,7)
 def chord_embedding(self,t):return self.root(t%12)+self.quality(t//12)
 def forward(self,bases,invs,modes,styles,targets=None):
  x=self.chord_embedding(bases)+self.inversion(invs)+self.mode(modes)[:,None]+self.style(styles)[:,None]+self.position(torch.arange(bases.shape[1]))
  attention=[]
  for block in self.blocks:x,a=block(x);attention.append(a)
  h=self.ln_final(x);logits=self.output(h)
  inv_logits=self.inv_output(torch.tanh(h+self.chord_embedding(targets.clamp_min(0)))) if targets is not None else None
  return logits,inv_logits,attention,h

def loss_on(model,data,indices=None):
 b,i,m,s,y,yi=[v if indices is None else v[indices] for v in data]
 logits,inv,_,_=model(b,i,m,s,y)
 return F.cross_entropy(logits.reshape(-1,V),y.reshape(-1),ignore_index=-100,label_smoothing=.025)+.3*F.cross_entropy(inv.reshape(-1,7),yi.reshape(-1),ignore_index=-100)

@torch.no_grad()
def evaluate(model,data):
 model.eval();total=n=0;correct=inv_correct=0
 for start in range(0,len(data[0]),64):
  b,i,m,s,y,yi=[v[start:start+64] for v in data]; logits,inv,_,_=model(b,i,m,s,y);mask=y!=-100;size=int(mask.sum())
  total+=float(F.cross_entropy(logits.reshape(-1,V),y.reshape(-1),ignore_index=-100,reduction='sum'));n+=size
  correct+=int(((logits.argmax(-1)==y)&mask).sum());inv_correct+=int(((inv.argmax(-1)==yi)&mask).sum())
 return {'crossEntropy':round(total/n,6),'perplexity':round(math.exp(total/n),6),'top1':round(correct/n,6),'inversionTop1':round(inv_correct/n,6),'targets':n}

def arr(x):
 def rounded(v):return [rounded(n) for n in v] if isinstance(v,list) else round(v,8)
 return rounded(x.detach().cpu().tolist())
def layer(x):return {'weight':arr(x.weight),'bias':arr(x.bias)}

def export(model,metadata,path):
 probes=[]
 for bases,invs,mode,style in [([0,5*12+2,10*12+7],[0,0,1],0,2),([12,12+5,10*12+7],[0,1,3],1,1),([0,10*12+9,12+2,10*12+7],[1,2,0,0],0,3)]:
  with torch.no_grad():
   logits,_,atts,h=model(torch.tensor([bases]),torch.tensor([invs]),torch.tensor([mode]),torch.tensor([style]))
   invlog=model.inv_output(torch.tanh(h[0,-1]+model.chord_embedding(torch.arange(V))))
  probes.append({'tokens':bases,'inversions':invs,'mode':mode,'style':style,'logits':arr(logits[0,-1]),'inversionLogits':arr(invlog),'attention':arr(torch.stack([a[0] for a in atts]))})
 weights={'format':2,'architecture':{'contextLength':CONTEXT,'layers':LAYERS,'dModel':D,'heads':HEADS,'dHead':D//HEADS,'dFF':FF,'activation':'gelu-tanh','layerNormEpsilon':1e-5},'training':metadata,
 'rootEmbedding':arr(model.root.weight),'qualityEmbedding':arr(model.quality.weight),'inversionEmbedding':arr(model.inversion.weight),'modeEmbedding':arr(model.mode.weight),'styleEmbedding':arr(model.style.weight),'positionEmbedding':arr(model.position.weight),
 'blocks':[{k:layer(getattr(block,k)) for k in ['ln1','q','k','v','o','ln2','ff1','ff2']} for block in model.blocks], 'lnFinal':layer(model.ln_final),'output':layer(model.output),'inversionOutput':layer(model.inv_output),'parityProbes':probes}
 path.write_text('// Generated by training/scripts/train_harmony.py. Original synthetic phrase grammar.\nexport const HARMONY_TRANSFORMER_WEIGHTS = '+json.dumps(weights,ensure_ascii=False,separators=(',',':'))+';\n')

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--steps',type=int,default=1600);parser.add_argument('--output-dir',type=Path,default=ROOT/'runs/harmony');args=parser.parse_args()
 random.seed(SEED);torch.manual_seed(SEED);torch.set_num_threads(1)
 train,seen=dataset(4800,SEED,TRAIN,coverage=True);valid,_=dataset(512,SEED+1,VALID,seen)
 observed=set(zip(train[4][train[4]>=0].tolist(),train[5][train[4]>=0].tolist()))
 assert set(VARIANTS).issubset(observed), "Every inversion must have a training target"
 model=HarmonyTransformer();initial=evaluate(model,valid)
 counts=torch.bincount(train[4][train[4]>=0],minlength=V).float()+1;logp=(counts/counts.sum()).log();baseline=float(-logp[valid[4][valid[4]>=0]].mean())
 opt=torch.optim.AdamW(model.parameters(),lr=.0016,weight_decay=.035);best=float('inf');best_state=None;best_step=0;beg=time.time();curve=[]
 for step in range(1,args.steps+1):
  model.train();idx=torch.randint(len(train[0]),(32,));opt.zero_grad(set_to_none=True);loss=loss_on(model,train,idx);loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1);opt.step()
  for group in opt.param_groups:group['lr']=.00015+.00145*.5*(1+math.cos(math.pi*step/args.steps))
  if step%200==0 or step==args.steps:
   metrics=evaluate(model,valid);curve.append({'step':step,**metrics});print(json.dumps({'step':step,'seconds':round(time.time()-beg),**metrics}),flush=True)
   if metrics['crossEntropy']<best:best=metrics['crossEntropy'];best_step=step;best_state=copy.deepcopy(model.state_dict())
 model.load_state_dict(best_state);model.eval();validation=evaluate(model,valid);training=evaluate(model,tuple(v[:512] for v in train))
 metadata={'trained':True,'seed':SEED,'steps':args.steps,'selectedStep':best_step,'optimizer':'AdamW','learningRate':.0016,'dropout':.08,'labelSmoothing':.025,'trainingPhraseCount':len(train[0]),'validationPhraseCount':len(valid[0]),'parameterCount':sum(p.numel() for p in model.parameters()),'coveredChordInversions':len(observed),'trainingMetricSubsetPhrases':512,'trainingMetrics':training,'validationMetrics':validation,'unigramValidationCrossEntropy':round(baseline,6),'initialValidationCrossEntropy':initial['crossEntropy'],'corpus':'Original synthetic major/minor phrase grammar; no real-music recordings or corpus','split':'Held-out degree templates and disjoint exact sequences','conditioning':'relative root, chord quality, inversion, key mode, style, up to 24 previous chords','qualityOrder':[q['id'] for q in QUALITIES], 'curve':curve}
 assert best < baseline, (best,baseline)
 args.output_dir.mkdir(parents=True,exist_ok=True)
 export(model,metadata,args.output_dir/'harmony-transformer.js')
 torch.save(model.state_dict(),args.output_dir/'harmony.pt')
 (args.output_dir/'training.json').write_text(json.dumps(metadata,indent=2))
 print(json.dumps(metadata,indent=2))
if __name__=='__main__':main()
