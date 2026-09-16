import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {getStore} from '@netlify/blobs';
import {libraryRoot} from './library-root.mjs';
const root=path.resolve(import.meta.dirname,'..'),library=libraryRoot();
const {siteId}=JSON.parse(await fs.readFile(path.join(root,'.netlify/state.json')));
const auth=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Preferences/netlify/config.json')));
const store=getStore('volta-pdf-chunks',{siteID:siteId,token:auth.users[auth.userId].auth.token});
const manifest=JSON.parse(await fs.readFile(path.join(library,'manifest.json')));
const missing=JSON.parse(await fs.readFile(path.join(library,'cloud-missing-chunks.json')));
for(const item of missing){
  if(!/^[a-f0-9]{64}$/.test(item.id)||!Number.isInteger(item.index)||item.index<0)throw Error('Invalid repair target');
  const file=path.resolve(library,manifest.files[item.id]);if(!file.startsWith(library+path.sep))throw Error('Invalid source');
  const offset=item.index*2097152,length=Math.min(2097152,item.bytes-offset);if(length<=0)throw Error('Invalid range');
  const handle=await fs.open(file),buffer=Buffer.alloc(length);
  try{const {bytesRead}=await handle.read(buffer,0,length,offset);if(bytesRead!==length)throw Error('Source read incomplete');}finally{await handle.close();}
  await store.set(item.id+'-'+item.index,buffer);
  console.log('Re-uploaded known missing chunk '+item.id.slice(0,8)+'-'+item.index);
}
console.log(`Re-uploaded ${missing.length} known missing chunks. No full-library verification performed.`);
