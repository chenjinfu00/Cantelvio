import test from 'node:test';
import assert from 'node:assert/strict';
import {regionFor,REGIONS} from '../scripts/region-rules.mjs';
import {regionPlan} from '../scripts/tag-regions.mjs';
import {groupWorks} from '../docs/library-model.js';

test('a track lands in the region its place or character comes from',()=>{
  const cases={'原神 - Watatsumi Island 1':'稻妻','原神 - 溢彩华庭（海祇岛BGM）':'稻妻','原神 - 神女劈观':'璃月',
    '原神 - The Fading Stories (Qingce Night)':'璃月','原神 - Battle Theme of Andrius - Wolf of the North':'蒙德',
    '原神 - 龙脊雪山 BGM2':'蒙德','原神 - Hadramaveth Desert 2':'须弥','原神 - 翠草之龙':'须弥',
    '原神 - Court of Fontaine Main Theme':'枫丹','原神 - 咏歌与凯旋 Lamentation et triomphe':'枫丹',
    '原神 - 纳塔战斗曲 3':'纳塔','原神 - 挪德卡莱 Nod-Krai':'至冬','原神 - Golden Apple Archipelago Night OST #1':'活动与其他'};
  for(const [title,region] of Object.entries(cases))assert.equal(regionFor(title),region,title);
  for(const region of Object.values(cases))assert.ok(REGIONS.includes(region));
});

test('an unrecognised track stays undecided instead of being guessed into a region',()=>{
  assert.equal(regionFor('原神 - 总谱'),null);
  const items=[{id:'a'.repeat(64),title:'原神 - 总谱',composer:'原神'},{id:'b'.repeat(64),title:'原神 - Vanarana',composer:'原神'},
    {id:'c'.repeat(64),title:'肖邦 - 夜曲',composer:'弗雷德里克·肖邦'}];
  const {changes,undecided}=regionPlan(items);
  assert.deepEqual(changes.map(c=>c.region),['须弥']);
  assert.deepEqual(undecided.map(i=>i.title),['原神 - 总谱'],'it is listed, not silently filed');
  assert.equal(changes.length,1,'only the game shelf is touched');
  const forced=regionPlan(items,{overrides:{['a'.repeat(8)]:'璃月'}});
  assert.deepEqual(forced.undecided,[],'a manual answer settles it');
  assert.equal(forced.changes.find(c=>c.id.startsWith('a')).region,'璃月');
  assert.throws(()=>regionPlan(items,{overrides:{['a'.repeat(8)]:'月球'}}),/未知地区/);
});

test('the region becomes the second level of the game shelf, and the work key does not move',()=>{
  const track=extra=>({id:'x'.repeat(64),sourceId:'x'.repeat(64),title:'原神 - Vanarana',format:'pdf',available:true,bytes:1,
    aliases:[],modifiedAt:'2026-01-01T00:00:00.000Z',composer:'原神',style:'游戏音乐',era:'21 世纪',...extra});
  const [before]=groupWorks([track()]),[after]=groupWorks([track({region:'须弥'})]);
  assert.equal(before.genre,'游戏配乐');
  assert.equal(after.genre,'须弥','the shelf drills down by region');
  assert.equal(after.key,before.key,'saved edition choices survive the regrouping');
  assert.equal(after.browseGroup,'原神');
});
