import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeName,workNames,buildIndex,matchSource,sourcePlan,SOURCE_TYPES} from '../scripts/attach-sources.mjs';

const item=(id,title,aliases)=>({id:id.repeat(64),title,aliases});
const files={
  ['a'.repeat(64)]:'曲谱/Animenz/动漫／影视/Hikaru Nara-四月是你的谎言/Hikaru Nara-四月是你的谎言 · aaaaaaaa.pdf',
  ['b'.repeat(64)]:'曲谱/原神/璃月/神女劈观/神女劈观 · bbbbbbbb.pdf',
  ['c'.repeat(64)]:'曲谱/原神/璃月/神女劈观/总谱 · cccccccc.pdf',
};
const items=[
  item('a','Animenz（编曲） - Hikaru Nara-四月是你的谎言',['Hikaru Nara-四月是你的谎言.pdf']),
  item('b','原神 - 神女劈观',[]),item('c','原神 - 神女劈观 - 总谱',[]),
];

test('names that differ only by punctuation, case or a version note are the same name',()=>{
  assert.equal(normalizeName('Hikaru Nara.mid'),normalizeName('hikaru-nara'));
  assert.equal(normalizeName('Again-钢之炼金术师FA-OP1（2016年3月19日更新）'),normalizeName('Again-钢之炼金术师FA-OP1'));
  assert.equal(normalizeName('Rewrite v2 - Lenno Liu.mid'),normalizeName('Rewrite - Lenno Liu'));
  assert.notEqual(normalizeName('神女劈观'),normalizeName('神女劈观 总谱'));
});

test('a work answers to its folder, its titles and the file names it came from',()=>{
  const names=workNames('曲谱/Animenz/动漫／影视/Hikaru Nara-四月是你的谎言',[items[0]]);
  assert.ok(names.includes(normalizeName('Hikaru Nara-四月是你的谎言')));
  assert.ok(!names.some(name=>name.startsWith('曲谱')),'a generated path is not a name');
});

test('a source lands in its work folder, by folder name or by its own name',()=>{
  const index=buildIndex(files,items);
  const plan=sourcePlan([
    'Animenz合集/Hikaru Nara-四月是你的谎言/Hikaru Nara.mid',
    'Animenz合集/Hikaru Nara-四月是你的谎言/Hikaru Nara.sib',
    '随便一个文件夹/神女劈观.mid',
    '读我.txt',
  ],index);
  assert.deepEqual(plan.matched.map(move=>move.target),[
    '曲谱/Animenz/动漫／影视/Hikaru Nara-四月是你的谎言/Hikaru Nara.mid',
    '曲谱/Animenz/动漫／影视/Hikaru Nara-四月是你的谎言/Hikaru Nara.sib',
    '曲谱/原神/璃月/神女劈观/神女劈观.mid',
  ]);
  assert.deepEqual(plan.unmatched,[],'a .txt is not a source file at all');
  assert.ok(SOURCE_TYPES.includes('.mid')&&SOURCE_TYPES.includes('.musicxml'));
});

test('a name two works answer to is left for a person to decide',()=>{
  // Stripping the bracket makes these two works share a name, exactly as they do in the collection.
  const shared={
    ['e'.repeat(64)]:'曲谱/原神/须弥/散兵周本音乐改编/散兵周本音乐改编 · eeeeeeee.pdf',
    ['f'.repeat(64)]:'曲谱/原神/须弥/散兵周本音乐改编（适用于长笛小提琴等）/散兵周本音乐改编 · ffffffff.pdf',
  };
  const index=buildIndex({...files,...shared},[...items,
    item('e','原神 - 散兵周本音乐改编',[]),item('f','原神 - 散兵周本音乐改编（适用于长笛小提琴等）',[])]);
  assert.equal(matchSource('某处/散兵周本音乐改编.mscz',index),null,'two folders could take it, so neither does');
  assert.ok(matchSource('某处/Hikaru Nara.mid',index),'an unambiguous name still lands');
});
