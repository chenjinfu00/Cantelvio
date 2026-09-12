import {groupWorks,chooseVersion,compareNames} from './library-model.js';
import {versionPreferences} from './version-preferences.js';
import {PUBLIC_LIBRARY,CLOUD_LIBRARY} from './site-config.js';
const $=id=>document.getElementById(id);
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};

export function setupLibrary(openPDF,toast,canOpen,getCurrentScore=()=>null){
  let items=[],works=[],mode='composer',selected='',genre='',loaded=false,metadataRevision='"new"',editing=null,localLibrary=false,refreshTask=null,opening=false,currentWork=null;
  const preferences=versionPreferences(),labels={composer:'曲目分类',style:'风格',era:'年代',category:'原收藏'};
  const feedback=(node,message,error=false)=>{node.hidden=!message;node.textContent=message;node.classList.toggle('error',error);};
  const counts=(list,field)=>{const groups=new Map();for(const work of list){const key=work[field]||'待核对';groups.set(key,(groups.get(key)||0)+1);}return [...groups].sort(([a],[b])=>compareNames(a,b));};
  const button=(text,fn,style='secondary')=>{const b=el('button',text,style);b.type='button';b.onclick=fn;return b;};
  const pickGroup=key=>{selected=key;genre='';draw();};
  const pickGenre=key=>{genre=key;draw();};

  function syncControls(){
    const locked=opening||!canOpen();
    $('edition-select').disabled=locked;
    for(const node of $('library-results').querySelectorAll('[data-open-score]'))node.disabled=locked;
  }
  function setCurrent(score=getCurrentScore()){
    currentWork=works.find(work=>work.versions.some(v=>v.id===score?.id))||null;
    $('edition-toolbar').hidden=!currentWork;
    if(!currentWork){if(score?.remote&&!loaded&&!refreshTask)refresh().catch(()=>{});return;}
    $('edition-work-title').textContent=currentWork.displayTitle;
    const currentVersion=currentWork.versions.find(v=>v.id===score.id);
    if(currentVersion){score.name=currentVersion.title;$('score-title').textContent=currentVersion.title;}
    const select=$('edition-select');select.replaceChildren();
    for(const version of currentWork.versions.filter(v=>v.format==='pdf')){
      const option=el('option',version.versionLabel+(version.available?'':' · 暂不可用'));option.value=version.id;option.disabled=!version.available;select.append(option);
    }
    select.value=score.id;
    $('edition-hint').textContent='切换后记住此版本；页码、批注与翻页点按版本分别保存。';
    syncControls();
  }
  async function openWork(work,explicitVersion,statusNode){
    if(opening||!canOpen()){feedback(statusNode,'请等待当前曲谱加载完成，或先停止聆听／学习。');return;}
    opening=true;syncControls();feedback(statusNode,explicitVersion?'正在打开版本…':'正在读取上次使用的版本…');
    try{
      const previous=explicitVersion?null:await preferences.load(work.key);
      const version=explicitVersion||chooseVersion(work,previous);
      if(!version||!version.available)throw new Error(localLibrary?'这首曲目暂无可打开的 PDF。请先下载对应文件，再刷新谱库。':'这首曲目暂无已导入的 PDF。');
      await openPDF({id:version.id,url:new URL(PUBLIC_LIBRARY?'./scores/'+version.id+'.pdf':'./api/files/'+version.id,location.href).href,workKey:work.key},version.title,null,message=>feedback(statusNode,message));
      let message='已记住此版本，下次打开这首曲目会继续使用。',failed=false;
      try{await preferences.save(work.key,version.sourceId||version.id);}catch{message='曲谱已打开，但此次版本选择未能保存。下次可在这里重新选择。';failed=true;}
      setCurrent();feedback($('edition-status'),message,failed);feedback(statusNode,statusNode===$('edition-status')?message:'',failed);
      $('library-dialog').close();
    }catch(error){feedback(statusNode,error.message||'打开失败，请重试。',true);setCurrent();}
    finally{opening=false;syncControls();}
  }
  $('edition-select').onchange=()=>{
    const work=currentWork,version=work?.versions.find(v=>v.id===$('edition-select').value);
    if(version)openWork(work,version,$('edition-status'));
  };
  function editVersion(item){
    editing=item;
    for(const name of ['composer','arranger','style','era','year','editionYear'])$('meta-'+name).value=item[name]||'';
    $('metadata-title').textContent=item.title;$('metadata-status').textContent='';$('metadata-dialog').showModal();
  }
  function versionDetails(work,statusNode){
    const details=el('details',null,'work-versions');details.append(el('summary','版本与来源 · '+work.versions.length));
    for(const item of work.versions){
      const row=el('section',null,'work-version');row.append(el('strong',item.versionLabel),el('p',item.title),el('small',(item.bytes/1048576).toFixed(1)+' MB · '+item.aliases.length+' 个来源'));
      const sources=el('details');sources.append(el('summary','查看原文件位置与资料依据'),el('p',item.metadataStatus+'。'+item.aliases.join('；')));row.append(sources);
      if(!item.available){row.append(button('暂不可用 · 查看位置',()=>{sources.open=true;feedback(statusNode,localLibrary?'请在 Finder 中找到来源文件，下载后点“刷新谱库”。':'这个版本尚未导入谱库存储。');}));}
      else if(item.format==='pdf'){const b=button('打开此版本',()=>openWork(work,item,statusNode));b.dataset.openScore='true';row.append(b);}
      else{const a=el('a','下载制谱源文件','secondary');a.href='./api/files/'+item.id;a.download=item.title+'.'+item.format;row.append(a);}
      if(!PUBLIC_LIBRARY)row.append(button('整理资料',()=>editVersion(item),'quiet'));details.append(row);
    }
    return details;
  }
  function card(work){
    const node=el('article',null,'library-card work-card'),statusNode=el('p',null,'library-open-status');statusNode.hidden=true;statusNode.setAttribute('role','status');
    const ready=work.versions.filter(v=>v.available&&v.format==='pdf').length;
    node.append(el('h3',work.displayTitle),el('p',work.composer+' · '+work.genre),el('small',work.versions.length+' 个版本／源文件 · '+ready+' 个 PDF 可打开'));
    const open=button('打开曲目',()=>openWork(work,null,statusNode));open.dataset.openScore='true';node.append(open,statusNode,versionDetails(work,statusNode));
    return node;
  }
  function draw(){
    const query=$('library-search').value.toLocaleLowerCase().trim(),format=$('library-format').value;
    const filtered=works.filter(work=>(!format||work.versions.some(v=>v.format===format))&&(!query||work.search.includes(query)));
    const groupField=mode==='composer'?'browseGroup':mode,groups=counts(filtered,groupField);
    if(selected&&!groups.some(([key])=>key===selected)){selected='';genre='';}
    const nav=$('library-groups');nav.replaceChildren(button('曲目概览 · '+filtered.length,()=>pickGroup(''),'library-group'+(!selected?' selected':'')));
    for(const [key,count] of groups)nav.append(button(key+' · '+count,()=>pickGroup(key),'library-group'+(key===selected?' selected':'')));
    const breadcrumbs=$('library-breadcrumbs');breadcrumbs.replaceChildren(button('曲目概览',()=>pickGroup(''),'quiet'));
    if(selected)breadcrumbs.append(el('span','/'),button(selected,()=>pickGenre(''),'quiet'));
    if(genre)breadcrumbs.append(el('span','/'),el('strong',genre==='*'?'全部曲目':genre));
    const results=$('library-results');results.replaceChildren();
    const inGroup=filtered.filter(work=>!selected||work[groupField]===selected);
    const inGenre=inGroup.filter(work=>!genre||genre==='*'||work.genre===genre);
    const addCategory=(name,count,fn)=>{const b=button('',fn,'library-category-card');b.append(el('strong',name),el('span',count+' 首曲目／合集'));results.append(b);};
    if(!selected&&!query){
      $('library-count').textContent='按'+labels[mode]+'浏览 · 同曲的版本收在一起';
      for(const [key,count] of groups)addCategory(key,count,()=>pickGroup(key));
    }else if(selected&&mode==='composer'&&!['流行音乐','动漫','Animenz'].includes(selected)&&!genre&&!query&&counts(inGroup,'genre').length>1){
      $('library-count').textContent=selected+' · 先选择体裁';
      addCategory('全部曲目',inGroup.length,()=>pickGenre('*'));
      for(const [key,count] of counts(inGroup,'genre'))addCategory(key,count,()=>pickGenre(key));
    }else{
      $('library-count').textContent=inGenre.length+' 首曲目／合集 · 打开时使用上次成功载入的版本';
      for(const work of inGenre)results.append(card(work));
      if(!inGenre.length)$('library-count').textContent=loaded?'没有匹配的曲目。':'正在读取曲谱库…';
    }
    syncControls();
  }
  const refresh=()=>{
    if(refreshTask)return refreshTask;
    $('library-refresh').disabled=true;$('library-refresh').textContent='正在检查…';
    refreshTask=(async()=>{
      $('library-count').textContent='正在核对曲谱下载状态…';
      const response=await fetch(PUBLIC_LIBRARY?'./library/catalog.json':'./api/library',{cache:'no-store'});
      if(!response.ok)throw new Error('曲谱库暂时不可用，请检查网络后重试。');
      const data=await response.json();items=data.items||[];works=groupWorks(items);localLibrary=data.localLibrary===true;metadataRevision=data.metadataRevision||'"new"';loaded=true;draw();setCurrent();
      if(localLibrary)$('account-note').textContent='本地谱库 · 仅在当前局域网提供';
      const pending=items.filter(x=>!x.available).length,ready=items.filter(x=>x.format==='pdf'&&x.available).length;
      $('library-summary').textContent=works.filter(w=>w.versions.some(v=>v.format==='pdf')).length+' 首曲目／合集 · '+ready+' 份 PDF 可打开'+(pending?' · '+pending+' 份暂不可用':'');
      $('library-download-help').textContent=CLOUD_LIBRARY?'私人云端谱库 · 下载完整后可离线使用；批注在设置中按需更新。':localLibrary?(pending?'在 Finder 中下载曲谱后，刷新即可打开。':'本地分类谱库 · 未上传公开网站 · 首次打开默认最新版本，以后记住你的选择。'):PUBLIC_LIBRARY?'公开试用谱库 · 批注与上次使用的版本仅保存在当前浏览器。':'刷新查看曲谱库的最新内容。';
    })().finally(()=>{refreshTask=null;$('library-refresh').disabled=false;$('library-refresh').textContent='刷新谱库';});
    return refreshTask;
  };
  $('library-refresh').onclick=()=>refresh().catch(e=>{$('library-count').textContent=e.message;});
  $('library-button').onclick=async()=>{$('library-dialog').showModal();try{await refresh();}catch(e){$('library-count').textContent=e.message;}};
  $('library-search').oninput=()=>{selected='';genre='';draw();};$('library-format').onchange=draw;
  $('library-mode').onchange=e=>{mode=e.target.value;selected='';genre='';draw();};
  $('metadata-form').onsubmit=async e=>{
    e.preventDefault();if(!editing||PUBLIC_LIBRARY)return;
    const values={};for(const key of ['composer','arranger','style','era'])values[key]=$('meta-'+key).value.trim();
    for(const key of ['year','editionYear'])values[key]=$('meta-'+key).value?Number($('meta-'+key).value):null;
    $('metadata-save').disabled=true;
    try{const response=await fetch('./api/metadata/'+(editing.sourceId||editing.id.replace('pending-','')),{method:'PUT',headers:{'Content-Type':'application/json','If-Match':metadataRevision},body:JSON.stringify(values)});
      if(!response.ok)throw new Error((await response.json()).error||'保存失败');
      $('metadata-dialog').close();await refresh();toast('资料已保存，分类已更新。');
    }catch(error){$('metadata-status').textContent=error.message;}finally{$('metadata-save').disabled=false;}
  };
  return {refresh,setCurrent,syncControls};
}
