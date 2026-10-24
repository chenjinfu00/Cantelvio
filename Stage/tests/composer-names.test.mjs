import test from 'node:test';
import assert from 'node:assert/strict';
import {composerDisplayName} from '../docs/composer-names.js';

test('known composers use familiar names only for display',()=>{
  const names=[
    ['安东宁·德沃夏克','德沃夏克'],
    ['安东尼奥·维瓦尔第','维瓦尔第'],
    ['尼古拉·卡普斯汀','卡普斯汀'],
    ['尼古拉·里姆斯基-科萨科夫','里姆斯基-科萨科夫'],
    ['尼诺·罗塔','罗塔'],
    ['弗朗茨·李斯特','李斯特'],
    ['弗雷德里克·肖邦','肖邦'],
    ['彼得·柴可夫斯基','柴可夫斯基'],
    ['恩里克·格拉纳多斯','格拉纳多斯'],
    ['沃尔夫冈·阿马德乌斯·莫扎特','莫扎特'],
    ['约翰·塞巴斯蒂安·巴赫','巴赫'],
    ['约翰内斯·勃拉姆斯','勃拉姆斯'],
    ['谢尔盖·拉赫玛尼诺夫','拉赫玛尼诺夫'],
    ['贝拉·巴托克','巴托克'],
    ['费利克斯·门德尔松','门德尔松'],
    ['路德维希·范·贝多芬','贝多芬'],
  ];
  for(const [full,short] of names)assert.equal(composerDisplayName(full),short);
  const catalog=Object.freeze({composer:'弗雷德里克·肖邦'});
  assert.equal(composerDisplayName(catalog.composer),'肖邦');
  assert.equal(catalog.composer,'弗雷德里克·肖邦');
});

test('unknown composers, game groups, Chinese names and existing short names stay intact',()=>{
  for(const name of ['肖邦','莫扎特','贝多芬','巴赫','陈致逸','原神','动漫','流行音乐与其他游戏','其他','未知作曲家','constructor','__proto__',''])
    assert.equal(composerDisplayName(name),name);
});
