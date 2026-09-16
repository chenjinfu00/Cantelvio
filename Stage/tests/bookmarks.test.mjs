import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {addBookmark,removeBookmark,sortBookmarks,bookmarkName,readBookmarks,writeBookmarks,BOOKMARK_LIMIT} from '../docs/bookmarks.js';

const store=()=>{const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value)};};

test('a bookmark is kept per page, in page order, and adding the same page again renames it',()=>{
  let list=[];
  list=addBookmark(list,12,'第二乐章',{at:1});
  list=addBookmark(list,3,'',{at:2});
  assert.deepEqual(list.map(item=>item.page),[3,12],'the bar reads in page order');
  list=addBookmark(list,12,'再来一次',{at:3});
  assert.equal(list.length,2,'a page is bookmarked once');
  assert.equal(list.find(item=>item.page===12).label,'再来一次');
  assert.equal(bookmarkName(list[0]),'第 3 页','an unnamed bookmark shows its page');
  assert.equal(bookmarkName(list[1]),'12 · 再来一次');
});

test('junk in storage never breaks the bar',()=>{
  assert.deepEqual(sortBookmarks(null),[]);
  assert.deepEqual(sortBookmarks([{page:0},{page:-2},{},null,{page:'x'}]),[]);
  assert.deepEqual(sortBookmarks([{page:2.6,label:123}]),[{page:3,label:'123',at:0}]);
  const memory=store();
  assert.deepEqual(readBookmarks('score-a',memory),[]);
  memory.setItem('volta:bookmarks:v1','not json');
  assert.deepEqual(readBookmarks('score-a',memory),[]);
});

test('bookmarks belong to one score and survive a reload',()=>{
  const memory=store();
  writeBookmarks('score-a',addBookmark([],5,'尾声'),memory);
  writeBookmarks('score-b',addBookmark([],9,''),memory);
  assert.deepEqual(readBookmarks('score-a',memory).map(bookmarkName),['5 · 尾声']);
  assert.deepEqual(readBookmarks('score-b',memory).map(item=>item.page),[9]);
  writeBookmarks('score-a',removeBookmark(readBookmarks('score-a',memory),5),memory);
  assert.deepEqual(readBookmarks('score-a',memory),[],'removing the last one clears the score');
  assert.deepEqual(readBookmarks('score-b',memory).map(item=>item.page),[9],'the other score is untouched');
});

test('bookmarks share the durable local database with annotations',async()=>{
  const storage=await fs.readFile(new URL('../docs/storage.js',import.meta.url),'utf8');
  const bookmarks=await fs.readFile(new URL('../docs/bookmarks.js',import.meta.url),'utf8');
  assert.match(storage,/indexedDB\.open\(DB_NAME,6\)/);
  assert.match(storage,/objectStore\('bookmarks'\)/);
  assert.match(bookmarks,/import \{loadBookmarks,saveBookmarks\} from '\.\/storage\.js'/);
  assert.match(bookmarks,/saveBookmarks\(scoreId,value\)/);
});

test('the bar refuses to grow without limit',()=>{
  let list=[];
  for(let page=1;page<=BOOKMARK_LIMIT+5;page++)list=addBookmark(list,page,'');
  assert.equal(list.length,BOOKMARK_LIMIT);
  assert.equal(list.at(-1).page,BOOKMARK_LIMIT,'the extra pages are refused, not silently swapped in');
});

test('the bar lives in the top drawer, with the score it belongs to',async()=>{
  const shell=await fs.readFile(new URL('../docs/reader-shell.js',import.meta.url),'utf8');
  assert.match(shell,/'#bookmark-bar'/);
  const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  for(const id of ['bookmark-bar','bookmark-label','bookmark-add','bookmark-list'])assert.match(html,new RegExp('id="'+id+'"'));
  const manifest=JSON.parse(await fs.readFile(new URL('../docs/cache-manifest.json',import.meta.url),'utf8'));
  assert.ok(manifest.includes('./bookmarks.js'));
});
