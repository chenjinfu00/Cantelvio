import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PUBLIC_LIBRARY} from '../docs/site-config.js';
import {versionPreferences} from '../docs/version-preferences.js';
import {groupWorks} from '../docs/library-model.js';

const root=fileURLToPath(new URL('../docs/',import.meta.url));
const read=file=>fs.readFile(path.join(root,file),'utf8');

test('public catalogue contains exactly ten byte-identical trial PDFs, including Polish National Edition Op.21',async()=>{
  const catalogue=JSON.parse(await read('library/catalog.json'));
  assert.equal(catalogue.items.length,10);assert.equal(new Set(catalogue.items.map(x=>x.id)).size,10);
  assert.equal(catalogue.items.filter(x=>/Op\.21/.test(x.title)&&x.title.includes('波兰国家版')).length,2);
  for(const item of catalogue.items){
    const bytes=await fs.readFile(path.join(root,'scores',item.id+'.pdf'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),item.id);
    assert.equal(bytes.length,item.bytes);
    assert.ok(item.aliases.every(value=>!/[\\/]/.test(value)));
    assert.ok(!('absolute' in item)&&!('ino' in item)&&!('mtime' in item));
  }
  const works=groupWorks(catalogue.items),concerto=works.filter(w=>w.versions.some(v=>v.title.includes('Op.21')));
  assert.equal(concerto.length,1);assert.equal(concerto[0].versions.length,2);
});

test('public site has no sign-in screen, platform branding or bundled personal records',async()=>{
  assert.equal(PUBLIC_LIBRARY,true);
  for(const entry of await fs.readdir(root,{withFileTypes:true})){
    assert.ok(!['server','api','.openai','notes','local_data','local','preferences'].includes(entry.name));
    if(entry.isFile()&&/\.(js|html|css)$/.test(entry.name))assert.doesNotMatch(await read(entry.name),/chatgpt|openai|signin-with-|\/Users\//i);
  }
  assert.equal((await fs.readdir(path.join(root,'scores'))).length,10);
  const html=await read('index.html');assert.doesNotMatch(html,/仅限本人|PRIVATE LIBRARY|曲谱与批注仅你可见/);
  assert.match(html,/批注、翻页点和版本偏好仅保存在当前浏览器/);
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
