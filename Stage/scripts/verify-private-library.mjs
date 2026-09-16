import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {getStore} from '@netlify/blobs';
import {libraryRoot} from './library-root.mjs';
const root=path.resolve(import.meta.dirname,'..');
const {siteId}=JSON.parse(await fs.readFile(path.join(root,'.netlify/state.json')));
const auth=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Preferences/netlify/config.json')));
const options={siteID:siteId,token:auth.users[auth.userId].auth.token,consistency:'strong'};
const files=getStore('volta-files',options),chunks=getStore('volta-pdf-chunks',options);
const source=JSON.parse(await fs.readFile(path.join(libraryRoot(),'catalog.json')));
const catalog=await files.get('catalog',{type:'json'});if(!catalog)throw Error('Catalogue not published yet');
const expected=new Map(source.items.map(item=>[item.id,item]));
if(catalog.items.length!==expected.size||new Set(catalog.items.map(x=>x.id)).size!==expected.size)throw Error('Catalogue count mismatch');
const fileKeys=new Set(),chunkKeys=new Set();
for await(const page of files.list({paginate:true}))for(const blob of page.blobs)fileKeys.add(blob.key);
for await(const page of chunks.list({paginate:true}))for(const blob of page.blobs)chunkKeys.add(blob.key);
let requiredChunks=0,totalBytes=0;const missingChunks=[];
for(const item of catalog.items){
  if(item.bytes!==expected.get(item.id)?.bytes||!fileKeys.has(item.id)||!fileKeys.has('fit-'+item.id))throw Error('Missing or inconsistent PDF/fit '+item.id);
  for(let index=0;index<Math.ceil(item.bytes/2097152);index++){if(!chunkKeys.has(item.id+'-'+index))missingChunks.push({id:item.id,index,bytes:item.bytes});requiredChunks++;}
  totalBytes+=item.bytes;
}
if(missingChunks.length){
  await fs.writeFile(path.join(libraryRoot(),'cloud-missing-chunks.json'),JSON.stringify(missingChunks,null,2));
  throw Error(`Missing ${missingChunks.length} chunks from ${new Set(missingChunks.map(x=>x.id)).size} PDFs; repair list saved locally.`);
}
const large=[];
for(const item of catalog.items.filter(x=>x.bytes>100_000_000)){
  const metadata=await files.get(item.id,{type:'json'}),hash=createHash('sha256');let bytes=0;
  for(let index=0;index<metadata.chunks;index++){const data=await chunks.get(item.id+'-'+index,{type:'arrayBuffer'});if(!data)throw Error('Missing large PDF chunk');bytes+=data.byteLength;hash.update(new Uint8Array(data));}
  if(bytes!==item.bytes||hash.digest('hex')!==item.id)throw Error('Large PDF read-back failed '+item.id);
  large.push({id:item.id,title:item.title,bytes,sha256Verified:true});console.log('Large PDF fully read-back verified: '+item.title);
}
const report={checkedAt:new Date().toISOString(),pdfs:catalog.items.length,bytes:totalBytes,requiredChunks,large,missing:[]};
await fs.writeFile(path.join(libraryRoot(),'cloud-verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
