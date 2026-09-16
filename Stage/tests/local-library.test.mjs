import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {relativePaths,matchLibrary} from '../docs/local-library.js';

const file=name=>({name,size:1});
const entry=(path,name=path.split('/').pop())=>({webkitRelativePath:path,name});

test('the folder name the picker prepends is stripped once, and only when it is common to all',()=>{
  const picked=relativePaths([entry('本地曲谱/catalog.json'),entry('本地曲谱/曲谱/原神/璃月/神女劈观/总谱 · a.pdf')]);
  assert.deepEqual(picked.map(item=>item.path),['catalog.json','曲谱/原神/璃月/神女劈观/总谱 · a.pdf']);
  const mixed=relativePaths([entry('甲/x.pdf'),entry('乙/y.pdf')]);
  assert.deepEqual(mixed.map(item=>item.path),['甲/x.pdf','乙/y.pdf'],'two roots are left alone');
  assert.deepEqual(relativePaths([]),[]);
  assert.deepEqual(relativePaths([{name:'x.pdf'}]).map(i=>i.path),['x.pdf'],'a plain file still has a path');
});

test('a folder answers with the scores the catalogue asks for, and says which are absent',()=>{
  const catalog={items:[{id:'a'},{id:'b'},{id:'c'}]};
  const manifest={files:{a:'曲谱/甲/版本一 · a.pdf',b:'曲谱/甲/版本二 · b.pdf',c:'曲谱/乙/丙 · c.pdf'}};
  const entries=[
    {path:'曲谱/甲/版本一 · a.pdf',file:file('a.pdf')},
    {path:'曲谱/甲/版本二 · b.pdf',file:file('b.pdf')},
    {path:'曲谱/甲/曲.mid',file:file('曲.mid')},
    {path:'曲谱/甲/曲.sib',file:file('曲.sib')},
    {path:'曲谱/别处/无关.pdf',file:file('无关.pdf')},
  ];
  const {files,sources,missing}=matchLibrary(catalog,manifest,entries);
  assert.deepEqual([...files.keys()],['a','b']);
  assert.deepEqual(missing,['c'],'a score the folder does not hold is reported, not invented');
  assert.deepEqual([...sources.keys()].sort(),['a/曲.mid','a/曲.sib','b/曲.mid','b/曲.sib'],'both versions of a work share its sources');
  assert.equal(files.get('a').relative,'曲谱/甲/版本一 · a.pdf');
});

test('the shelf reads a folder before it reads the network, and the app keeps working offline',async()=>{
  const library=await fs.readFile(new URL('../docs/library.js',import.meta.url),'utf8');
  assert.match(library,/if\(localSource\)data=localSource\.catalog/);
  assert.match(library,/localSource\?await localSource\.url\(version\.id\)/);
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  assert.match(app,/library\?\.local\?\.sourceURL/,'MIDI comes from the folder too');
  const storage=await fs.readFile(new URL('../docs/storage.js',import.meta.url),'utf8');
  assert.match(storage,/indexedDB\.open\(DB_NAME,5\)/,'the store holding the folder is part of the database');
  assert.match(storage,/'cloudBases','local'/);
  const manifest=JSON.parse(await fs.readFile(new URL('../docs/cache-manifest.json',import.meta.url),'utf8'));
  assert.ok(manifest.includes('./local-library.js'),'choosing a folder works offline too');
});

test('a remembered catalogue draws the shelf with no network and asks for the folder only on opening',async()=>{
  const {rememberedLibrary}=await import('../docs/local-library.js');
  let asked=0;
  const source=rememberedLibrary({items:[{id:'a'}]},async()=>{asked+=1;});
  assert.equal(source.catalog.items.length,1,'the shelf has something to draw');
  assert.equal(source.url('a'),null,'no file is invented');
  assert.equal(source.needsFolder,true);
  assert.equal(asked,0,'restoring alone never opens a picker');
  await source.reopen();
  assert.equal(asked,1,'opening a score is what asks for the folder');
  const library=await fs.readFile(new URL('../docs/library.js',import.meta.url),'utf8');
  assert.match(library,/localSource\?\.needsFolder\)await localSource\.reopen/,'the shelf asks before it gives up');
});
