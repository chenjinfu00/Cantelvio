/** Causal exact-note head trained with the continued joint backbone.
 * Count and independent note fields are predicted after R/H/B/M at each step;
 * completed exact notes condition the *next* step, never the current one.
 */
import {EXPRESSION_META,EXPRESSION_MANIFEST,EXPRESSION_WEIGHTS_BASE64} from './joint-expression-weights.js';
import {JOINT_META} from './joint-model.js';

export {EXPRESSION_META};
const FIELDS=EXPRESSION_META.fields;
const SLOTS=EXPRESSION_META.slots;
const D=JOINT_META.config.d;

function bytesOf(encoded){
 const binary=atob(encoded),bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return bytes;
}
function rowAdd(out,table,index){
 const from=index*D;
 if(from<0||from+D>table.length)throw Error('Expression field index out of range');
 for(let i=0;i<D;i++)out[i]+=table[from+i];
}
function linear(layer,input){
 const result=new Float64Array(layer.rows);
 for(let r=0;r<layer.rows;r++){
  let sum=layer.b[r],off=r*input.length;
  for(let i=0;i<input.length;i++)sum+=layer.w[off+i]*input[i];
  result[r]=sum;
 }
 return result;
}
function norm(input,layer){
 let mean=0;
 for(const x of input)mean+=x;
 mean/=input.length;
 let variance=0;
 for(const x of input)variance+=(x-mean)*(x-mean);
 variance/=input.length;
 const scale=1/Math.sqrt(variance+1e-5),out=new Float64Array(input.length);
 for(let i=0;i<input.length;i++)out[i]=(input[i]-mean)*scale*layer.w[i]+layer.b[i];
 return out;
}
function draw(logits,random=Math.random,temperature=1){
 let max=-Infinity;
 for(const value of logits)max=Math.max(max,value);
 let total=0;
 const probs=Array.from(logits,value=>{const p=Math.exp((value-max)/temperature);total+=p;return p;});
 let pick=Math.min(Math.max(Number(random())||0,0),1-Number.EPSILON)*total;
 for(let i=0;i<probs.length;i++){pick-=probs[i];if(pick<0)return i;}
 return probs.length-1;
}
export function loadExpression(model){
 if(JOINT_META.checkpoint.sha256!==EXPRESSION_META.baseSha256)
  throw Error('Expression sidecar does not match the deployed backbone');
 const bytes=bytesOf(EXPRESSION_WEIGHTS_BASE64);
 if(bytes.byteLength!==EXPRESSION_META.float32Count*4)throw Error('Expression weights truncated');
 const all=new Float32Array(bytes.buffer,bytes.byteOffset,EXPRESSION_META.float32Count),tensors=new Map();
 for(const [name,start,shape] of EXPRESSION_MANIFEST){
  const count=shape.reduce((a,b)=>a*b,1);
  tensors.set(name,{data:all.subarray(start,start+count),shape});
 }
 const get=name=>{const tensor=tensors.get(name);if(!tensor)throw Error(`Missing expression tensor ${name}`);return tensor.data;};
 const normLayer=name=>({w:get(`${name}.weight`),b:get(`${name}.bias`)});
 const layer=name=>({w:get(`${name}.weight`),b:get(`${name}.bias`),rows:tensors.get(`${name}.weight`).shape[0]});
 const embeddings=Object.fromEntries(FIELDS.map(key=>[key,get(`embed.${key}.weight`)]));
 const fieldHeads=Object.fromEntries(FIELDS.map(key=>[key,layer(`field_head.${key}`)]));
 const vocab=EXPRESSION_META.vocab;
 const ratio=value=>{const [a,b]=String(value).split('/').map(Number);return b?a/b:a;};
 const expression={
  meta:EXPRESSION_META,
  /** Each event is {role,pitch,sub,dur,ratio,dynamic,accent,wedge}, indices. */
  extra(events){
   const out=new Float64Array(D);
   if(!events?.length)return out;
   for(const event of events){
    rowAdd(out,get('role.weight'),event.role);
    for(const key of FIELDS)rowAdd(out,embeddings[key],event[key]);
   }
   const scale=1/Math.sqrt(events.length);
   for(let i=0;i<D;i++)out[i]*=scale;
   return norm(out,normLayer('input_norm'));
  },
  predict(hidden,coarseTokens,random=Math.random){
   const coarseIn=new Float64Array(D);
   for(let s=0;s<4;s++)rowAdd(coarseIn,model.tok[s],coarseTokens[s]);
   const coarse=linear(layer('coarse'),coarseIn),out=[];
   for(let role=0;role<3;role++){
    const source=new Float64Array(D);
    for(let i=0;i<D;i++)source[i]=hidden[role][i]+coarse[i];
    const count=draw(linear(layer(`count_head.${role}`),source),random,0.85);
    for(let slot=0;slot<Math.min(count,SLOTS[role]);slot++){
     const slotInput=new Float64Array(source);
     rowAdd(slotInput,get('slot.weight'),slot);
     const feature=norm(slotInput,normLayer('out_norm'));
     const event={role};
     for(const key of FIELDS){
      const logits=linear(fieldHeads[key],feature);
      if(key==='sub'||key==='dur')logits[0]=-Infinity;
      if(key==='pitch'){
       // The sidecar was trained on absolute MIDI pitches. Keep notes in the
       // observed role's register without replacing its learned distribution.
       const [low,high]=role===1?[28,62]:role===2?[55,88]:[36,88];
       for(let i=0;i<logits.length;i++)if(i<low||i>high)logits[i]=-Infinity;
      }
      event[key]=draw(logits,random,0.85);
     }
     out.push(event);
    }
   }
   return out;
  },
  logits(hidden,coarseTokens){
   const coarseIn=new Float64Array(D);
   for(let s=0;s<4;s++)rowAdd(coarseIn,model.tok[s],coarseTokens[s]);
   const coarse=linear(layer('coarse'),coarseIn);
   return hidden.map((h,role)=>{
    const source=new Float64Array(D);
    for(let i=0;i<D;i++)source[i]=h[i]+coarse[i];
    const fields=Object.fromEntries(FIELDS.map(key=>[key,linear(fieldHeads[key],norm((()=>{const s=new Float64Array(source);rowAdd(s,get('slot.weight'),0);return s;})(),normLayer('out_norm')))]));
    return {counts:linear(layer(`count_head.${role}`),source),fields};
   });
  },
  decode(event){
   return {...event,subQuarter:ratio(vocab.sub[event.sub])/4,
    durQuarter:ratio(vocab.dur[event.dur]),ratioText:vocab.ratio[event.ratio],
    dynamicText:vocab.dynamic[event.dynamic]};
  }
 };
 return expression;
}
