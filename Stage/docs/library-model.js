const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
export const compareNames=(a,b)=>collator.compare(a,b);
const genres=[
  ['交响曲',/交响曲|symphon/i],['组曲',/组曲|\bsuites?\b/i],['舞曲',/匈牙利舞曲|hungarian dances/i],
  ['练习曲',/练习曲|[ée]tudes?|\bstudies\b|肖练/i],['叙事曲',/叙事曲|ballad[es]/i],
  ['前奏曲',/前奏曲|pr[eé]ludes?/i],['夜曲',/夜曲|nocturnes?/i],['即兴曲',/即兴曲|impromptus?/i],
  ['圆舞曲',/圆舞曲|waltz|valse/i],['谐谑曲',/谐谑曲|scherz[oi]/i],['奏鸣曲',/奏鸣曲|sonata/i],
  ['协奏曲',/协奏曲|concert[oi]/i],['波兰舞曲',/波兰舞曲|波洛奈兹|polonaise/i],['玛祖卡',/玛祖卡|马祖卡|mazurka/i],
  ['回旋曲',/回旋曲|rondo|克拉科维亚克/i],['变奏曲',/变奏曲|variations?/i],['幻想曲',/幻想曲|fantas[yi]|fantaisie/i],
  ['赋格',/赋格|\bfug[ae]/i],['卡农',/卡农|\bcanon\b/i],['船歌',/船歌|barcarolle/i],['摇篮曲',/摇篮曲|berceuse/i],
  ['室内乐',/三重奏|四重奏|五重奏|重奏作品|trio|quartet|quintet/i],['歌曲',/歌曲|\blieder\b/i],
  ['进行曲',/进行曲|\bmarch\b/i],['苏格兰舞曲',/苏格兰舞曲|ecossaise|ecossiase/i],['塔兰泰拉',/塔兰塔拉|塔兰泰拉|tarantell/i],['博莱罗',/博莱罗|bolero/i],
];
const games=/^(原神|鸣潮|崩坏3|崩坏：星穹铁道|崩坏:星穹铁道|崩坏星穹铁道|王者荣耀)$/;
const editionWords=/总谱|分谱|缩谱|独奏|双钢琴|四手|弦乐队版|木管四重奏|编曲[:：]|改编版|钢琴\s*[+与]\s*小提琴|小提琴\s*[+与]\s*钢琴|Mutopia|IMSLP\d|国家版|水印版|原版|预览版|草稿|工作稿|初稿|精修|定稿|副本|修订|原编号|原 Fontain|^v\d+|版本/i;
const normalize=s=>s.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
const trim=s=>s.replace(/^[\s,，·—–-]+|[\s,，·—–-]+$/g,'').replace(/\s+/g,' ').trim();

export function isAnimenzArrangement(item){
  const title=item.originalTitle||item.title||'',arranger=(item.arranger||'').trim();
  if((item.aliases||[]).some(path=>/-原创|原创作品/.test(path))||/Animenz[^-]*原创/i.test(title))return false;
  return /^animenzz*$/i.test(arranger)||/^animenzz*(?:[（(]编曲[）)])?\s*-/i.test(title)||/编曲\s*[:：]\s*animenzz*\b/i.test(title);
}

export function versionDisplayTitle(item){
  const title=item.originalTitle||item.title||'';
  if(!isAnimenzArrangement(item))return title;
  let name=title.replace(/^.+?\s+-\s+/, '');
  name=name.replace(/([（(])([^()（）]*)([）)])/g,(whole,left,inside,right)=>{
    if(!/编曲\s*[:：]\s*animenzz*\b/i.test(inside))return whole;
    const rest=inside.replace(/编曲\s*[:：]\s*animenzz*\b/ig,'').replace(/^[\s·,，;；]+|[\s·,，;；]+$/g,'');
    return rest?left+rest+right:'';
  });
  return 'Animenz（编曲） - '+name.trim();
}

