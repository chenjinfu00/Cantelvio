import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryRelativePath,replaceLibraryAlias} from '../scripts/library-paths.mjs';
import {reorganizationPlan} from '../scripts/reorganize-library.mjs';

const pdf=(id,title,extra={})=>({id:id.repeat(64),sourceId:id.repeat(64),title,format:'pdf',available:true,bytes:1,aliases:[],modifiedAt:'2026-01-01T00:00:00.000Z',...extra});

test('physical folders are the Volta shelf, level for level',()=>{
  const genshin=libraryRelativePath(pdf('a','原神 - 神女劈观',{composer:'原神',style:'游戏音乐',region:'璃月'}));
  assert.equal(genshin.relative,'曲谱/原神/璃月/神女劈观/神女劈观 · aaaaaaaa.pdf');
  const animenz=libraryRelativePath(pdf('b','Animenz（编曲） - 红莲の弓矢',{composer:'Animenz',arranger:'Animenz',style:'动漫／影视'}));
  assert.equal(animenz.relative,'曲谱/Animenz/动漫／影视/红莲の弓矢/红莲の弓矢 · bbbbbbbb.pdf');
  const honour=libraryRelativePath(pdf('c','王者荣耀 - 曲谱合集',{composer:'王者荣耀',style:'游戏音乐'}));
  assert.equal(honour.relative,'曲谱/Animenz/曲谱合集/曲谱合集 · cccccccc.pdf');
  const classical=libraryRelativePath(pdf('d','王建中 - 彩云追月',{composer:'王建中',style:'中国作品'}));
  assert.equal(classical.relative,'曲谱/王建中/彩云追月/彩云追月 · dddddddd.pdf');
  const classicalAgain=libraryRelativePath(pdf('d','王建中 - 彩云追月',{composer:'王建中',style:'中国作品'}),{current:classical.relative});
  assert.equal(classicalAgain.relative,classical.relative,'a composer folder is not mistaken for a manually curated genre');
  const pop=libraryRelativePath(pdf('f','张宇 - 给你们',{composer:'张宇',style:'流行音乐',aliases:['曲谱/流行音乐/歌曲/旧文件.pdf','给你们.pdf']}));
  assert.equal(pop.relative,'曲谱/流行音乐/给你们/给你们 · ffffffff.pdf','a generic genre does not add another folder');
  const curated=libraryRelativePath(pdf('g','陈致逸 - 嬉皮之舞',{composer:'陈致逸',style:'当代钢琴'}),{current:'曲谱/陈致逸/练习曲/旧文件.pdf'});
  assert.match(curated.relative,/\/陈致逸\/练习曲\//,'a manual genre survives when the filename has no replacement evidence');
  const honkai=libraryRelativePath(pdf('h','崩坏3 - Rubia',{composer:'崩坏3',style:'游戏音乐'}));
  assert.equal(honkai.relative,'曲谱/崩坏3/Rubia/Rubia · hhhhhhhh.pdf');
  const anime=libraryRelativePath(pdf('i','Purrvoice（编曲） - 大丈夫',{composer:'Purrvoice',style:'动漫／影视'}));
  assert.equal(anime.relative,'曲谱/动漫/大丈夫/大丈夫 · iiiiiiii.pdf');
  const pending=libraryRelativePath(pdf('j','作曲待核对 - 未知作品',{composer:'作曲家待核对'}));
  assert.equal(pending.relative,'曲谱/作曲家待核对/未知作品/未知作品 · jjjjjjjj.pdf');
});

test('a plan moves only paths that disagree and replaces stale generated aliases',()=>{
  const item=pdf('e','Animenz（编曲） - Secret Base',{composer:'Animenz',arranger:'Animenz',style:'动漫／影视',aliases:['曲谱/old.pdf','source.pdf']});
  const plan=reorganizationPlan([item],{[item.id]:'曲谱/old.pdf'});
  assert.equal(plan.length,1);assert.match(plan[0].next,/Secret Base · eeeeeeee\.pdf$/);
  assert.deepEqual(replaceLibraryAlias(item.aliases,plan[0].next),[plan[0].next,'source.pdf']);
  assert.equal(reorganizationPlan([item],{[item.id]:plan[0].next}).length,0);
});

test('two versions of one work never disagree on the folder spelling',()=>{
  const lower=pdf('k','崩坏3 - nightglow',{composer:'崩坏3',style:'游戏音乐'});
  const upper=pdf('l','崩坏3 - Nightglow（编曲：CC Music）',{composer:'崩坏3',style:'游戏音乐'});
  const plan=reorganizationPlan([lower,upper],{[lower.id]:'曲谱/旧1.pdf',[upper.id]:'曲谱/旧2.pdf'});
  const folders=plan.map(move=>move.next.split('/').slice(0,-1).join('/'));
  assert.equal(folders[0],folders[1],'a case-folding filesystem would otherwise merge them by accident');
  assert.notEqual(plan[0].next,plan[1].next,'each version keeps its own file');
});
