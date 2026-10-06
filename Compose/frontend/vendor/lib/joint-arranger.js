/** Selected six-group arrangement adapter. Classifies already-written notes;
 * no new pitches or rhythms are invented here. Run during forecast preparation,
 * never from a scheduled-bar or audible-onset callback.
 */
import {ARRANGER_META,ARRANGER_MANIFEST,ARRANGER_WEIGHTS_BASE64} from './joint-arranger-weights.js';
export {ARRANGER_META};

const D=96,HEADS=4,DH=D/HEADS;
const DURATIONS=[1,2,3,4,5,6,8,9,10,12,15,16,18,20,24,30,32,36,42,48,60,72,84,96,120,144,168,192,240,288,336,384];
const decodeBase64=encoded=>{const binary=atob(encoded),out=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)out[i]=binary.charCodeAt(i);return out;};
const addRow=(dest,table,row)=>{const at=row*D;for(let i=0;i<D;i++)dest[i]+=table[at+i];};
function linear(weights,bias,input){
 const rows=bias.length,cols=input.length,out=new Float64Array(rows);
 for(let r=0;r<rows;r++){
  let sum=bias[r],at=r*cols;
  for(let i=0;i<cols;i++)sum+=weights[at+i]*input[i];
  out[r]=sum;
 }
 return out;
}
function norm(input,weight,bias){
 let mean=0,variance=0;
 for(const x of input)mean+=x;
 mean/=input.length;
 for(const x of input)variance+=(x-mean)**2;
 const inv=1/Math.sqrt(variance/input.length+1e-5),out=new Float64Array(input.length);
 for(let i=0;i<input.length;i++)out[i]=(input[i]-mean)*inv*weight[i]+bias[i];
 return out;
}
export function durationBucket(quarters){
 const steps=Math.max(1,quarters*ARRANGER_META.gridPerQuarter);
 let best=0,error=Infinity;
 for(let i=0;i<DURATIONS.length;i++){
  const e=Math.abs(Math.log(DURATIONS[i]/steps));
  if(e<error){error=e;best=i;}
 }
 return best;
}
export function loadArranger(){
 const bytes=decodeBase64(ARRANGER_WEIGHTS_BASE64);
 if(bytes.byteLength!==ARRANGER_META.float32Count*4)throw Error('Arranger weights truncated');
 const all=new Float32Array(bytes.buffer,bytes.byteOffset,ARRANGER_META.float32Count),tensors=new Map();
 for(const [name,start,shape] of ARRANGER_MANIFEST){
  const count=shape.reduce((a,b)=>a*b,1);
  tensors.set(name,all.subarray(start,start+count));
 }
 const t=name=>{const data=tensors.get(name);if(!data)throw Error(`Missing arranger tensor ${name}`);return data;};
 const projection=(prefix,input)=>linear(t(`${prefix}.weight`),t(`${prefix}.bias`),input);
 return {
  meta:ARRANGER_META,
  /** Input notes [{pitch,pos,dur}], with pos/dur as adapter token indices. */
  infer(notes,meter,barLen){
   if(!Number.isInteger(meter)||meter<0||meter>15||barLen<1||barLen>128)throw Error('Invalid arrangement meter');
   const kept=notes.slice(0,64),length=kept.length+1;
   let x=Array.from({length},()=>new Float64Array(D));
   for(let j=0;j<length;j++){
    const note=j?kept[j-1]:{pitch:ARRANGER_META.pitchCls,pos:0,dur:0};
    addRow(x[j],t('pitch.weight'),note.pitch);
    addRow(x[j],t('pos.weight'),note.pos);
    addRow(x[j],t('dur.weight'),note.dur);
    addRow(x[j],t('meter.weight'),meter);
    addRow(x[j],t('bar_len.weight'),barLen);
   }
   for(let layer=0;layer<2;layer++){
    const p=`encoder.layers.${layer}`;
    const query=[],key=[],value=[];
    for(let j=0;j<length;j++){
     const z=norm(x[j],t(`${p}.norm1.weight`),t(`${p}.norm1.bias`));
     const qkv=linear(t(`${p}.self_attn.in_proj_weight`),t(`${p}.self_attn.in_proj_bias`),z);
     query.push(qkv.subarray(0,D));key.push(qkv.subarray(D,2*D));value.push(qkv.subarray(2*D));
    }
    const next=[];
    for(let j=0;j<length;j++){
     const joined=new Float64Array(D);
     for(let head=0;head<HEADS;head++){
      const off=head*DH,score=new Float64Array(length);
      let max=-Infinity;
      for(let k=0;k<length;k++){
       let dot=0;
       for(let i=0;i<DH;i++)dot+=query[j][off+i]*key[k][off+i];
       score[k]=dot/Math.sqrt(DH);max=Math.max(max,score[k]);
      }
      let total=0;
      for(let k=0;k<length;k++){score[k]=Math.exp(score[k]-max);total+=score[k];}
      for(let k=0;k<length;k++){
       const weight=score[k]/total;
       for(let i=0;i<DH;i++)joined[off+i]+=weight*value[k][off+i];
      }
     }
     const attention=projection(`${p}.self_attn.out_proj`,joined);
     const residual=new Float64Array(D);
     for(let i=0;i<D;i++)residual[i]=x[j][i]+attention[i];
     const z=norm(residual,t(`${p}.norm2.weight`),t(`${p}.norm2.bias`));
     const hidden=projection(`${p}.linear1`,z);
     for(let i=0;i<hidden.length;i++)hidden[i]=Math.max(0,hidden[i]);
     const ff=projection(`${p}.linear2`,hidden);
     for(let i=0;i<D;i++)residual[i]+=ff[i];
     next.push(residual);
    }
    x=next;
   }
   const outputs=x.map(v=>norm(v,t('norm.weight'),t('norm.bias')));
   return {logits:outputs.slice(1).map(v=>projection('group',v)),presence:projection('presence',outputs[0])};
  },
  /** Convert exact quarter-note positions and durations into the MIDI training grid. */
  classify(events,signature,barQuarters){
   const meter=Math.max(0,ARRANGER_META.meters.indexOf(signature));
   const barLen=Math.round(barQuarters*ARRANGER_META.gridPerQuarter);
   const notes=events.map(event=>({pitch:event.pitch,
    pos:Math.max(0,Math.min(127,Math.round(event.onsetQuarter*ARRANGER_META.gridPerQuarter))),
    dur:durationBucket(event.durationQuarter)}));
   return this.infer(notes,meter,barLen).logits;
  }
 };
}