export function describeWork(item){
  const title=(item.title||'未命名曲谱').replace(/\.(pdf|sib|mscz|mscx|musicxml|mxl)$/i,'').trim();
  const split=/^(.+?)\s+-\s+(.+)$/.exec(title),prefix=split?.[1]||'';
  const isGame=games.test(prefix),unknown=!item.composer||/待核对|未知/.test(item.composer);
  const composer=isGame?prefix:unknown&&prefix&&!/待核对|未知/.test(prefix)?prefix:item.composer||'作曲家待核对';
  let name=split?.[2]||title;
  if(isGame)name=name.replace(/^HOYO-MiX\s*-\s*/i,'');
  const edition=[];
  name=name.replace(/[（(]([^()（）]*)[）)]/g,(whole,inside)=>{
    if(!editionWords.test(inside))return whole;
    edition.push(inside);return '';
  });
  // Only remove explicit edition/part suffixes. Never remove keys, work numbers,
  // dates, movement/phase names, or arbitrary parenthetical subtitles.
  name=name.replace(/\s*[-—–]\s*(?:小提琴\s*\d*|电吉他|四弦吉他)\s*$/i,part=>{edition.push(trim(part));return '';});
  name=name.replace(/\s*(?:[-—–]\s*)?(?:总谱.*|双钢琴版|一架钢琴版|钢琴独奏改编|钢琴六轨分声部|钢琴完整织体|钢琴分谱|小提琴分谱|人声分谱|五线谱)(?:\s.*)?$/i,part=>{edition.push(trim(part));return '';});
  name=name.replace(/\s*(?:[-—–]\s*)?(?:钢琴\s*[+与]\s*(?:小提琴|voice|电吉他)(?:\s*\+\s*new)?|小提琴\s*[+与]\s*钢琴|piano\s*\+\s*violin)(?:\s+\d+)?\s*$/i,part=>{edition.push(trim(part));return '';});
  name=name.replace(/\s*[-—–]?\s*(?:play version|coda revision|simple|[^\s-]{1,20}版本|v\d+(?:\.\d+)?|20\d{12}|钢琴|独奏)\s*$/i,part=>{edition.push(trim(part));return '';});
  name=trim(name);
  const originalContext=[name,...(item.aliases||[])].join(' ');
  const genre=isGame?'游戏配乐':genres.find(([,pattern])=>pattern.test(name))?.[0]||genres.find(([,pattern])=>pattern.test(originalContext))?.[0]||(/合集|全集|作品集|补遗/.test(name)?'作品合集':item.style==='动漫／影视'||/Animenz/.test(prefix)?'动漫／影视':item.style==='流行音乐'?'流行歌曲':'其他作品');
  const classical=!isGame&&/古典|浪漫|巴洛克|印象|当代钢琴/.test(item.style||'');
  // Anime OP1/OP2 means opening theme, not an opus number.
  const opus=classical?/\b(Op|BWV|D|S|K|KV|Hob)\.?\s*(\d+[a-z]?)(?:\s*[,.:·-]?\s*(?:No|Nr)\.?\s*(\d+[a-z]?))?/i.exec(name):null;
  // Genre is part of the key: Op.72 can contain a nocturne, march, and dances.
  // No. is used only AFTER the catalogue number; "Concerto No.2, Op.21" is Op.21.
  const identity=opus?`${opus[1].toLowerCase()}:${opus[2].toLowerCase()}${opus[3]?':no'+opus[3].toLowerCase():''}:${genre}${genre==='其他作品'?':'+normalize(name):''}`:normalize(name);
  const ambiguous=!name||/^(总谱|钢琴|曲谱|未命名曲谱)$/.test(name)||/^IMSLP\d/i.test(name);
  const key=`${normalize(composer)}|${identity}${ambiguous?'|'+(item.sourceId||item.id):''}`;
  if(genres.some(([label])=>label===name))name+='（合集）';
  if(!name)name=title;
  const folder=(item.aliases?.[0]||'').split('/').slice(0,-1).findLast(x=>/\d\s*版|国家版|原典版|手稿|Henle|Peters|Breitkopf|Mutopia/i.test(x));
  if(folder&&!edition.some(x=>x.includes(folder)))edition.push(folder);
  if(item.arranger&&!edition.some(x=>x.includes(item.arranger)))edition.push('编曲：'+item.arranger);
  return {key,title:name,composer,genre,classical,catalogue:!!opus,stem:normalize(opus?name.replace(opus[0],''):name),edition:edition.filter(Boolean).join(' · ')||'未标注版本',search:[title,composer,item.composer,item.arranger,...(item.aliases||[])].join(' ').toLocaleLowerCase()};
}

