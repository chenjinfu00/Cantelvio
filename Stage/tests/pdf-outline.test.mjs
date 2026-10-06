import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {outlinePage,flattenOutline,activeOutlineIndex} from '../docs/pdf-outline.js';

test('PDF destinations resolve from direct references, page indexes, and named destinations',async()=>{
  const reference={num:9,gen:0};
  const pdf={
    getDestination:async name=>name==='chapter-two'?[reference,{name:'XYZ'}]:null,
    getPageIndex:async ref=>ref===reference?7:-1,
  };
  assert.equal(await outlinePage(pdf,[3,{name:'Fit'}]),4);
  assert.equal(await outlinePage(pdf,'chapter-two'),8);
  assert.equal(await outlinePage(pdf,null),null);
});

test('nested PDF outline keeps its hierarchy and resolves pages',async()=>{
  const refs=[{num:1},{num:2},{num:3}];
  const pdf={getPageIndex:async ref=>refs.indexOf(ref)};
  const items=await flattenOutline(pdf,[
    {title:' 上册 ',dest:[refs[0]],items:[{title:'01  C大调',dest:[refs[1]],items:[]}]},
    {title:'下册',dest:[refs[2]],items:[]},
  ]);
  assert.deepEqual(items.map(({title,page,depth})=>({title,page,depth})),[
    {title:'上册',page:1,depth:0},
    {title:'01 C大调',page:2,depth:1},
    {title:'下册',page:3,depth:0},
  ]);
});

test('the current outline entry is the deepest latest destination',()=>{
  const items=[
    {title:'上册',page:2,depth:0},
    {title:'01',page:2,depth:1},
    {title:'02',page:5,depth:1},
    {title:'下册',page:88,depth:0},
    {title:'25',page:88,depth:1},
  ];
  assert.equal(activeOutlineIndex(items,1),-1);
  assert.equal(activeOutlineIndex(items,2),1);
  assert.equal(activeOutlineIndex(items,40),2);
  assert.equal(activeOutlineIndex(items,88),4);
});

test('the PDF outline is an optional scrollable disclosure in the top drawer',async()=>{
  const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  const shell=await fs.readFile(new URL('../docs/reader-shell.js',import.meta.url),'utf8');
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  const css=await fs.readFile(new URL('../docs/reader.css',import.meta.url),'utf8');
  assert.match(html,/<details id="pdf-outline"[^>]*hidden>[\s\S]*?<nav id="pdf-outline-list"/);
  assert.ok(shell.includes("'#pdf-outline'"));
  assert.match(app,/outline\?\.setDocument\(pdf\)/);
  assert.match(css,/\.pdf-outline-list\{[^}]*max-height:min\(42vh,420px\)[^}]*overflow-y:auto/);
});
