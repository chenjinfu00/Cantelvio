// Keep catalog names intact while using familiar composer names in the interface.
const commonNames=new Map([
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
]);

export function composerDisplayName(full){return commonNames.get(full)??full;}
