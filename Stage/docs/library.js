import {groupWorks,chooseVersion,compareNames} from './library-model.js';
import {versionPreferences} from './version-preferences.js';
const $=id=>document.getElementById(id);
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};

export function setupLibrary(openPDF,toast,canOpen,getCurrentScore=()=>null,getOffline=async()=>null){
  let localSource=null;   // a folder chosen on this device, read instead of the network
  let items=[],works=[],mode='composer',selected='',genre='',loaded=false,localLibrary=false,refreshTask=null,opening=false,currentWork=null;
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
      // The selected folder is the source of truth. A remembered catalogue has no file handles,
      // so iPad asks for the same root once before opening a score. Old device caches remain only
      // as a backwards-compatible fallback and are never preferred over the local file.
      let local=localSource?await localSource.url(version.id):null;
      if(!local&&localSource?.needsFolder)await localSource.reopen?.();
      local=localSource?await localSource.url(version.id):null;
      const offline=!local?await getOffline(version.id).catch(()=>null):null;
      if(!local&&offline){
        await openPDF(offline.remote,version.title,null,message=>feedback(statusNode,message));
        let message='已从这台设备的离线副本打开；已记住此版本。',failed=false;
        try{await preferences.save(work.key,version.sourceId||version.id);}catch{message='曲谱已打开，但此次版本选择未能保存。下次可在这里重新选择。';failed=true;}
        setCurrent();feedback($('edition-status'),message,failed);feedback(statusNode,statusNode===$('edition-status')?message:'',failed);
        $('library-dialog').close();return;
      }
      if(!local&&localSource&&!localSource.needsFolder&&localSource.missing?.includes?.(version.id))throw new Error('本地曲谱文件夹里没有这份 PDF。请检查文件夹，或重新选择。');
      if(!local)throw new Error('这份曲谱在本地曲谱文件夹里找不到。请在左栏重新选择文件夹。');
      await openPDF({id:version.id,url:local,path:localSource?.path?.(version.id)||null,workKey:work.key,local:true},version.title,null,message=>feedback(statusNode,message));
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
  function versionDetails(work,statusNode){
    const details=el('details',null,'work-versions');details.append(el('summary','版本与来源 · '+work.versions.length));
    for(const item of work.versions){
      const row=el('section',null,'work-version');row.append(el('strong',item.versionLabel),el('p',item.title),el('small',(item.bytes/1048576).toFixed(1)+' MB · '+(item.aliases||[]).length+' 个来源'));
      const sources=el('details');sources.append(el('summary','查看原文件位置与资料依据'),el('p',item.metadataStatus+'。'+item.aliases.join('；')));row.append(sources);
      if(!item.available){row.append(button('暂不可用 · 查看位置',()=>{sources.open=true;feedback(statusNode,localLibrary?'请在 Finder 中找到来源文件，下载后点“刷新谱库”。':'这个版本尚未导入谱库存储。');}));}
      else if(item.format==='pdf'){const b=button('打开此版本',()=>openWork(work,item,statusNode));b.dataset.openScore='true';row.append(b);}
      details.append(row);
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
      // The collection is a folder on this device. There is no server to ask.
      const data=localSource?.catalog||{items:[]};
      items=data.items||[];works=groupWorks(items);localLibrary=data.localLibrary===true;loaded=true;draw();setCurrent();
      if(localLibrary)$('account-note').textContent='本地谱库 · 仅在当前局域网提供';
      const pending=items.filter(x=>!x.available).length,ready=items.filter(x=>x.format==='pdf'&&x.available).length;
      $('library-summary').textContent=works.filter(w=>w.versions.some(v=>v.format==='pdf')).length+' 首曲目／合集 · '+ready+' 份 PDF 可打开'+(pending?' · '+pending+' 份暂不可用':'');
      // Without a server there is nothing to refresh; the shelf is whatever folder you point at.
      if(!localSource&&!items.length){
        $('library-summary').textContent='曲谱库还是空的';
        $('library-download-help').textContent='在左栏点「选择本地曲谱文件夹」，选中你存放曲谱的文件夹，这里就会出现你的全部曲目。';
        return;
      }
      $('library-download-help').textContent='曲谱来自你选的本地文件夹 · 首次打开默认最新版本，以后记住你的选择。';
    })().finally(()=>{refreshTask=null;$('library-refresh').disabled=false;$('library-refresh').textContent='刷新谱库';});
    return refreshTask;
  };
  $('library-refresh').onclick=()=>refresh().catch(e=>{$('library-count').textContent=e.message;});
  $('library-button').onclick=async()=>{$('library-dialog').showModal();try{await refresh();}catch(e){$('library-count').textContent=e.message;}};
  $('library-search').oninput=()=>{selected='';genre='';draw();};$('library-format').onchange=draw;
  $('library-mode').onchange=e=>{mode=e.target.value;selected='';genre='';draw();};
  return {refresh,setCurrent,syncControls,item:id=>items.find(entry=>entry.id===id)||null,
    useLocal(source){localSource=source;loaded=false;return refresh();},
    get local(){return localSource;}};
}
