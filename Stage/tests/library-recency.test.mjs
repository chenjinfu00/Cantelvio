import test from 'node:test';
import assert from 'node:assert/strict';
import {LIBRARY_RECENCY_KEY,prioritizeLibraryGroups,readLibraryRecency,rememberLibraryRecency} from '../docs/library-recency.js';

function memory(){const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),values};}

test('the last successfully opened composer and category are remembered locally',()=>{
  const storage=memory();
  const saved=rememberLibraryRecency({browseGroup:'柴可夫斯基',genre:'协奏曲',style:'古典',era:'浪漫主义',category:'小提琴'},storage);
  assert.deepEqual(readLibraryRecency(storage),saved);
  assert.equal(JSON.parse(storage.values.get(LIBRARY_RECENCY_KEY)).composer,'柴可夫斯基');
  const next=rememberLibraryRecency({browseGroup:'肖邦',genre:'练习曲'},storage);
  assert.equal(next.composer,'肖邦');assert.equal(next.genre,'练习曲');
  assert.equal(next.style,'古典','missing fields keep their previous useful memory');
});

test('the remembered group moves to the front without disturbing the rest',()=>{
  const groups=[['Animenz',3],['巴赫',8],['肖邦',6],['原神',10]];
  assert.deepEqual(prioritizeLibraryGroups(groups,'肖邦'),[['肖邦',6],['Animenz',3],['巴赫',8],['原神',10]]);
  assert.deepEqual(prioritizeLibraryGroups(groups,'不存在'),groups);
  assert.deepEqual(groups,[['Animenz',3],['巴赫',8],['肖邦',6],['原神',10]],'the source order is not mutated');
});
