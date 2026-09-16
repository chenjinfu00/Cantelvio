import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {getStore} from '@netlify/blobs';
import {streamQueue} from './stream-queue.mjs';
import {libraryRoot} from './library-root.mjs';
const root=path.resolve(import.meta.dirname,'..'),library=libraryRoot();
const {siteId}=JSON.parse(await fs.readFile(path.join(root,'.netlify/state.json')));
const config=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Preferences/netlify/config.json')));
const token=config.users?.[config.userId]?.auth?.token;
if(!siteId||!token)throw Error('Run the official Netlify login and link commands first.');
const store=getStore('volta-files',{siteID:siteId,token}),chunks=getStore('volta-pdf-chunks',{siteID:siteId,token});
const manifest=JSON.parse(await fs.readFile(path.join(library,'manifest.json'))),catalog=JSON.parse(await fs.readFile(path.join(library,'catalog.json')));
const selected=catalog.items;
const chunkSize=2*1024*1024;let count=0,total=0,stopping=false;
const checkpoint=path.join(library,'upload-'+siteId+'.jsonl'),completed=new Set();
try{for(const line of (await fs.readFile(checkpoint,'utf8')).split('\n'))try{completed.add(JSON.parse(line).id);}catch{}}catch{}
let writer=Promise.resolve();const failures=[];
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
console.log(`Uploading all ${selected.length} unique PDFs, including large editions.`);
await streamQueue(selected,async item=>{
  if(completed.has(item.id))return;
  for(let attempt=0;attempt<3;attempt++)try{
  const file=path.resolve(library,manifest.files[item.id]);if(!file.startsWith(library+path.sep))throw Error('Unsafe path');
  const existing=await store.get(item.id,{type:'json'});
  if(!existing||existing.bytes!==item.bytes){
    const handle=await fs.open(file),hash=createHash('sha256');let offset=0,index=0;
    try{while(offset<item.bytes){const buffer=Buffer.alloc(Math.min(chunkSize,item.bytes-offset));const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(bytesRead!==buffer.length)throw Error('Incomplete source');hash.update(buffer);await chunks.set(item.id+'-'+index,buffer,{onlyIfNew:true});offset+=bytesRead;index++;}}
    finally{await handle.close();}
    if(hash.digest('hex')!==item.id)throw Error('Source hash mismatch');
    await store.setJSON(item.id,{id:item.id,bytes:item.bytes,chunkSize,chunks:index});
  }
  const fit=JSON.parse(await fs.readFile(path.join(library,'fit',item.id+'.json')));await store.setJSON('fit-'+item.id,fit);
  writer=writer.then(()=>fs.appendFile(checkpoint,JSON.stringify({id:item.id,bytes:item.bytes})+'\n'));await writer;return;
  }catch(error){if(attempt===2||error.status&&error.status!==429&&error.status<500)throw error;await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));}
},{workers:6,shouldStop:()=>stopping,onResult:(_,item)=>{count++;total+=item.bytes;if(count%10===0||count===selected.length)console.log(`Stored ${count}/${selected.length} unique PDFs · ${(total/1048576).toFixed(1)} MiB`);},onError:(error,item)=>{failures.push({id:item.id,status:error.status,message:error.message});if([401,403].includes(error.status))stopping=true;console.error(`Upload deferred ${item.id.slice(0,8)} (${error.status||error.name})`);}});
await writer;
// MIDI and engraving files ride along with the score they belong to. They are small and whole,
// and a score uploaded on an earlier run still needs them, so this pass stands on its own.
let sources=0;
for(const item of selected)for(const source of item.sources||[]){
  const file=path.resolve(library,path.dirname(manifest.files[item.id]),source.name);
  if(!file.startsWith(library+path.sep))throw Error('Unsafe source path');
  const key=`source-${item.id}-${source.name}`,body=await fs.readFile(file);
  const known=await store.getMetadata(key).catch(()=>null);
  if(known?.metadata?.bytes===body.byteLength)continue;
  await store.set(key,body,{metadata:{bytes:body.byteLength}});sources++;
}
if(sources)console.log(`Uploaded ${sources} MIDI or engraving sources.`);
if(failures.length||stopping){await fs.writeFile(path.join(library,'upload-errors.json'),JSON.stringify(failures,null,2));throw Error('Upload incomplete; checkpoints preserved. Catalogue was not published.');}
// A completed catalogue is the publication boundary; never expose a partial library.
const cloud={version:catalog.version,localLibrary:false,cloudLibrary:true,summary:{pdfs:selected.length,bytes:total,omittedLarge:catalog.items.length-selected.length},items:selected.map(item=>({...item,aliases:[item.title],category:'私人谱库'}))};
await store.setJSON('catalog',cloud);
console.log(`Verified file manifests and uploaded fit records for ${count} PDFs. Catalogue is now available only after login.`);
