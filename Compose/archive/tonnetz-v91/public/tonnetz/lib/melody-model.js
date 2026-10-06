import { MELODY_WEIGHTS as W } from './melody-transformer-weights.js';
export const MELODY_METADATA=Object.freeze({architecture:W.architecture,training:W.training});
export const MELODY_DURATIONS=Object.freeze(W.durations);
export const MELODY_FEATURES=Object.freeze(W.featureNames);
const softmax=a=>{const m=Math.max(...a),p=a.map(n=>Number.isFinite(n)?Math.exp(n-m):0),sum=p.reduce((x,y)=>x+y,0);return p.map(n=>n/sum);};
const linear=(x,l)=>l.weight.map((r,j)=>r.reduce((n,w,i)=>n+w*x[i],l.bias[j]));
function norm(x,l){const mean=x.reduce((a,b)=>a+b,0)/x.length,variance=x.reduce((a,b)=>a+(b-mean)**2,0)/x.length,scale=1/Math.sqrt(variance+W.architecture.layerNormEpsilon);return x.map((n,i)=>(n-mean)*scale*l.weight[i]+l.bias[i]);}
const gelu=x=>.5*x*(1+Math.tanh(Math.sqrt(2/Math.PI)*(x+.044715*x*x*x)));
/** Streaming KV cache: one causal query per event; bounded memory even after hours of playing. */
export function createMelodyDecoder(weights=W){
 const {dModel,heads,dHead,contextLength}=weights.architecture;
 let cache=weights.blocks.map(()=>({k:[],v:[]})),count=0;
 function step(features,nextChord=Array(12).fill(0)){
  if(features.length!==weights.featureNames.length||features.some((n,i)=>!Number.isInteger(n)||!weights.embeddings[weights.featureNames[i]][n]))throw new RangeError('Invalid melody features');
  if(nextChord.length!==12||nextChord.some(n=>!Number.isFinite(n)))throw new RangeError('Invalid future chord condition');
  let x=Array(dModel).fill(0);features.forEach((n,i)=>weights.embeddings[weights.featureNames[i]][n].forEach((v,j)=>x[j]+=v));
  const attention=[];
  for(let layer=0;layer<weights.blocks.length;layer++){
   const b=weights.blocks[layer],c=cache[layer],z=norm(x,b.ln1),q=linear(z,b.q);
   c.k.push(linear(z,b.k));c.v.push(linear(z,b.v));if(c.k.length>contextLength){c.k.shift();c.v.shift();}
   const mixed=Array(dModel).fill(0),rows=[];
   for(let head=0;head<heads;head++){
    const offset=head*dHead,scores=c.k.map((k,t)=>{let dot=0;for(let j=0;j<dHead;j++)dot+=q[offset+j]*k[offset+j];return dot/Math.sqrt(dHead)+b.relative[head][c.k.length-1-t];});
    const p=softmax(scores);rows.push(p);
    for(let t=0;t<c.v.length;t++)for(let j=0;j<dHead;j++)mixed[offset+j]+=p[t]*c.v[t][offset+j];
   }
   const o=linear(mixed,b.o);x=x.map((n,i)=>n+o[i]);
   const ff=linear(linear(norm(x,b.ln2),b.ff1).map(gelu),b.ff2);x=x.map((n,i)=>n+ff[i]);attention.push(rows);
  }
  count++;
  const h=norm(x,weights.lnFinal),future=linear(nextChord,weights.nextChord),conditioned=h.map((n,i)=>Math.tanh(n+.6*future[i]));
  return {pitchLogits:linear(conditioned,weights.pitchOutput),durationLogits:linear(h,weights.durationOutput),affinityLogits:linear(h,weights.affinityOutput),attention,count,cacheLength:cache[0].k.length};
 }
 return {step,reset(){cache=weights.blocks.map(()=>({k:[],v:[]}));count=0;},get size(){return cache[0].k.length;}};
}
/** Full-prefix interface for independent PyTorch parity and causal-attention tests. */
export function melodyForward(features,nextChords,weights=W){
 const decoder=createMelodyDecoder(weights),rows=features.map((f,i)=>decoder.step(f,nextChords[i]));
 return {pitch:rows.map(r=>r.pitchLogits),duration:rows.map(r=>r.durationLogits),affinity:rows.map(r=>r.affinityLogits),attention:weights.blocks.map((_,l)=>Array.from({length:weights.architecture.heads},(_,h)=>rows.map((r,t)=>[...r.attention[l][h],...Array(rows.length-t-1).fill(0)])))};
}
export function sampleMelodyLogits(logits,{temperature=.78,topP=.9,topK=9,random=Math.random}={}){
 const p=softmax(logits.map(n=>n/Math.max(.25,Math.min(1.5,temperature))));
 const sorted=p.map((prob,id)=>({prob,id})).filter(e=>e.prob>0).sort((a,b)=>b.prob-a.prob);
 if(!sorted.length)throw new Error('No playable melodic event');
 let sum=0;const choices=[];for(const e of sorted){choices.push(e);sum+=e.prob;if(sum>=topP||choices.length>=Math.max(1,topK))break;}
 let draw=Math.max(0,Math.min(1-Number.EPSILON,random()))*sum;
 for(const e of choices){draw-=e.prob;if(draw<0)return e.id;}
 return choices.at(-1).id;
}
