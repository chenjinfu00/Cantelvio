import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanTitle,cleanComposer,retitlePlan,renamedPath} from '../scripts/retitle-scores.mjs';

test('download leftovers disappear, real parentheses stay',()=>{
  assert.equal(cleanTitle('原神 - 无虑无猜的岁月(1)(1)（编曲：琴竹风）'),'原神 - 无虑无猜的岁月（编曲：琴竹风）');
  assert.equal(cleanTitle('原神 - Albedo - Contemplation in Snow (2)'),'原神 - Albedo - Contemplation in Snow');
  assert.equal(cleanTitle('帕赫贝尔 - D大调卡农（弦乐队版·IMSLP120365·副本 2）'),'帕赫贝尔 - D大调卡农（弦乐队版·IMSLP120365）');
  assert.equal(cleanTitle('崩坏3 - Da Capo (CN)'),'崩坏3 - Da Capo');
  assert.equal(cleanTitle('原神 - 碎浪之舞（原编号 1）'),'原神 - 碎浪之舞');
  // Parentheses that carry meaning are never touched.
  for(const keep of ['原神 - 虚空鼓动，劫火高扬 (Part1)（水印版·编曲：树袋熊）','Animenz - This is (not) the end',
    '格拉纳多斯 - Goyescas, Op. 11 (Henle)','肖邦 - 第二钢琴协奏曲 Op.21（第一小提琴分谱）','原神 - Lovers Oath (FULL)（编曲：CC Music Piano and Stuff）',
    '肖邦 - Mazurka In D Major (1820)','肖邦 - 降B大调波兰舞曲 (1817)'])
    assert.equal(cleanTitle(keep),keep);
});

test('the role in a composer name moves out of the shelf label',()=>{
  assert.equal(cleanComposer('Animenz（编曲）'),'Animenz');
  assert.equal(cleanComposer('冼星海（原作）'),'冼星海');
  assert.equal(cleanComposer('王建中（编曲）'),'王建中');
  assert.equal(cleanComposer('莫扎特（存疑归属）'),'莫扎特（存疑归属）','a real caveat is not a role');
  assert.equal(cleanComposer('弗雷德里克·肖邦'),'弗雷德里克·肖邦');
});

test('a plan covers only what changes, and a one-off title can be set by hand',()=>{
  const items=[
    {id:'a'.repeat(64),title:'崩坏3 - Lyin - See You in the Next World（编曲：CC）',composer:'崩坏3'},
    {id:'b'.repeat(64),title:'原神 - 花神之舞(1)（编曲：树袋熊）',composer:'原神'},
    {id:'c'.repeat(64),title:'肖邦 - 夜曲',composer:'弗雷德里克·肖邦'},
  ];
  const plan=retitlePlan(items,{overrides:{['a'.repeat(8)]:'崩坏3 - See You in the Next World（编曲：CC）'}});
  assert.equal(plan.length,2,'an untouched score is not in the plan');
  assert.equal(plan[0].to,'崩坏3 - See You in the Next World（编曲：CC）');
  assert.equal(plan[1].to,'原神 - 花神之舞（编曲：树袋熊）');
});

test('renaming follows the title but keeps the id suffix and the folder',()=>{
  assert.equal(renamedPath('曲谱/游戏音乐/原神/原神 - 花神之舞(1) · 63a2fd02.pdf','原神 - 花神之舞(1)','原神 - 花神之舞'),
    '曲谱/游戏音乐/原神/原神 - 花神之舞 · 63a2fd02.pdf');
  assert.equal(renamedPath('曲谱/a/别的名字.pdf','原名','新名'),'曲谱/a/别的名字.pdf','a file named differently is left alone');
  assert.equal(renamedPath(null,'a','b'),null);
});

import {groupWorks} from '../docs/library-model.js';
const pdf=(title,extra={})=>({id:title,sourceId:title,title,format:'pdf',available:true,bytes:1,aliases:[],modifiedAt:'2026-01-01T00:00:00.000Z',composer:'Animenz',arranger:'Animenz',style:'动漫／影视',era:'21 世纪',...extra});

test('the Animenz shelf shows song names, not the arranger on every line',()=>{
  const works=groupWorks([pdf('Animenz（编曲） - 红莲の弓矢-进击的巨人OP'),pdf('Animenz - unlasting')]);
  assert.deepEqual(works.map(w=>w.browseGroup),['Animenz','Animenz']);
  for(const work of works){
    assert.doesNotMatch(work.displayTitle,/Animenz/,'the shelf already says Animenz');
    assert.doesNotMatch(work.versions[0].title,/Animenz（编曲）/);
    assert.equal(work.animenz,true,'the arrangement is still recognised as Animenz');
  }
  assert.match(works.map(w=>w.search).join(' '),/animenz/,'searching for animenz still finds them');
});

test('a franchise with a single arrangement joins the Animenz shelf instead of standing alone',()=>{
  const [work]=groupWorks([pdf('王者荣耀 - 曲谱合集',{composer:'王者荣耀',arranger:null,style:'游戏音乐'})]);
  assert.equal(work.browseGroup,'Animenz');
  const [genshin]=groupWorks([pdf('原神 - 璃月',{composer:'原神',arranger:null,style:'游戏音乐'})]);
  assert.equal(genshin.browseGroup,'原神','the big franchises keep their own shelf');
});
