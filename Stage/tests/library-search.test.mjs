import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesLibrarySearch} from '../docs/library-search.js';

test('tablet searches ignore catalogue punctuation, width, and case',()=>{
  for(const query of ['K521','k.521','Ｋ５２１','莫扎特 521','四手 521'])assert.equal(matchesLibrarySearch('莫扎特 C大调四手联弹奏鸣曲 K.521',query),true,query);
  assert.equal(matchesLibrarySearch('G大调四手联弹 K.357（未完成）','K357'),true);
  assert.equal(matchesLibrarySearch('K.521 莫扎特','K.357'),false);
  assert.equal(matchesLibrarySearch('肖邦 Op.21','肖邦 21'),true);
  assert.equal(matchesLibrarySearch('肖邦 Op.21','肖邦 521'),false);
  assert.equal(matchesLibrarySearch('anything',''),true);
});
