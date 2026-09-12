import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PUBLIC_LIBRARY,CLOUD_HOME} from '../docs/site-config.js';
import {versionPreferences} from '../docs/version-preferences.js';
import {groupWorks} from '../docs/library-model.js';

const root=fileURLToPath(new URL('../docs/',import.meta.url));
const read=file=>fs.readFile(path.join(root,file),'utf8');

test('GitHub entry carries no PDFs and points to the password-protected cloud',async()=>{
  const catalogue=JSON.parse(await read('library/catalog.json'));
  assert.equal(catalogue.items.length,0);assert.equal(catalogue.cloudHome,CLOUD_HOME);
  assert.equal(CLOUD_HOME,'https://volta-chenjinfu.netlify.app/volta/');
  const files=await fs.readdir(path.join(root,'scores')).catch(()=>[]);assert.equal(files.filter(name=>name.endsWith('.pdf')).length,0);
});

test('app shell has no platform branding or bundled personal records',async()=>{
  assert.equal(PUBLIC_LIBRARY,true);
  for(const entry of await fs.readdir(root,{withFileTypes:true})){
    assert.ok(!['server','api','.openai','notes','local_data','local','preferences'].includes(entry.name));
    if(entry.isFile()&&/\.(js|html|css)$/.test(entry.name))assert.doesNotMatch(await read(entry.name),/chatgpt|openai|signin-with-|\/Users\//i);
  }
  assert.equal((await fs.readdir(path.join(root,'scores')).catch(()=>[])).filter(name=>name.endsWith('.pdf')).length,0);
  const html=await read('index.html');assert.doesNotMatch(html,/仅限本人|PRIVATE LIBRARY|曲谱与批注仅你可见/);
  assert.match(html,/翻页点和版本偏好保存在当前浏览器/);
  assert.match(html,/更新批注/);assert.match(html,/导出全部批注/);
});

test('entrypoint resources and local module imports resolve beneath the project subpath',async()=>{
  const html=await read('index.html');
  for(const [,relative] of html.matchAll(/(?:src|href)="(\.\/[^"?]+)"/g))await fs.access(path.resolve(root,relative));
  for(const name of (await fs.readdir(root)).filter(name=>name.endsWith('.js'))){
    const text=await read(name);
    for(const [,relative] of text.matchAll(/(?:from|import)\s*['"](\.\/[^'"]+)['"]/g))await fs.access(path.resolve(root,relative));
  }
  assert.equal(new URL('./library/catalog.json','https://example.test/volta/').pathname,'/volta/library/catalog.json');
});

test('public last-version preferences survive reopening without a server',async()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const network=()=>assert.fail('Public preferences must not contact an API');
  const first=versionPreferences(network,{storage});await first.save('chopin|op21','a'.repeat(64));
  assert.equal(await versionPreferences(network,{storage}).load('chopin|op21'),'a'.repeat(64));
  assert.equal(await first.load('another-work'),null);
});

test('browser storage restrictions cannot crash the public library at startup',async()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('Storage access denied');}});
  try{
    const prefs=versionPreferences(()=>assert.fail('No remote preference request'));
    assert.equal(await prefs.load('chopin|op21'),null);
    await assert.rejects(prefs.save('chopin|op21','a'.repeat(64)));
  }finally{if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;}
});
