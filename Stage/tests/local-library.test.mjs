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
  assert.match(library,/const data=localSource\?\.catalog\|\|\{items:\[\]\}/,'the shelf is whatever folder is open');
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

test('the collection describes itself from one named drawer, and an older one still opens',async()=>{
  const {dataPaths,DATA}=await import('../docs/local-library.js');
  assert.deepEqual(dataPaths('catalog.json'),[DATA+'/catalog.json','catalog.json'],'the drawer is read first, the old top level second');
  assert.deepEqual(dataPaths('fit/abc.json'),[DATA+'/fit/abc.json','fit/abc.json']);
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  assert.match(app,/library\?\.local\?\.fit\?\.\(id\)/,'page bounds come from the folder before the network');
  const paths=await fs.readFile(new URL('../scripts/library-paths.mjs',import.meta.url),'utf8');
  assert.match(paths,/const folders=\[segment\(browse\)\]/,'shelves sit at the top of the folder');
});

test('a generated filename is told apart from the name a score arrived with',async()=>{
  const {generatedAlias,replaceLibraryAlias}=await import('../scripts/library-paths.mjs');
  const id='abcdef01'+'0'.repeat(56);
  assert.equal(generatedAlias('原神/璃月/神女劈观/总谱 · abcdef01.pdf',id),true);
  assert.equal(generatedAlias('曲谱/原神/旧布局.pdf',id),true,'the previous layout is still recognised');
  assert.equal(generatedAlias('神女劈观（原版）.pdf',id),false,'a downloaded name is not mistaken for ours');
  assert.equal(generatedAlias('别人的 · 12345678.pdf',id),false,'another score fingerprint is not ours either');
  assert.deepEqual(
    replaceLibraryAlias(['原神/旧地区/神女劈观/旧名 · abcdef01.pdf','神女劈观.pdf'],'原神/璃月/神女劈观/总谱 · abcdef01.pdf'),
    ['原神/璃月/神女劈观/总谱 · abcdef01.pdf','神女劈观.pdf']);
});

test('annotations can live beside the music, one file per score',async()=>{
  const {inkPath,INK_DIR,inkFileFor,scoreIds,readFolderInk,writeFolderInk}=await import('../docs/ink-folder.js');
  const id='a'.repeat(64),other='b'.repeat(64);
  assert.equal(INK_DIR,'曲谱库数据/批注');
  assert.equal(inkPath(id),'曲谱库数据/批注/'+id+'.json');
  const rows=[
    {id:id+'/1',data:{version:1,strokes:[{id:'s1'}]}},
    {id:id+'/2',data:{version:1,strokes:[]}},
    {id:other+'/1',data:{version:1,strokes:[{id:'s2'}]}},
  ];
  assert.deepEqual(scoreIds(rows),[id,other],'a page with nothing drawn on it is not a score to save');
  const file=inkFileFor(id,rows);
  assert.deepEqual(file.pages.map(page=>page.id),[id+'/1'],'only pages that carry strokes are written');
  assert.equal(file.scoreId,id);
  assert.equal(inkFileFor('c'.repeat(64),rows),null,'a score with no markings writes no file');
  const written=[];
  assert.equal(await writeFolderInk({writeJSON:(path,value)=>{written.push(path);return value;}},rows),2);
  assert.deepEqual(written,[inkPath(id),inkPath(other)]);
  await assert.rejects(writeFolderInk({writeJSON:null},rows),/不能写入文件夹/,'a browser that cannot write says so');
  assert.deepEqual(await readFolderInk(null),[],'a folder that was never opened holds nothing');
});

test('annotations read from a folder are checked, and a file claiming the wrong score is ignored',async()=>{
  const {readFolderInk}=await import('../docs/ink-folder.js');
  const id='a'.repeat(64);
  const page={id:id+'/1',data:{version:1,strokes:[{id:'s1',color:'#2858aa',width:0.004,points:[[0.1,0.1,0.5],[0.2,0.2,0.5]]}]}};
  const local={inkFiles:async()=>[
    {id,read:async()=>({format:'volta-annotations',version:1,scoreId:id,pages:[page]})},
    {id:'b'.repeat(64),read:async()=>({format:'volta-annotations',version:1,scoreId:id,pages:[page]})},
    {id:'c'.repeat(64),read:async()=>{throw new Error('damaged');}},
    {id:'d'.repeat(64),read:async()=>({nonsense:true})},
  ]};
  const pages=await readFolderInk(local);
  assert.equal(pages.length,1,'one good file in, one page out; the mislabelled, broken and foreign ones are skipped');
  assert.equal(pages[0].id,page.id);
});

