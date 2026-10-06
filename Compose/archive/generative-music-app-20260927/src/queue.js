import {advanceTonality} from '../vendor/lib/tonality.js';
import {getChord} from '../vendor/lib/chord-vocabulary.js';
import {distributionEvidence,chooseDurationSpec,durationDraw,durationBeats} from './duration-policy.js';
/** Canonical cursor advances only when a chord actually sounds. Planning may
 * extend the committed tail, but cannot consume unheard advertised chords. */
export class ChordQueue {
 constructor({predict,sample,options,random=Math.random}){Object.assign(this,{predict,sample,options,random});this.serial=0;this.revision=0;this.history=[];this.slots=[];}
 view(){return {revision:this.revision,slots:structuredClone(this.slots.slice(0,4))};}
 decorate(slot,distribution){const o=this.options(),meter=o.beatsPerBar||4,evidence=distributionEvidence(distribution,slot.id),durationSpec=chooseDurationSpec(evidence,slot.id,slot.key,durationDraw(slot.uid,slot.id));return {...slot,evidence,durationSpec,durationBeats:durationBeats(durationSpec,o.changeMode||'bar',meter),meter};}
 reset(id,key){this.revision++;this.history=[id];const meter=this.options().beatsPerBar||4;this.slots=[{uid:++this.serial,id,key:{...key},keyAge:0,durationSpec:{unit:'bars',count:1},durationBeats:meter,meter,evidence:null}];this.fill();}
 fill(target=4){while(this.slots.length<target){const last=this.slots.at(-1),options=this.options();const tonal=advanceTonality({...options,key:last.key,keyAge:last.keyAge},last.id,this.random);const history=[...this.history,...this.slots.slice(1).map(s=>s.id)].slice(-24);const result=this.predict(history,{...options,key:tonal.key});const slot={uid:++this.serial,id:this.sample(result.distribution),...tonal};this.slots.push(this.decorate(slot,result.distribution));}}
 advance(){if(this.slots.length<2)throw Error('Queue unavailable');this.slots.shift();this.history.push(this.slots[0].id);this.history=this.history.slice(-24);this.fill();return this.slots[0];}
 advanceTo(uid){const index=this.slots.findIndex(s=>s.uid===uid);if(index<0)throw Error('Scheduled chord disappeared');for(let i=0;i<index;i++)this.advance();return this.slots[0];}
 regenerate(preserveThroughUid=this.slots[0]?.uid){const index=this.slots.findIndex(s=>s.uid===preserveThroughUid);this.revision++;this.slots=this.slots.slice(0,Math.max(1,index+1));this.fill();}
 retime(mode,meter){let changed=false;this.slots=this.slots.map(slot=>{const beats=durationBeats(slot.durationSpec,mode,meter);if(beats!==slot.durationBeats||meter!==slot.meter)changed=true;return {...slot,durationBeats:beats,meter};});if(changed)this.revision++;}
 context(uid){const index=this.slots.findIndex(s=>s.uid===uid);return index>0?{slot:this.slots[index],history:[...this.history,...this.slots.slice(1,index).map(s=>s.id)],index}:null;}
 edit({uid,revision},id){const context=this.context(uid);if(revision!==this.revision||!context||!getChord(id))return false;this.revision++;this.slots=this.slots.slice(0,context.index+1);const prediction=this.predict(context.history,{...this.options(),key:context.slot.key});this.slots[context.index]=this.decorate({...context.slot,id,edited:true},prediction.distribution);this.fill();return true;}
}
