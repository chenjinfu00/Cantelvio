// Which part of Teyvat a Genshin track belongs to. Keyword order matters: a specific place or
// character name wins over a generic word, and anything unmatched stays undecided on purpose.
export const REGIONS=['蒙德','璃月','稻妻','须弥','枫丹','纳塔','至冬','活动与其他'];
export const RULES=[
  ['稻妻',['海祇岛','watatsumi','inazuma','稻妻','seirai','tsurumi','enkanomiya','渊下宫','kamisato','神里','gorou','arataki','itto','kirara','綺良々','signora','scaramouche battle theme phase 2','tsubaki','雪晴れ','三千娑世御咏歌','皎洁的笑颜','命定的离别','永夜与破晓','噬神巨蛇','雷车动地','溢彩华庭']],
  ['璃月',['liyue','璃月','华灯星聚','明霄幻梦','神女劈观','azhdaha','若陀龙王','岩壑之崩','childe','ganyu','radiant dreams','hu tao','let the living beware','shenhe','lonesome dream','瑶瑶','仙桂莹澈','guizhong','rex incognito','the chasm','层岩','轻策','qingce','rage beneath the mountains','杯中明月','银花玉鉴','wandering clouds','all that glitters','tender strength','fading stories']],
  ['蒙德',['andrius','wolf of the north','北风之狼','北风狼','klee','venti','bards business','rosaria','mika','ミカ','米卡','albedo','contemplation in snow','eula','flickering candlelight','优菈','浪沫起舞','龙脊雪山','dragonspine','snow-buried','蒙德','mondstadt','new day with hope','windblume','山巅雪国']],
  ['须弥',['sumeru','须弥','aaru','hadramaveth','mawtiyima','farakhkert','vanarana','vimara','devantaka','tighnari','collei','nilou','妮露','七域的蕖华','candace','alhaitham','艾尔海森','faruzan','ファルザン','wanderer','散兵','魔像督军','翠草之龙','花神']],
  ['枫丹',['fontaine','枫丹','vaguelette','轻涟','终天的闭幕曲','戏中人','furina','フリーナ','碎浪之舞','花与剑的轮舞','rondeau des fleurs','咏歌与凯旋','lamentation et triomphe','souvenir avec le crepuscule','focalors','安魂的协奏曲','希望的航程','待诉说的传说','特尔克西']],
  ['纳塔',['natlan','纳塔','name forged in flames','rapid as wildfires','炽烈的还魂诗','虚空鼓动','苍原的颂灵歌','烈风的序章','烬火','天遒歌','emberfire','dance-in-fire','燃烬之舞']],
  ['至冬',['snezhnaya','至冬','挪德卡莱','nod-krai','nod krai','冰湖的凯旋礼','triumph on the ice','白鸽之诗','song of the white dove','银白的希望']],
  ['活动与其他',['golden apple','海岛','summer fantasia','website bgm','音乐会','ragtime','jazz','happy journey','飞车','3.8','lovers oath','transparent moon','pledge and forgettance','statue of marble and brass','冰风组曲','沉睡的往昔','无虑无猜的岁月','足迹','何妄何执','诗人的工作','博士周本','天霁日出']],
];
export function regionFor(title,extra=''){
  const haystack=(String(title||'')+' '+String(extra||'')).toLocaleLowerCase();
  for(const [region,keys] of RULES)for(const key of keys)if(haystack.includes(key.toLocaleLowerCase()))return region;
  return null;
}