test('a newcomer is told what folder to point at, and told only until they have',async()=>{
  const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.match(html,/id="local-folder-intro"/,'the how-to sits with the button it explains');
  assert.match(html,/曲谱库数据\/\n?\s*catalog\.json|catalog\.json/,'the example names the files the app looks for');
  assert.match(html,/github\.com\/chenjinfu00\/volta#readme/,'the long version is one link away');
  const local=await fs.readFile(new URL('../docs/local-library.js',import.meta.url),'utf8');
  assert.match(local,/const settled=\(\)=>\{if\(intro\)intro\.hidden=true;\}/,'it stops taking up room once a folder is open');
  const readme=await fs.readFile(new URL('../README.md',import.meta.url),'utf8');
  for(const promised of ['曲谱库数据','manifest.json','catalog.json','SHA-256','sources'])
    assert.ok(readme.includes(promised),'README explains '+promised);
  assert.doesNotMatch(readme,/netlify/i,'the README no longer points at a host that is gone');
});

test('the writing dock carries its own save, and a tool button is its own settings button',async()=>{
  const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.match(html,/id="ink-save"/,'saving is where the writing hand already is');
  assert.doesNotMatch(html,/画笔设置|橡皮设置/,'the two ··· buttons are gone');
  assert.match(html,/id="pen-options"/);assert.match(html,/id="erase-options"/);
  assert.match(html,/长按选颜色和粗细/,'the pen says how to reach its settings');
  const ink=await fs.readFile(new URL('../docs/ink.js',import.meta.url),'utf8');
  assert.match(ink,/holdable\(\$\('ink-'\+mode\),mode\)/,'both tools are tap-to-switch, hold-for-settings');
  assert.match(ink,/if\(held\)\{held=false;event\.preventDefault\(\);return;\}/,'a hold does not also switch the tool');
  assert.match(ink,/contextmenu/,'a right click reaches the same panel with a mouse');
  const css=await fs.readFile(new URL('../docs/reader.css',import.meta.url),'utf8');
  assert.match(css,/\.pencil-dock \.pencil-popover>summary\{display:none\}/);
  const folder=await fs.readFile(new URL('../docs/ink-folder.js',import.meta.url),'utf8');
  assert.match(folder,/if\(dock\)dock\.onclick=keep/,'the dock button and the settings button do the same thing');
});

test('whether markings survive a closed app is answered without being asked',async()=>{
  const offline=await fs.readFile(new URL('../docs/offline.js',import.meta.url),'utf8');
  assert.match(offline,/navigator\.storage\?\.persisted\?\.\(\)/,'the state is read, not guessed');
  assert.match(offline,/sayDurability\(\);\n\s*if\(!supported\)/,'it is reported every time the settings open');
  assert.match(offline,/加到主屏幕/,'the iPad is told what actually improves its odds');
});

test('an empty reader offers the whole collection first, one PDF second',async()=>{
  const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.match(html,/id="empty-folder" class="primary">选择曲谱文件夹/,'the first offer is the folder');
  assert.match(html,/id="empty-import" class="text-button">只打开一份 PDF/,'a single PDF is still one click away');
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  assert.match(app,/if\(library\?\.local\)\$\('library-button'\)\.click\(\);else localFolder\?\.choose\(\)/,
    'once a folder is open the same button leads back into the shelf');
  assert.match(app,/connected\?'打开曲谱库':'选择曲谱文件夹'/);
  const local=await fs.readFile(new URL('../docs/local-library.js',import.meta.url),'utf8');
  assert.match(local,/async function choose\(\)/,'the shelf button and the empty reader run the same routine');
  assert.match(local,/return \{\n\s*use,choose,/);
  const css=await fs.readFile(new URL('../docs/reader.css',import.meta.url),'utf8');
  assert.match(css,/\.empty-state small\[hidden\]\{display:none\}/,'the hint can actually be hidden');
});
