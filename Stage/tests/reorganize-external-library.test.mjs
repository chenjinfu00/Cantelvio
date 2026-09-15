import test from 'node:test';
import assert from 'node:assert/strict';
import {createExternalPlan} from '../scripts/reorganize-external-library.mjs';

const known='a'.repeat(64),other='b'.repeat(64);

test('known PDFs use the exact Volta library path',()=>{
  const records=[{relative:'旧目录/旧名字.pdf',extension:'.pdf',bytes:10,hash:known}];
  const plan=createExternalPlan(records,{[known]:'曲谱/游戏音乐/原神/璃月/标准名字 · aaaaaaaa.pdf'});
  assert.deepEqual(plan.moves.map(move=>move.target),['游戏音乐/原神/璃月/标准名字 · aaaaaaaa.pdf']);
  assert.equal(plan.summary.matchedUnique,1);
});

test('exact duplicate copies are preserved for review',()=>{
  const records=[
    {relative:'短名.pdf',extension:'.pdf',bytes:10,hash:known},
    {relative:'旧目录/副本.pdf',extension:'.pdf',bytes:10,hash:known}
  ];
  const plan=createExternalPlan(records,{[known]:'曲谱/Animenz/动漫／影视/作品 · aaaaaaaa.pdf'});
  assert.equal(plan.summary.duplicateCopies,1);
  assert.ok(plan.moves.some(move=>move.target==='重复文件待确认/副本 · aaaaaaaa.pdf'));
});

test('unknown PDFs go to the import inbox and remove CN labels',()=>{
  const records=[{relative:'崩坏3/Da Capo (CN).pdf',extension:'.pdf',bytes:10,hash:other}];
  const plan=createExternalPlan(records,{});
  assert.equal(plan.moves[0].target,'新导入 PDF/Da Capo · bbbbbbbb.pdf');
  assert.equal(plan.moves[0].kind,'new-pdf');
});

test('editable scores and media are retained under related sources',()=>{
  const records=[
    {relative:'原神/翠草之龙.mscz',extension:'.mscz',bytes:10},
    {relative:'王者荣耀/1.PNG',extension:'.png',bytes:20},
    {relative:'旧目录/.DS_Store',extension:'',bytes:30}
  ];
  const plan=createExternalPlan(records,{});
  assert.deepEqual(plan.moves.map(move=>move.target),[
    '相关源文件/原神/翠草之龙.mscz',
    '相关源文件/王者荣耀/1.PNG',
    '.整理元数据/旧目录/.DS_Store'
  ]);
});

test('already organized files are left in place',()=>{
  const records=[
    {relative:'游戏音乐/原神/璃月/标准名字 · aaaaaaaa.pdf',extension:'.pdf',bytes:10,hash:known},
    {relative:'重复文件待确认/副本 · aaaaaaaa.pdf',extension:'.pdf',bytes:10,hash:known},
    {relative:'新导入 PDF/Da Capo · bbbbbbbb.pdf',extension:'.pdf',bytes:10,hash:other},
    {relative:'相关源文件/原神/翠草之龙.mscz',extension:'.mscz',bytes:10}
  ];
  const plan=createExternalPlan(records,{[known]:'曲谱/游戏音乐/原神/璃月/标准名字 · aaaaaaaa.pdf'});
  assert.equal(plan.moves.length,0);
  assert.equal(plan.summary.unchanged,4);
});
