import {SCORE_BASIS} from './alignment.mjs?v=20261018-score-1';
export const WORK_ID='chopin-op21-1';
export const SESSION_VERSION=1;
const number=(value,fallback,min,max)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;
export function settings(value={}) {
  const positionBasis=value.positionBasis===SCORE_BASIS?SCORE_BASIS:'midi';
  return {positionBasis,measure:Math.round(number(value.measure,positionBasis===SCORE_BASIS?0:1,positionBasis===SCORE_BASIS?0:1,100000)),rate:number(value.rate,94,50,150),volume:number(value.volume,45,0,100),mode:value.mode==='follow'?'follow':'fixed',speaker:value.speaker!==false,deviceId:typeof value.deviceId==='string'?value.deviceId.slice(0,512):''};
}
function asset(value,maxSize) {
  if(value==null)return null;
  if(!(value.blob instanceof Blob) || !value.blob.size || value.blob.size>maxSize)throw Error('保存的演奏文件不完整 / Invalid saved performance file');
  return {name:String(value.name||'Local file').replace(/[\x00-\x1f]/g,'').slice(0,180),blob:value.blob};
}
export function snapshot(value) {
  if(!value || value.version!==SESSION_VERSION || value.workId!==WORK_ID)throw Error('演奏配置版本不兼容 / Incompatible performance settings');
  const midi=asset(value.midi,20*1024*1024),solo=asset(value.solo,20*1024*1024),pdf=asset(value.pdf,100*1024*1024);
  if(!midi && !pdf)throw Error('没有可保存的演奏文件 / No performance files to save');
  return {version:SESSION_VERSION,workId:WORK_ID,midi,solo,pdf,soloTrackIds:[...new Set((Array.isArray(value.soloTrackIds)?value.soloTrackIds:[]).filter(n=>Number.isInteger(n)&&n>=0&&n<256))],confirmed:value.confirmed===true,settings:settings(value.settings),page:Math.round(number(value.page,1,1,100000)),updatedAt:Date.now()};
}

// One ordered queue prevents a slow save from resurrecting files after Clear.
export class SessionStore {
  constructor({factory=globalThis.indexedDB,name='cantelvio-concerto:'+new URL('../',import.meta.url).pathname}={}) {this.factory=factory;this.name=name;this.queue=Promise.resolve();}
  enqueue(operation) {const task=this.queue.catch(()=>{}).then(operation);this.queue=task.catch(()=>{});return task;}
  async open() {
    if(!this.factory)throw Error('此浏览器不能保存演奏配置 / Browser storage unavailable');
    return new Promise((resolve,reject)=>{
      const request=this.factory.open(this.name,1);let abandoned=false;
      const timeout=setTimeout(()=>{abandoned=true;reject(Error('本机存储暂时不可用 / Local storage timed out'));},5000);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('performances'))request.result.createObjectStore('performances');};
      request.onerror=()=>{clearTimeout(timeout);reject(request.error);};
      request.onblocked=()=>{clearTimeout(timeout);abandoned=true;reject(Error('请关闭旧版伴奏页后重试 / Close older rehearsal tabs and retry'));};
      request.onsuccess=()=>{clearTimeout(timeout);if(abandoned)request.result.close();else resolve(request.result);};
    });
  }
  async transaction(mode,operation) {
    const db=await this.open();
    try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction('performances',mode),request=operation(tx.objectStore('performances'));let result;
      request.onsuccess=()=>{result=request.result;};
      tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||request.error);tx.onabort=()=>reject(tx.error||Error('Local save cancelled'));
    });}finally{db.close();}
  }
  load() {return this.enqueue(async()=>{const value=await this.transaction('readonly',store=>store.get(WORK_ID));return value?snapshot(value):null;});}
  save(value) {const clean=snapshot(value);return this.enqueue(()=>this.transaction('readwrite',store=>store.put(clean,WORK_ID)));}
  clear() {return this.enqueue(()=>this.transaction('readwrite',store=>store.delete(WORK_ID)));}
}
