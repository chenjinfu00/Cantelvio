import {getChord} from '../vendor/lib/chord-vocabulary.js';
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
/** Aggregate inversion tokens before measuring certainty; otherwise a rich chord
 * vocabulary would appear uncertain merely because it permits more inversions. */
export function distributionEvidence(distribution,id){
 const masses=new Map();for(const item of distribution||[]){const chord=getChord(item.id);if(chord&&Number.isFinite(item.probability)&&item.probability>0)masses.set(chord.baseIndex,(masses.get(chord.baseIndex)||0)+item.probability);}
 const total=[...masses.values()].reduce((a,b)=>a+b,0);if(!total)return {confidence:0,entropy:1,selectedMass:0};
 const probabilities=[...masses.values()].map(p=>p/total),confidence=Math.max(...probabilities);
 const entropy=-probabilities.reduce((sum,p)=>sum+p*Math.log(p),0)/Math.log(480);
 return {confidence,entropy:clamp(entropy),selectedMass:(masses.get(getChord(id)?.baseIndex)||0)/total};
}
/** Stable independent draw: duration choices never consume the harmony RNG.
 * Every-bar prediction sequences remain unchanged; a preview never rerolls. */
export function durationDraw(uid,id){let n=2166136261;for(const c of `${uid}:${id}`)n=Math.imul(n^c.charCodeAt(0),16777619);n=Math.imul(n^(n>>>16),2246822507);n=Math.imul(n^(n>>>13),3266489909);return ((n^(n>>>16))>>>0)/4294967296;}
export function chooseDurationSpec(evidence,id,key,draw){
 const chord=getChord(id),certainty=clamp(Math.sqrt(evidence.confidence)*(1-evidence.entropy)),uncertainty=clamp(evidence.entropy/.65);
 const selectedSupport=evidence.confidence?clamp(evidence.selectedMass/evidence.confidence):0;
 const settled=chord?.root===key.tonic&&['maj','min','maj7','min7'].includes(chord.quality);
 const weights=[.06+.26*uncertainty*(1-.4*selectedSupport),.24+.50*uncertainty,.55+.35*certainty,.10+1.5*certainty*(settled?1.35:.85)];
 const choices=[{unit:'beats',count:1},{unit:'beats',count:2},{unit:'bars',count:1},{unit:'bars',count:2}];let point=clamp(draw,0,1-Number.EPSILON)*weights.reduce((a,b)=>a+b,0);
 for(let i=0;i<weights.length;i++){point-=weights[i];if(point<0)return choices[i];}return choices.at(-1);
}
export const durationBeats=(spec,mode,beatsPerBar)=>mode==='free'?(spec.unit==='bars'?spec.count*beatsPerBar:spec.count):beatsPerBar;
export function durationLabel(beats,meter,language='en'){if(beats>=meter&&beats%meter===0){const n=beats/meter;return language==='en'?`${n} ${n===1?'bar':'bars'}`:`${n} 小节`;}return language==='en'?`${beats} ${beats===1?'beat':'beats'}`:`${beats} 拍`;}
