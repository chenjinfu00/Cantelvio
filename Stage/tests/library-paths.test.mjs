import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryRelativePath,replaceLibraryAlias} from '../scripts/library-paths.mjs';
import {reorganizationPlan} from '../scripts/reorganize-library.mjs';

const pdf=(id,title,extra={})=>({id:id.repeat(64),sourceId:id.repeat(64),title,format:'pdf',available:true,bytes:1,aliases:[],modifiedAt:'2026-01-01T00:00:00.000Z',...extra});

test('physical folders are the Volta shelf, level for level',()=>{
  const genshin=libraryRelativePath(pdf('a','原神 - 神女劈观',{composer:'原神',style:'游戏音乐',region:'璃月'}));
  assert.equal(genshin.relative,'原神/璃月/神女劈观/神女劈观 · aaaaaaaa.pdf');
  const animenz=libraryRelativePath(pdf('b','Animenz（编曲） - 红莲の弓矢',{composer:'Animenz',arranger:'Animenz',style:'动漫／影视'}));
  assert.equal(animenz.relative,'Animenz/动漫／影视/红莲の弓矢/红莲の弓矢 · bbbbbbbb.pdf');
  const honour=libraryRelativePath(pdf('c','王者荣耀 - 曲谱合集',{composer:'王者荣耀',style:'游戏音乐'}));
  assert.equal(honour.relative,'Animenz/曲谱合集/曲谱合集 · cccccccc.pdf');
  const classical=libraryRelativePath(pdf('d','王建中 - 彩云追月',{composer:'王建中',style:'中国作品'}));
  assert.equal(classical.relative,'王建中/彩云追月/彩云追月 · dddddddd.pdf');
  const classicalAgain=libraryRelativePath(pdf('d','王建中 - 彩云追月',{composer:'王建中',style:'中国作品'}),{current:classical.relative});
  assert.equal(classicalAgain.relative,classical.relative,'a composer folder is not mistaken for a manually curated genre');
  const pop=libraryRelativePath(pdf('f','张宇 - 给你们',{composer:'张宇',style:'流行音乐',aliases:['曲谱/流行音乐/歌曲/旧文件.pdf','给你们.pdf']}));
  assert.equal(pop.relative,'流行音乐/给你们/给你们 · ffffffff.pdf','a generic genre does not add another folder');
  const curated=libraryRelativePath(pdf('g','陈致逸 - 嬉皮之舞',{composer:'陈致逸',style:'当代钢琴'}),{current:'陈致逸/练习曲/旧文件.pdf'});
  assert.match(curated.relative,/^陈致逸\/练习曲\//,'a manual genre survives when the filename has no replacement evidence');
  const honkai=libraryRelativePath(pdf('h','崩坏3 - Rubia',{composer:'崩坏3',style:'游戏音乐'}));
  assert.equal(honkai.relative,'崩坏3/Rubia/Rubia · hhhhhhhh.pdf');
  const anime=libraryRelativePath(pdf('i','Purrvoice（编曲） - 大丈夫',{composer:'Purrvoice',style:'动漫／影视'}));
  assert.equal(anime.relative,'动漫/大丈夫/大丈夫 · iiiiiiii.pdf');
  const pending=libraryRelativePath(pdf('j','作曲待核对 - 未知作品',{composer:'作曲家待核对'}));
  assert.equal(pending.relative,'作曲家待核对/未知作品/未知作品 · jjjjjjjj.pdf');
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

test('a shelf with only a couple of works is not sorted by genre as well',()=>{
  const lone=pdf('m','冼星海 - 黄河钢琴协奏曲（双钢琴谱·编曲：殷承宗）',{composer:'冼星海',style:'中国音乐'});
  assert.match(libraryRelativePath(lone,{shelfWorks:1}).relative,/^冼星海\/黄河钢琴协奏曲\//);
  assert.match(libraryRelativePath(lone,{shelfWorks:40}).relative,/^冼星海\/协奏曲\/黄河钢琴协奏曲\//,'a full shelf keeps its genres');
});

test('a bracketed edition note never becomes part of the work name',()=>{
  const cases={
    '巴赫 - A小调小提琴协奏曲 BWV 1041（Sibley 版）':'A小调小提琴协奏曲 BWV 1041',
    '柴可夫斯基 - 第一钢琴协奏曲 Op.23（Peters·Teichmüller 版）':'第一钢琴协奏曲 Op.23',
    '里姆斯基-科萨科夫 - 野蜂飞舞（钢琴改编·Rachmaninoff／Kuliev）':'野蜂飞舞',
  };
  for(const [title,folder] of Object.entries(cases))
    assert.equal(libraryRelativePath(pdf('n',title,{composer:'x',style:'古典'}),{shelfWorks:99}).relative.split('/').at(-2),folder,title);
  // A name that only looks like one keeps every word.
  assert.equal(libraryRelativePath(pdf('o','原神 - 散兵周本音乐改编',{composer:'原神',style:'游戏音乐',region:'须弥'})).relative.split('/').at(-2),'散兵周本音乐改编');
});

test('a catalogue may state the version outright, so a merged work keeps one folder',()=>{
  const main=pdf('p','原神 - 轻涟',{composer:'原神',style:'游戏音乐',region:'枫丹',edition:'总谱'});
  const pv=pdf('q','原神 - 轻涟',{composer:'原神',style:'游戏音乐',region:'枫丹',edition:'功能谱剧情PV'});
  const [a,b]=[main,pv].map(item=>libraryRelativePath(item).relative);
  assert.equal(a.split('/').slice(0,-1).join('/'),b.split('/').slice(0,-1).join('/'),'both land in 轻涟');
  assert.match(a,/\/轻涟\/总谱 · pppppppp\.pdf$/);
  assert.match(b,/\/轻涟\/功能谱剧情PV · qqqqqqqq\.pdf$/);
});