export function groupWorks(items){
  const map=new Map(),described=items.map(item=>({item,description:describeWork(item)})),catalogued=new Map();
  for(const {description:d} of described){if(d.catalogue){const alias=d.composer+'|'+d.genre+'|'+d.stem;const keys=catalogued.get(alias)||new Set();keys.add(d.key);catalogued.set(alias,keys);}}
  for(const {item,description} of described){
    if(description.classical&&!description.catalogue){const keys=catalogued.get(description.composer+'|'+description.genre+'|'+description.stem);if(keys?.size===1)description.key=[...keys][0];}
    let work=map.get(description.key);
    if(!work){work={...description,style:item.style,era:item.era,category:item.category,versions:[]};map.set(work.key,work);}
    work.versions.push({...item,originalTitle:item.title,title:versionDisplayTitle(item),edition:description.edition,workTitle:description.title,search:description.search});
    if((description.catalogue&&!work.catalogue)||(description.catalogue===work.catalogue&&description.title.length<work.title.length)){work.title=description.title;work.catalogue=description.catalogue;}
  }
  for(const work of map.values()){
    work.versions.sort((a,b)=>compareNames(a.edition,b.edition)||compareNames(a.title,b.title)||compareNames(a.id,b.id));
    const names=new Map();for(const v of work.versions)names.set(v.edition,(names.get(v.edition)||0)+1);
    for(const v of work.versions){const suffix=names.get(v.edition)>1?' · '+(v.sourceId||v.id).slice(0,6):'';v.versionLabel=`${v.edition}${suffix} · ${v.format.toUpperCase()}`;}
    work.browseGroup=browseGroup(work);
    const pdfs=work.versions.filter(v=>v.format==='pdf');
    work.displayTitle=(pdfs.length&&pdfs.every(isAnimenzArrangement)?'Animenz（编曲） - ':'')+work.title;
    work.search=(work.browseGroup+' '+work.displayTitle+' '+work.versions.map(v=>v.search).join(' ')).toLocaleLowerCase();
  }
  return [...map.values()].sort((a,b)=>compareNames(a.title,b.title));
}

// Navigation categories are independent of authorship and stable work keys.
// Regrouping the shelf must not reset saved editions or merge unrelated songs.
export function browseGroup(work){
  if(games.test(work.composer))return work.composer;
  const context=work.versions.map(v=>[v.title,v.arranger,...(v.aliases||[])].join(' ')).join(' ');
  if(/animenz/i.test(context+' '+work.composer))return 'Animenz';
  if(work.style==='动漫／影视'||/天气之子/.test(context))return '动漫';
  if(work.style==='流行音乐'||work.genre==='流行歌曲'||/流行音乐|流行歌曲/.test(work.category||'')||/教父主题曲/.test(work.title))return '流行音乐';
  return work.composer;
}

export function chooseVersion(work,sourceId){
  const ready=work.versions.filter(v=>v.format==='pdf'&&v.available);
  return ready.find(v=>(v.sourceId||v.id)===sourceId||v.id===sourceId)||ready.reduce((latest,v)=>(Date.parse(v.modifiedAt)||0)>(Date.parse(latest?.modifiedAt)||0)?v:latest,ready[0])||null;
}
