const DB_NAME='volta-score-library';
function database(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,2);req.onupgradeneeded=()=>{for(const name of ['scores','inkDrafts'])if(!req.result.objectStoreNames.contains(name))req.result.createObjectStore(name,{keyPath:'id'});};req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);});}
export async function scoreID(buffer){const hash=await crypto.subtle.digest('SHA-256',buffer);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');}
let writes=Promise.resolve();
export function saveScore(score){
  const snapshot=structuredClone(score);
  const task=writes.catch(()=>{}).then(()=>writeScore(snapshot));writes=task;return task;
}
async function writeScore(score){
  const db=await database();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction('scores','readwrite');tx.objectStore('scores').put(score);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});localStorage.setItem('volta:last-score',score.id);}finally{db.close();}
}
export async function loadScore(id=localStorage.getItem('volta:last-score')){
  await writes.catch(()=>{});
  if(!id)return null;const db=await database();
  try{return await new Promise((resolve,reject)=>{const req=db.transaction('scores').objectStore('scores').get(id);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);});}finally{db.close();}
}
export async function inkDraft(id,value){
  const db=await database();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction('inkDrafts',value===undefined?'readonly':'readwrite');
    const req=value===undefined?tx.objectStore('inkDrafts').get(id):tx.objectStore('inkDrafts').put({id,...value});
    tx.oncomplete=()=>resolve(value===undefined?req.result:null);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}
