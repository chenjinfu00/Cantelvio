import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {rememberScore,readRecent,whenLabel,RECENT_LIMIT} from '../docs/recent-scores.js';
import {normalizeSettings,defaults} from '../docs/settings.js';

test('the shelf remembers the last scores, newest first and without duplicates',()=>{
  let list=[];
  list=rememberScore(list,{id:'a',name:'肖邦 - 夜曲.pdf',at:1});
  list=rememberScore(list,{id:'b',name:'原神 - 璃月',at:2});
  list=rememberScore(list,{id:'a',name:'肖邦 - 夜曲',at:3});
  assert.deepEqual(list.map(item=>item.id),['a','b']);
  assert.equal(list[0].name,'肖邦 - 夜曲','the .pdf suffix is dropped');
  assert.equal(list[0].at,3,'reopening moves it back to the front');
});

test('the list stays short and survives junk',()=>{
  let list=[];
  for(let i=0;i<RECENT_LIMIT+5;i++)list=rememberScore(list,{id:'score-'+i,name:'第 '+i+' 份',at:i});
  assert.equal(list.length,RECENT_LIMIT);
  assert.equal(list[0].id,'score-'+(RECENT_LIMIT+4));
  assert.deepEqual(rememberScore(null,null),[]);
  assert.deepEqual(rememberScore([{id:'a',name:'x'},{bad:true},null],{id:'a',name:'x'}).map(i=>i.id),['a']);
  assert.equal(rememberScore([],{id:'a'})[0].name,'未命名曲谱');
});

test('a broken or empty store never breaks the shelf',()=>{
  const store=value=>({getItem:()=>value});
  assert.deepEqual(readRecent(store(null)),[]);
  assert.deepEqual(readRecent(store('not json')),[]);
  assert.deepEqual(readRecent(store('{"id":"a"}')),[]);
  assert.deepEqual(readRecent(store('[{"id":"a","name":"x","at":1}]')).map(i=>i.id),['a']);
});

test('history keeps the relative folder path when a score is reopened',()=>{
  let list=rememberScore([],{id:'a',name:'曲.pdf',path:'原神/璃月/曲/曲.pdf',at:1});
  list=rememberScore(list,{id:'a',name:'曲.pdf',at:2});
  assert.equal(list[0].path,'原神/璃月/曲/曲.pdf');
});

test('the reader source prefers a durable offline copy over a stale folder URL',async()=>{
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  assert.match(app,/const saved=await loadScore\(id\),offlineCopy=await offlineScore\(id\)/);
  assert.match(app,/remote:offlineCopy\.remote/);
  const offline=await fs.readFile(new URL('../docs/offline.js',import.meta.url),'utf8');
  assert.match(offline,/const sourceURL=score\.remote\?\.url/);
  assert.match(offline,/const url=new URL\('\.\/offline-score\/'/);
});

test('recency reads as a phrase, not a timestamp',()=>{
  const now=Date.parse('2026-09-15T12:00:00Z');
  assert.equal(whenLabel(now-30*1000,now),'刚刚');
  assert.equal(whenLabel(now-45*60000,now),'45 分钟前');
  assert.equal(whenLabel(now-5*3600*1000,now),'5 小时前');
  assert.equal(whenLabel(now-3*86400000,now),'3 天前');
  assert.equal(whenLabel(now-70*86400000,now),'2 个月前');
});

test('the paper colour is a saved setting and starts white',async()=>{
  assert.equal(defaults.surface,'white');
  assert.equal(normalizeSettings({}).surface,'white');
  assert.equal(normalizeSettings({surface:'paper'}).surface,'paper');
  assert.equal(normalizeSettings({surface:'neon'}).surface,'white','an unknown colour falls back');
  const css=await fs.readFile(new URL('../docs/reader.css',import.meta.url),'utf8');
  for(const name of ['white','paper','mist','dark'])
    assert.match(css,new RegExp(':root\\[data-surface='+name+'\\]:not\\(\\.performance-active\\)'),name+' has a paper colour');
  const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.match(html,/data-surface-choice="white"/);
  assert.match(html,/id="recent-list"/);
});

test('drawers animate on the way out, not only on the way in',async()=>{
  const css=await fs.readFile(new URL('../docs/reader.css',import.meta.url),'utf8');
  assert.match(css,/\.focus-reader \.sidebar\{transition:transform [^}]*visibility 0s linear/,'the shelf keeps its visibility until the slide ends');
  assert.match(css,/\.tools-open \.top-drawer\{transition:transform [^}]*visibility 0s\}/);
  assert.match(css,/\.shelf-open \.drawer-backdrop,\.tools-open \.drawer-backdrop\{opacity:1\}/);
  const shell=await fs.readFile(new URL('../docs/reader-shell.js',import.meta.url),'utf8');
  assert.match(shell,/backdropTimer/,'the backdrop waits for the drawer to leave');
});
