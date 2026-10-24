import {groupWorks,chooseVersion,compareNames} from './library-model.js';
import {versionPreferences} from './version-preferences.js';
import {prioritizeLibraryGroups,readLibraryRecency,rememberLibraryRecency} from './library-recency.js';
import {matchesLibrarySearch} from './library-search.js';
import {composerDisplayName} from './composer-names.js';
const $=id=>document.getElementById(id);
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};

export function setupLibrary(openPDF,toast,canOpen,getCurrentScore=()=>null,getOffline=async()=>null){
  let localSource=null;   // a folder chosen on this device, read instead of the network
  let items=[],works=[],mode='composer',selected='',genre='',loaded=false,localLibrary=false,refreshTask=null,opening=false,currentWork=null,recency=readLibraryRecency();
  const preferences=versionPreferences();
  const feedback=(node,message,error=false)=>{node.hidden=!message;node.textContent=message;node.classList.toggle('error',error);};
  const counts=(list,field)=>{const groups=new Map();for(const work of list){const key=work[field]||'待核对';groups.set(key,(groups.get(key)||0)+1);}return [...groups].sort(([a],[b])=>compareNames(a,b));};
  const button=(text,fn,style='secondary')=>{const b=el('button',text,style);b.type='button';b.onclick=fn;return b;};
  const pickGroup=key=>{selected=selected===key&&!genre?'':key;genre='';draw();$('library-content').scrollTop=0;};
  const pickGenre=key=>{genre=key;draw();$('library-content').scrollTop=0;};
  const rememberOpened=work=>{recency=rememberLibraryRecency(work);};

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
    $('edition-hint').textContent='';$('edition-hint').hidden=true;
    syncControls();
  }
  async function openWork(work,explicitVersion,statusNode){
    if(opening||!canOpen()){feedback(statusNode,'请等待当前曲谱加载完成，或先停止聆听／学习。');return;}
    opening=true;syncControls();feedback(statusNode,'正在打开…');
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
        rememberOpened(work);setCurrent();feedback($('edition-status'),failed?message:'',failed);feedback(statusNode,failed?message:'',failed);
        $('library-dialog').close();return;
      }
      if(!local&&localSource&&!localSource.needsFolder&&localSource.missing?.includes?.(version.id))throw new Error('本地曲谱文件夹里没有这份 PDF。请检查文件夹，或重新选择。');
      if(!local)throw new Error('这份曲谱在本地曲谱文件夹里找不到。请在左栏重新选择文件夹。');
      await openPDF({id:version.id,url:local,path:localSource?.path?.(version.id)||null,workKey:work.key,local:true},version.title,null,message=>feedback(statusNode,message));
      let message='已记住此版本，下次打开这首曲目会继续使用。',failed=false;
      try{await preferences.save(work.key,version.sourceId||version.id);}catch{message='曲谱已打开，但此次版本选择未能保存。下次可在这里重新选择。';failed=true;}
      rememberOpened(work);setCurrent();feedback($('edition-status'),failed?message:'',failed);feedback(statusNode,failed?message:'',failed);
      $('library-dialog').close();
    }catch(error){feedback(statusNode,error.message||'打开失败，请重试。',true);setCurrent();}
    finally{opening=false;syncControls();}
  }
  $('edition-select').onchange=()=>{
    const work=currentWork,version=work?.versions.find(v=>v.id===$('edition-select').value);
    if(version)openWork(work,version,$('edition-status'));
  };
  function card(work){
    const node=el('article',null,'library-card work-card'),statusNode=el('p',null,'library-open-status');statusNode.hidden=true;statusNode.setAttribute('role','status');
    const heading=el('h3'),open=button(work.displayTitle,()=>openWork(work,null,statusNode),'work-title-button');open.dataset.openScore='true';heading.append(open);
    node.append(heading,statusNode);
    return node;
  }
  function draw(){
    const query=$('library-search').value.toLocaleLowerCase().trim(),format=$('library-format').value;
    const filtered=works.filter(work=>(!format||work.versions.some(v=>v.format===format))&&matchesLibrarySearch(work.search,query));
    const groupField=mode==='composer'?'browseGroup':mode,remembered=mode==='composer'?recency.composer:recency[mode];
    const groupName=key=>mode==='composer'?composerDisplayName(key):key;
    const groups=prioritizeLibraryGroups(counts(filtered,groupField).sort(([a],[b])=>compareNames(groupName(a),groupName(b))),remembered);
    if(selected&&!groups.some(([key])=>key===selected)){selected='';genre='';}
    const inGroup=filtered.filter(work=>!selected||work[groupField]===selected);
    if(genre&&!inGroup.some(work=>work.genre===genre))genre='';
    const nav=$('library-groups'),focusedKey=nav.contains(document.activeElement)?document.activeElement.dataset.navKey:null,scroll=nav.scrollTop;
    const groupButton=(name,count,fn,className,key,current)=>{
      const b=button('',fn,className+(current?' selected':''));b.append(el('span',name,'library-group-name'),el('span',String(count),'library-group-count'));b.dataset.navKey=key;
      if(current)b.setAttribute('aria-current','true');return b;
    };
    nav.replaceChildren(groupButton('曲目概览',filtered.length,()=>{selected='';genre='';draw();$('library-content').scrollTop=0;},'library-group','overview',!selected));
    for(const [key,count] of groups){
      const members=filtered.filter(work=>work[groupField]===key),genres=mode==='composer'?prioritizeLibraryGroups(counts(members,'genre'),key===recency.composer?recency.genre:''):[];
      const parent=groupButton(groupName(key),count,()=>pickGroup(key),'library-group','group:'+key,key===selected);
      if(genres.length>1)parent.setAttribute('aria-expanded',String(key===selected));
      nav.append(parent);
      if(key===selected&&genres.length>1){
        const children=el('div',null,'library-subgroups');children.setAttribute('role','group');children.setAttribute('aria-label',groupName(key)+'的体裁');
        children.append(groupButton('全部曲目',members.length,()=>pickGenre(''),'library-subgroup','genre:all',!genre));
        for(const [name,total] of genres)children.append(groupButton(name,total,()=>pickGenre(name),'library-subgroup','genre:'+name,genre===name));
        nav.append(children);
      }
    }
    if(focusedKey)[...nav.querySelectorAll('button')].find(b=>b.dataset.navKey===focusedKey)?.focus({preventScroll:true});nav.scrollTop=scroll;
    const breadcrumbs=$('library-breadcrumbs');breadcrumbs.replaceChildren(button('曲目概览',()=>pickGroup(''),'quiet'));
    if(selected)breadcrumbs.append(el('span','›'),button(groupName(selected),()=>pickGenre(''),'quiet'));
    if(genre)breadcrumbs.append(el('span','›'),el('strong',genre));
    const results=$('library-results');results.replaceChildren();
    const inGenre=inGroup.filter(work=>!genre||work.genre===genre);
    $('library-count').textContent=inGenre.length+' 首曲目';
    for(const work of inGenre)results.append(card(work));
    if(!inGenre.length)$('library-count').textContent=loaded?(works.length?'没有匹配的曲目':'选择曲谱文件夹'):'正在读取…';
    syncControls();
  }
  const refresh=()=>{
    if(refreshTask)return refreshTask;
    $('library-refresh').disabled=true;$('library-refresh').textContent='正在检查…';
    refreshTask=(async()=>{
      $('library-count').textContent='正在核对曲谱下载状态…';
      // The collection is a folder on this device. There is no server to ask.
      if(loaded&&localSource?.reload)await localSource.reload();
      const data=localSource?.catalog||{items:[]};
      items=data.items||[];works=groupWorks(items);localLibrary=data.localLibrary===true;loaded=true;draw();setCurrent();
      if(localLibrary)$('account-note').textContent=localSource?.kind==='server'?'本地谱库 · 仅在当前局域网提供':'本机曲谱库 · 文件保留在当前设备';
      const pending=items.filter(x=>!x.available).length,ready=items.filter(x=>x.format==='pdf'&&x.available).length;
      $('library-summary').textContent=works.filter(w=>w.versions.some(v=>v.format==='pdf')).length+' 首曲目 · '+ready+' 份 PDF'+(pending?' · '+pending+' 份暂不可用':'');
      // Without a server there is nothing to refresh; the shelf is whatever folder you point at.
      if(!localSource&&!items.length){
        $('library-summary').textContent='';
        feedback($('library-download-help'),'选择本地或 iCloud 曲谱文件夹');
        return;
      }
      feedback($('library-download-help'),'');
    })().finally(()=>{refreshTask=null;$('library-refresh').disabled=false;$('library-refresh').textContent='刷新谱库';});
    return refreshTask;
  };
  $('library-refresh').onclick=()=>refresh().catch(e=>{$('library-count').textContent=e.message;});
  $('library-button').onclick=async()=>{if(!$('library-dialog').open)$('library-dialog').showModal();try{await refresh();$('library-search').focus({preventScroll:true});}catch(e){$('library-count').textContent=e.message;}};
  $('library-search').oninput=()=>{selected='';genre='';draw();$('library-content').scrollTop=0;};$('library-format').onchange=draw;
  $('library-mode').onchange=e=>{mode=e.target.value;selected='';genre='';draw();};
  return {refresh,setCurrent,syncControls,item:id=>items.find(entry=>entry.id===id)||null,
    useLocal(source){localSource=source;loaded=false;return refresh();},
    get local(){return localSource;}};
}
