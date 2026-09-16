const DB_NAME='volta-score-library';
const lastScore=()=>{try{return globalThis.localStorage?.getItem('volta:last-score')||null;}catch{return null;}};
const rememberLast=id=>{try{globalThis.localStorage?.setItem('volta:last-score',id);}catch{}};
function database(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,6);req.onupgradeneeded=()=>{for(const name of ['scores','inkDrafts','positions','cloudBases','local','bookmarks'])if(!req.result.objectStoreNames.contains(name))req.result.createObjectStore(name,{keyPath:'id'});};req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('请关闭另一页旧版谱架后重试'));req.onsuccess=()=>resolve(req.result);});}
export async function scoreID(buffer){const hash=await crypto.subtle.digest('SHA-256',buffer);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');}
let writes=Promise.resolve();
export function saveScore(score){
  const snapshot=structuredClone(score);
  const task=writes.catch(()=>{}).then(()=>writeScore(snapshot));writes=task;return task;
}
async function writeScore(score){
  const db=await database();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction(['scores','positions'],'readwrite');tx.objectStore('scores').put(score);tx.objectStore('positions').put({id:score.id,page:score.page});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});rememberLast(score.id);}finally{db.close();}
}
export async function savePosition(id,page){
  if(!id||!Number.isInteger(page)||page<1)return;
  const db=await database();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction('positions','readwrite');tx.objectStore('positions').put({id,page});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});rememberLast(id);}finally{db.close();}
}
export async function loadScore(id=lastScore()){
  await writes.catch(()=>{});
  if(!id)return null;const db=await database();
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction(['scores','positions']),score=tx.objectStore('scores').get(id),position=tx.objectStore('positions').get(id);tx.oncomplete=()=>resolve(score.result?{...score.result,page:position.result?.page||score.result.page}:null);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
export async function inkDraft(id,value){
  const db=await database();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction('inkDrafts',value===undefined?'readonly':'readwrite');
    const req=value===undefined?tx.objectStore('inkDrafts').get(id):tx.objectStore('inkDrafts').put({id,...value});
    tx.oncomplete=()=>resolve(value===undefined?req.result:null);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}
export async function allInkDrafts(){
  const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('inkDrafts'),req=tx.objectStore('inkDrafts').getAll();tx.oncomplete=()=>resolve(req.result);tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}
export async function saveInkDrafts(rows){
  const db=await database();try{await new Promise((resolve,reject)=>{const tx=db.transaction('inkDrafts','readwrite');for(const row of rows)tx.objectStore('inkDrafts').put(row);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
export async function cloudBase(id,value){
  const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('cloudBases',value===undefined?'readonly':'readwrite'),req=value===undefined?tx.objectStore('cloudBases').get(id):tx.objectStore('cloudBases').put({id,data:value});tx.oncomplete=()=>resolve(req.result?.data);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}

// The folder a reader chose as its collection: a directory handle where the browser can keep one,
// and always the catalogue itself, so the shelf is there before any file is read again.
export async function saveLocalLibrary(value){
  const db=await database();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction('local','readwrite');
    tx.objectStore('local').put({id:'library',savedAt:Date.now(),...value});
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
export async function loadLocalLibrary(){
  const db=await database();
  try{return await new Promise((resolve,reject)=>{const request=db.transaction('local').objectStore('local').get('library');
    request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);});}
  catch{return null;}finally{db.close();}
}
export async function loadBookmarks(id){
  if(!id)return null;const db=await database();
  try{return await new Promise((resolve,reject)=>{const request=db.transaction('bookmarks').objectStore('bookmarks').get(id);request.onsuccess=()=>resolve(request.result?.items??null);request.onerror=()=>reject(request.error);});}
  finally{db.close();}
}
export async function saveBookmarks(id,items){
  if(!id)return;const db=await database();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction('bookmarks','readwrite');if(items?.length)tx.objectStore('bookmarks').put({id,items:structuredClone(items)});else tx.objectStore('bookmarks').delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  finally{db.close();}
}
export async function forgetLocalLibrary(){
  const db=await database();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction('local','readwrite');
    tx.objectStore('local').delete('library');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}
