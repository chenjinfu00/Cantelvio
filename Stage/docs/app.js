import * as pdfjs from './vendor/pdf.mjs';
import {analyzeAudio,Microphone} from './audio.js';
import {OnlineMatcher,TurnController,frameAtTime,validateReference,FEATURE_VERSION,MAX_FRAMES} from './matcher.js';
import {scoreID,saveScore,savePosition,loadScore} from './storage.js';
import {setupLibrary} from './library.js';
import {Ink} from './ink.js';
import {loadPDFDocument} from './pdf-document.js';
import {PerformanceMode,performanceKey,ManualTurnGuard} from './performance-mode.js';
import {PageRenderCache,renderScorePage,adjacentPages} from './page-cache.js';
import {includeInk} from './fit-layout.js';
import {ReaderShell,TurnQueue,fullscreenElement,requestScoreFullscreen,leaveScoreFullscreen} from './reader-shell.js';
import {setupSettings} from './settings.js';
import {setupOffline,offlineScore} from './offline.js';
import {setupDeploy} from './offline-deploy.js';
import {installReaderViewport} from './reader-viewport.js';
import {ReadingPosition} from './reading-position.js';
import {setupRecentScores} from './recent-scores.js';
import {setupBookmarks} from './bookmarks.js';
import {setupMIDI} from './midi-ui.js';
import {setupLocalFolder} from './local-library.js';
import {setupAnnotationBackup,drainInk,showMerged} from './annotation-backup.js';
import {setupInkFolder} from './ink-folder.js';
import {BUILD_INFO,VERSION_UPDATE} from './build-info.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs',import.meta.url).href;
const $ = id => document.getElementById(id);
const state={score:null,pdf:null,page:1,spread:false,phase:'idle',draft:null,reference:null,microphone:null,matcher:null,turner:null,renderId:0,audioURL:null,abort:null,startAnchor:0,frameTime:0,op:0,zoom:1,fit:'screen'};
const ink=new Ink(toast,{canWrite:()=>!!state.pdf&&state.phase==='idle'&&!performing()});
const readerViewport=installReaderViewport();
const readingPosition=new ReadingPosition($('score-stage'));
let toastTimer,wakeLock,resizeTimer,library,recent,bookmarks,midi,performanceMode,performanceSnapshot,performanceTurning=false,shell,offline,inkFolder;
let cachePDF=null,visibleKeys=[],previewKeys=[],warmTimer,fitProfile=null;
const pageCache=new PageRenderCache((page,metrics,signal)=>renderScorePage(cachePDF,page,metrics,signal));
const previewCache=new PageRenderCache((page,metrics,signal)=>renderScorePage(cachePDF,page,metrics,signal),{maxEntries:12,maxPixels:3_500_000});
const settings=setupSettings(()=>{clearTimeout(warmTimer);if(!settings.value.preload){pageCache.prioritize(visibleKeys);previewCache.prioritize([]);}action(renderPages)();},toast);
const performing=()=>!!performanceMode?.active;
const manualTurnGuard=new ManualTurnGuard();
const canPerform=()=>!!state.pdf&&['idle','following'].includes(state.phase)&&!busy();
const busy=()=>performanceTurning||['analyzing','starting','loading','saving'].includes(state.phase);
const learning=()=>['learning','reference'].includes(state.phase);
const formatTime=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
function toast(message){if(performing())return;$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function errorMessage(e){if(e.name==='NotAllowedError')return '麦克风未获许可。请在浏览器地址栏允许麦克风后重试。';if(e.name==='NotFoundError')return '没有找到麦克风，请连接或选择输入设备。';if(e.name==='NotReadableError')return '麦克风暂时不可用，请关闭其他占用它的程序。';return e.message||'操作未完成，请重试。';}
function action(fn){return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(e=>{if(e.name!=='AbortError')toast(errorMessage(e));});}

function controls(){
  library?.syncControls();
  const loaded=!!state.pdf,locked=busy();
  $('performance-open').disabled=!canPerform()||performing();
  $('performance-page-counter').textContent=loaded?`${state.page}${state.spread&&state.page<state.pdf.numPages?'–'+(state.page+1):''} / ${state.pdf.numPages}`:'';
  $('performance-follow-status').textContent=state.phase==='following'?'自动＋手动':'手动翻页';
  $('performance-begin').disabled=!canPerform();
  $('performance-listen').disabled=!canPerform()||!state.reference;
  $('performance-listen').textContent=state.phase==='following'?'关闭自动翻页':'开启自动翻页';
  if(!$('performance-setup-status').classList.contains('error'))$('performance-setup-status').textContent=state.phase==='starting'?'正在连接麦克风…':state.phase==='following'?'麦克风已开启：自动跟随和手动翻页同时可用。':state.reference?'已有学习记录。可以先开启自动翻页，也可以只用手动。':'这份曲谱尚未学习翻页点，现在可手动演出；学习完成后可启用自动跟随。';
  $('library-button').disabled=state.phase!=='idle'||performing();
  $('ink-toolbar').hidden=!loaded||state.phase!=='idle'||performing();
  for(const id of ['ink-pen','ink-erase','ink-undo','ink-redo','score-zoom'])$(id).disabled=!loaded||state.phase!=='idle';
  if(state.phase!=='idle'&&ink.mode!=='read')ink.setMode('read');
  for(const id of ['import-button','empty-import','empty-folder','demo-button','url-import'])$(id).disabled=locked||learning()||state.phase==='following';
  $('audio-button').disabled=!loaded||state.phase!=='idle';$('learn-button').disabled=!loaded||state.phase!=='idle';
  $('prev-button').disabled=!loaded||state.page===1||locked;$('next-button').disabled=!loaded||state.page>=state.pdf.numPages||locked;
  $('page-input').disabled=!loaded||locked;$('page-input').value=state.page;
  const range=$('page-range');range.disabled=!loaded||locked;range.max=loaded?state.pdf.numPages:1;
  if(document.activeElement!==range)range.value=state.page;
  $('page-count').textContent=loaded?`/ ${state.pdf.numPages}`:'/ —';
  bookmarks?.refresh();
  $('page-label').textContent=loaded?`PDF 第 ${state.page}${state.spread&&state.page<state.pdf.numPages?'–'+(state.page+1):''} 页`:'等待导入';
  $('listen-button').disabled=state.phase!=='following'&&(state.phase!=='idle'||!state.reference);
  $('listen-button').textContent=state.phase==='following'?'停止聆听':'开始聆听 ↗';
  $('finish-button').disabled=!learning();$('mark-button').disabled=!learning()||state.page>=state.pdf?.numPages;
  $('mark-page').textContent=state.page+1;
  $('spread-button').disabled=learning()||locked;
  $('single-button').classList.toggle('selected',!state.spread);$('single-button').setAttribute('aria-pressed',String(!state.spread));
  $('spread-button').classList.toggle('selected',state.spread);$('spread-button').setAttribute('aria-pressed',String(state.spread));
  $('reference-panel').hidden=!learning()&&state.phase!=='analyzing';
  if(learning()||state.phase==='analyzing')$('practice-drawer').open=true;
  $('reference-audio').hidden=state.phase==='learning';
  $('set-start-button').hidden=state.phase!=='reference';$('rest-button').hidden=state.phase!=='reference';
  $('rest-button').textContent=state.draft?.restStart!==undefined?'标记钢琴重新进入':'标记钢琴休止开始';
  $('reference-hint').textContent=state.phase==='reference'?'先跳过乐队引子，设定练习起点。纯乐队片段可标记休止开始和重新进入，系统将跳过这些参考声音。翻页请在下一页第一个音处标记。':'弹到下一页第一个音时手动翻页。钢琴休止时保持安静，继续弹奏后再标记。';
  $('reference-status').textContent=state.phase==='learning'?`正在学习 ${formatTime(state.frameTime)}`:state.phase==='analyzing'?'正在分析声音…':state.draft?`${state.draft.anchors.length-1} 个翻页点`:'准备中';
}

function status(title,subtitle,detail){$('listening-title').textContent=title;$('listening-subtitle').textContent=subtitle;if(detail)$('confidence-label').textContent=detail;}
function ready(){
  document.querySelector('.listening-bar').classList.remove('listening');
  $('meter').querySelectorAll('span').forEach(s=>{s.style.height='6px';s.style.background='';});
  if(state.reference)status('翻页点准备好了','回到起始页，点击开始聆听',`${state.reference.anchors.length-1} 个翻页点 · 保存在本机`);
  else if(state.pdf)status('学习这首作品的翻页点','导入录音，或用麦克风弹一遍','尚未学习参考演奏');
  else status('准备好，就开始演奏','先导入曲谱并学习一次翻页点','等待准备');
}
async function persist(){
  if(!state.score)return;
  try{await saveScore({...state.score,page:state.page,reference:state.reference});}
  catch{toast('浏览器存储不足，当前仍可使用，但关闭后可能需要重新导入。');}
}
async function openPDF(buffer,name,restored=null,onProgress){
  if(performing())throw new Error('请先退出演出模式再切换曲谱。');
  const remote=buffer?.url?buffer:null;
  if(!remote&&buffer.byteLength>60*1024*1024)throw new Error('手动导入的 PDF 请小于 60 MB；曲谱库中的大文件采用按需读取。');
  const oldPhase=state.phase;state.phase='loading';controls();$('render-status').hidden=false;
  clearTimeout(warmTimer);state.renderId++;pageCache.prioritize([]);previewCache.prioritize([]);
  try{
    const id=remote?.id||await scoreID(buffer),saved=restored||await loadScore(id).catch(()=>null);
    const source=remote?{url:remote.url,withCredentials:true,disableAutoFetch:true,disableStream:true,rangeChunkSize:262144}:{data:new Uint8Array(buffer.slice(0))};
    onProgress?.('正在读取曲谱…');
    const pdf=await loadPDFDocument(pdfjs.getDocument,{...source,cMapUrl:new URL('./vendor/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/wasm/',import.meta.url).href,isEvalSupported:false},state.pdf,({loaded,total})=>{
      onProgress?.(total?`正在读取曲谱 ${Math.min(100,Math.round(loaded/total*100))}%…`:'正在读取曲谱…');
    });
    $('chopin-audio')?.remove();
    await inkFolder?.save({quiet:true}).catch(()=>{});
    state.pdf=pdf;state.score=remote?{id,name,remote,path:remote.path||null,local:!!remote.local,system:!!remote.system}:{id,name,buffer,path:buffer.path||null,local:false,system:false};state.reference=null;state.draft=null;state.startAnchor=0;state.zoom=1;state.fit='screen';$('score-zoom').value='screen';ink.setScore(id);bookmarks?.setScore(state.score);midi?.setScore(library?.item(id));
    fitProfile=null;
    // Page bounds travel with the collection, in its own folder.
    try{
      const profile=await library?.local?.fit?.(id);
      if(profile?.id===id&&profile.pages?.length===pdf.numPages)fitProfile=profile;
    }catch{}
    readingPosition.setScore(id);
    if(saved?.reference){try{state.reference=validateReference(saved.reference,pdf.numPages);}catch{toast('旧的学习记录需要重新建立；PDF 已恢复。');}}
    state.page=Math.max(1,Math.min(pdf.numPages,saved?.page||1));
    $('score-title').textContent=name.replace(/\.pdf$/i,'');$('reader-title').textContent=name.replace(/\.pdf$/i,'');$('score-meta').textContent=`${pdf.numPages} 页 · ${remote?'曲谱库':'本机导入'}`;
    $('empty-state').hidden=true;$('pages').hidden=false;
    onProgress?.('正在显示谱页…');
  controls();renderAnchors();ready();await renderPages();await persist();library?.setCurrent(state.score);if(!state.score.system)recent?.remember({id,name,path:state.score.path||library?.local?.path?.(id)||null});shell?.close();offline?.refresh();
  }finally{state.phase=oldPhase;$('render-status').hidden=true;controls();}
}
async function renderPages({anchor=null,beforePaint=()=>{}}={}){
  if(!state.pdf)return;
  const version=++state.renderId,pdf=state.pdf,page=state.page;
  const pose=settings.value.rememberPosition?readingPosition.snapshot():{x:0,y:0};
  clearTimeout(warmTimer);
  if(cachePDF!==pdf){pageCache.clear();previewCache.clear();visibleKeys=[];previewKeys=[];cachePDF=pdf;}
  const numbers=[page];if(state.spread&&page<pdf.numPages)numbers.push(page+1);
  const screenFit=state.fit==='screen',padding=screenFit?0:12,gap=screenFit?0:8;
  $('score-stage').classList.toggle('screen-fit',screenFit);$('pages').classList.toggle('screen-fit',screenFit);
  const metrics={width:Math.max(100,($('score-stage').clientWidth-padding-(numbers.length-1)*gap)/numbers.length),height:Math.max(100,$('score-stage').clientHeight-padding),zoom:state.zoom,fit:screenFit?'screen':'page',protectFit:settings.value.protectFit,density:Math.min(devicePixelRatio||1,2)};
  const low={...metrics,density:.4};
  const pageMetrics=new Map();
  const scoreId=state.score.id,profile=fitProfile;
  const forPage=async(p,preview=false)=>{
    if(!pageMetrics.has(p)){
      const record=await ink.record(scoreId,p);
      const bounds=includeInk(profile?.pages[p-1]?.bounds,record.data.strokes);
      pageMetrics.set(p,{...metrics,bounds});
    }
    const value=pageMetrics.get(p);return preview?{...value,density:low.density}:value;
  };
  for(const p of numbers)await forPage(p);
  if(version!==state.renderId)return;
  const keys=numbers.map(p=>pageCache.key(p,pageMetrics.get(p)));
  pageCache.pin([...visibleKeys,...keys]);pageCache.prioritize(keys);
  previewCache.prioritize([]);
  const paint=async values=>{
    if(version!==state.renderId)return;
    ink.clearViews();const container=document.createDocumentFragment();
    values.forEach((value,i)=>{const sheet=document.createElement('div'),paper=document.createElement('div'),clip=value.clip||{x:0,y:0,width:value.cssWidth,height:value.cssHeight};sheet.className='sheet';sheet.dataset.page=String(numbers[i]);sheet.style.width=clip.width+'px';sheet.style.height=clip.height+'px';paper.className='paper';paper.dataset.page=String(numbers[i]);paper.style.cssText=`position:relative;left:${-clip.x}px;top:${-clip.y}px;width:${value.cssWidth}px;height:${value.cssHeight}px`;paper.append(value.canvas);sheet.append(paper);container.append(sheet);});
    await readingPosition.paint(()=>{
      $('pages').replaceChildren(container);ink.page=page;
      $('pages').classList.toggle('zoomed',state.zoom>1);$('score-stage').classList.toggle('zoomed',state.zoom>1);
      beforePaint();
    },pose);
    if(anchor&&state.zoom>1){const stage=$('score-stage'),rect=$('pages').getBoundingClientRect();stage.scrollLeft+=rect.left+rect.width*anchor.x-anchor.clientX;stage.scrollTop+=rect.top+rect.height*anchor.y-anchor.clientY;readingPosition.remember();}
    const complete=values.every(v=>(v.clip?.width||v.cssWidth)<=metrics.width+1&&(v.clip?.height||v.cssHeight)<=metrics.height+1);
    $('fit-check-status').textContent=(fitProfile?`已检查全谱 ${fitProfile.pages.length} 页 · `:'尚无全谱边界记录，保守保留整页 · ')+(complete?'当前谱面与批注边界完整可见。':'放大阅读，需移动查看完整内容。');
    for(const paper of $('pages').querySelectorAll('.paper')){if(version!==state.renderId)return;await ink.attach(paper,Number(paper.dataset.page));}
  };
  // Swap in a pre-read preview immediately, then refine it without blanking paper.
  if(!numbers.every(p=>pageCache.has(p,pageMetrics.get(p)))&&numbers.every(p=>previewCache.has(p,{...pageMetrics.get(p),density:low.density}))){
    previewKeys=numbers.map(p=>previewCache.key(p,{...pageMetrics.get(p),density:low.density}));previewCache.pin(previewKeys);
    await paint(numbers.map(p=>previewCache.peek(p,{...pageMetrics.get(p),density:low.density})));
  }
  $('render-status').hidden=numbers.every(p=>pageCache.has(p,pageMetrics.get(p)));
  try{
    const values=await Promise.all(numbers.map(p=>pageCache.get(p,pageMetrics.get(p))));
    if(version!==state.renderId)return;
    await paint(values);if(version!==state.renderId)return;visibleKeys=keys;pageCache.pin(keys);previewKeys=[];previewCache.pin([]);if(!settings.value.preload)previewCache.clear();
    if(settings.value.preload)warmTimer=setTimeout(async()=>{
      try{
        // Full detail for the imminent turn; lightweight, decoded pages out to ±5.
        for(const p of adjacentPages(page,pdf.numPages,state.spread)){
          if(version!==state.renderId||!settings.value.preload)return;
          await pageCache.get(p,await forPage(p));
        }
        for(let distance=1;distance<=5;distance++)for(const p of [page+distance,page-distance]){
          if(version!==state.renderId||!settings.value.preload)return;
          if(p<1||p>pdf.numPages||numbers.includes(p))continue;
          if(pageCache.has(p,await forPage(p)))continue;
          await previewCache.get(p,await forPage(p,true));
        }
      }catch(error){if(error.name!=='AbortError')console.debug('Page pre-read deferred',error.name);}
    },120);
  }finally{if(version===state.renderId)$('render-status').hidden=true;}
}

function renderAnchors(){
  const ref=state.draft||state.reference,list=$('anchor-list');list.replaceChildren();
  if(!ref){const p=document.createElement('p');p.className='muted';p.textContent='学习完成后，翻页点会保存在这里。';list.append(p);return;}
  ref.anchors.forEach((a,i)=>{
    const row=document.createElement('div');row.className='anchor'+(state.page===a.page?' active':'');
    const button=document.createElement('button');button.className='text-button';button.style.textDecoration='none';button.textContent=`${i===0?'起始':'第 '+(i+1)+' 段'} · 第 ${a.page} 页`;
    button.onclick=action(async()=>{if(learning()){if(state.phase==='reference')$('reference-audio').currentTime=a.time;await navigate(a.page,{mark:false});}else{state.startAnchor=i;await navigate(a.page,{mark:false,anchor:i});}});
    const time=document.createElement('span');time.textContent=formatTime(a.time);row.append(button,time);
    if(state.draft&&i>0){const remove=document.createElement('button');remove.className='anchor-remove';remove.textContent='×';remove.ariaLabel=`删除第 ${i} 个翻页点`;remove.onclick=()=>{state.draft.anchors.splice(i,1);renderAnchors();controls();};row.append(remove);}
    list.append(row);
  });
}
function mark(page){
  const time=state.phase==='reference'?$('reference-audio').currentTime:state.frameTime;
  if(!Number.isFinite(time)||time<.25)throw new Error('先开始参考演奏，再在下一页开头标记。');
  const anchors=state.draft.anchors;
  if(anchors.some(a=>Math.abs(a.time-time)<.25))throw new Error('这个位置已有标记，请继续演奏后再翻页。');
  anchors.push({time,page});anchors.sort((a,b)=>a.time-b.time);
  toast(`已标记 ${formatTime(time)} → 第 ${page} 页`);
}
async function navigate(page,{mark:shouldMark=true,automatic=false,anchor}={}){
  if(!state.pdf||busy())return;
  page=Number(page);if(!Number.isInteger(page)||page<1||page>state.pdf.numPages)throw new Error('页码超出曲谱范围。');
  if(page===state.page&&anchor===undefined)return;
  if(performing()&&!automatic)manualTurnGuard.manual();
  if(learning()&&shouldMark)mark(page);
  if(state.phase==='following'&&!automatic){
    let target=anchor??state.reference.anchors.findIndex((a,i)=>a.page===page&&i>=state.turner.anchorIndex);
    if(target<0)target=state.reference.anchors.findIndex(a=>a.page===page);
    if(target<0){await stopSession();toast('该页尚无翻页标记，已暂停自动跟随。');}
    else {state.matcher.reset(frameAtTime(state.reference.frames,state.reference.anchors[target].time));state.turner.reset(target);state.startAnchor=target;}
  }
  const previousPage=state.page,performanceTurn=performing();
  if(performanceTurn){performanceTurning=true;$('performance-error').hidden=true;}
  state.page=page;controls();renderAnchors();
  try{await renderPages();if(!learning())savePosition(state.score.id,state.page).catch(()=>toast('页码暂时无法保存；翻页仍可使用。'));}
  catch(error){
    if(!performanceTurn)throw error;
    state.page=previousPage;controls();$('performance-error').textContent='这页未能载入，请再按一次翻页。';$('performance-error').hidden=false;
    if(state.phase==='following')await stopSession();
  }finally{if(performanceTurn){performanceTurning=false;controls();}}
}
async function releaseAudio(){
  $('reference-audio').pause();$('reference-audio').removeAttribute('src');$('reference-audio').load();
  if(state.audioURL)URL.revokeObjectURL(state.audioURL);state.audioURL=null;
}
async function stopSession(){
  state.op++;state.abort?.abort();state.abort=null;
  const mic=state.microphone;state.microphone=null;await mic?.stop();
  await wakeLock?.release().catch(()=>{});wakeLock=null;
  state.phase='idle';state.draft=null;await releaseAudio();controls();renderAnchors();ready();
}
async function learnFile(file,startTime=0){
  if(!state.pdf||state.phase!=='idle'||performing())return;
  state.phase='analyzing';const op=++state.op;state.abort=new AbortController();state.spread=false;controls();await renderPages();
  $('reference-title').textContent=file.name;status('正在学习参考声音','第一次分析需要一点时间','只在本机处理');
  try{
    const result=await analyzeAudio(file,f=>{$('reference-status').textContent=`分析 ${Math.round(f*100)}%`},state.abort.signal);
    if(op!==state.op)return;
    state.draft={featureVersion:FEATURE_VERSION,frames:result.frames,anchors:[{time:startTime,page:state.page}],duration:result.duration,sourceName:file.name,rests:[]};
    state.audioURL=URL.createObjectURL(file);$('reference-audio').src=state.audioURL;
    if(startTime>0)$('reference-audio').addEventListener('loadedmetadata',()=>{$('reference-audio').currentTime=startTime;},{once:true});
    state.phase='reference';controls();renderAnchors();status('边听参考录音，边标记翻页','播放录音，在下一页的第一个音处翻页','音频指纹已准备');
  }catch(e){if(op===state.op)await stopSession();throw e;}
}
function meter(frame){const level=Math.max(0,Math.min(1,(frame.db+60)/48));$('meter').querySelectorAll('span').forEach((s,i)=>{s.style.height=(5+level*(10+10*Math.sin(i*1.3)**2))+'px';s.style.background=frame.active?'#789c48':'#c5d1b7';});}
async function learnLive(){
  if(!state.pdf||state.phase!=='idle'||performing())return;
  state.phase='starting';state.spread=false;state.frameTime=0;const op=++state.op;controls();await renderPages();
  const mic=new Microphone();state.microphone=mic;
  state.draft={featureVersion:FEATURE_VERSION,frames:[],anchors:[{time:0,page:state.page}],duration:0,sourceName:'麦克风学习'};
  try{
    await mic.start(frame=>{
      if(state.phase!=='learning')return;state.frameTime=frame.time;meter(frame);
      if(frame.active)state.draft.frames.push(frame);
      $('reference-status').textContent=`已学习 ${formatTime(frame.time)} · ${state.draft.anchors.length-1} 个翻页点`;
      if(state.draft.frames.length>=MAX_FRAMES)action(finishLearning)();
    },()=>action(stopSession)());
    if(op!==state.op){await mic.stop();return;}
    state.phase='learning';$('reference-title').textContent='麦克风 · 学习这次演奏';controls();renderAnchors();status('正在学习，请开始弹奏','到下一页开头时手动翻页；结束后点击完成学习','仅保存音频指纹，不保存录音');
    document.querySelector('.listening-bar').classList.add('listening');
  }catch(e){await stopSession();throw e;}
}
async function finishLearning(){
  if(!learning())return;
  if(state.draft.restStart!==undefined)throw new Error('请先标记钢琴重新进入的位置，完成这段休止。');
  const start=state.draft.anchors[0].time;
  const filtered={...state.draft,frames:state.draft.frames.filter(f=>f.time>=start&&!(state.draft.rests||[]).some(r=>f.time>=r.start&&f.time<r.end))};
  const draft=validateReference(filtered,state.pdf.numPages);
  state.reference=draft;state.score.reference=draft;
  state.page=draft.anchors[0].page;state.startAnchor=0;
  await stopSession();state.phase='saving';controls();status('正在保存学习记录','请稍等片刻','保存在当前浏览器');await persist();
  state.phase='idle';controls();renderAnchors();ready();await renderPages();toast('学习完成。现在可以让翻页跟随你的演奏了。');
}
async function startFollowing(){
  if(performing())return;
  if(state.phase==='following'){await stopSession();return;}
  if(!state.reference||state.phase!=='idle')return;
  validateReference(state.reference,state.pdf.numPages);
  let start=state.startAnchor;
  if(state.reference.anchors[start]?.page!==state.page)start=state.reference.anchors.findIndex(a=>a.page===state.page);
  if(start<0)throw new Error('请从左侧选择已标记的起始页，再开始聆听。');
  state.phase='starting';const op=++state.op;controls();$('reference-audio').pause();
  state.matcher=new OnlineMatcher(state.reference.frames,frameAtTime(state.reference.frames,state.reference.anchors[start].time));
  state.turner=new TurnController(state.reference.anchors,state.reference.frames,{lead:Number($('lead-select').value)});state.turner.reset(start);
  const mic=new Microphone();state.microphone=mic;
  let automaticPending=false;
  try{
    await mic.start(frame=>{
      if(state.phase!=='following'||op!==state.op)return;meter(frame);const match=state.matcher.feed(frame);
      if(!frame.active)status('等待你的演奏','安静时保持当前页','没有检测到清楚的音乐声');
      else if(!match.stable)status('正在寻找熟悉的乐句','识别清楚后才会翻页',`匹配相似度 ${Math.round(match.confidence*100)}%`);
      else status('正在跟随你的演奏','放慢、停顿，谱页会一起等待',`参考位置 ${formatTime(state.reference.frames[match.index].time)} · 相似度 ${Math.round(match.confidence*100)}%`);
      // Do not advance the anchor while a page is rendering or a manual correction settles.
      if(automaticPending||busy()||$('performance-dialog').open||performing()&&!manualTurnGuard.permits())return;
      const turner=state.turner,revision=manualTurnGuard.revision,next=turner.observe(match);
      if(next){
        automaticPending=true;
        action(async()=>{
          try{
            if(state.phase!=='following'||op!==state.op||state.turner!==turner||performing()&&!manualTurnGuard.permits(revision))return;
            await navigate(next.page,{automatic:true,mark:false});toast(`已跟随音乐翻到第 ${next.page} 页`);
          }finally{automaticPending=false;}
        })();
      }
    },()=>action(async()=>{await stopSession();toast('麦克风连接已结束。');})());
    if(op!==state.op){await mic.stop();return;}
    state.phase='following';controls();document.querySelector('.listening-bar').classList.add('listening');status('正在聆听，请开始演奏','从当前已标记的乐句开头进入','等待音乐');
    try{wakeLock=await navigator.wakeLock?.request('screen');}catch{}
  }catch(e){await stopSession();throw e;}
}

const reader=document.querySelector('.reader');
const turnQueue=new TurnQueue({page:()=>state.page,total:()=>state.pdf?.numPages||1,step:()=>state.spread?2:1,navigate:page=>navigate(page)});
const requestTurn=action(delta=>{if(!state.pdf||!['idle','following','learning','reference'].includes(state.phase))return;return turnQueue.turn(delta);});
shell=new ReaderShell({turn:requestTurn,canTurn:()=>!!state.pdf&&['idle','following','learning','reference'].includes(state.phase),performing,writing:()=>ink.guardingTouch,zoomed:()=>state.zoom>1,settings:()=>settings.value,getZoom:()=>state.zoom,onError:error=>toast(errorMessage(error)),setZoom:async(zoom,anchor,beforePaint)=>{
  state.zoom=zoom;state.fit='screen';
  let option=$('score-zoom').querySelector('[data-custom-zoom]');
  if(!option){option=document.createElement('option');option.dataset.customZoom='true';$('score-zoom').append(option);}
  option.value=String(zoom);option.textContent=Math.round(zoom*100)+'%';$('score-zoom').value=zoom===1?'screen':String(zoom);
  await renderPages({anchor,beforePaint});
}});
document.body.append($('performance-error'));
performanceMode=new PerformanceMode({
  activate(){
    performanceSnapshot={zoom:state.zoom,inkMode:ink.mode,themeColor:document.querySelector('meta[name="theme-color"]').content};
    ink.setMode('read');state.zoom=1;$('score-zoom').value=state.fit;manualTurnGuard.manual();
    $('reference-audio').pause();clearTimeout(toastTimer);$('toast').hidden=true;$('performance-error').hidden=true;
    document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
    document.body.classList.add('performance-mode');
    document.documentElement.classList.add('performance-active');document.querySelector('meta[name="theme-color"]').content='#10151d';readerViewport.refresh();
    shell.close();
    controls();$('score-stage').focus({preventScroll:true});
  },
  deactivate(){
    document.body.classList.remove('performance-mode');
    document.documentElement.classList.remove('performance-active');document.querySelector('meta[name="theme-color"]').content=performanceSnapshot?.themeColor||'#1e4c92';readerViewport.refresh();
    state.zoom=performanceSnapshot?.zoom||1;$('score-zoom').value=state.zoom===1?state.fit:String(state.zoom);ink.setMode(performanceSnapshot?.inkMode||'read');
    $('performance-error').hidden=true;controls();shell.open('tools');
  },
  render:async()=>{performanceTurning=true;controls();try{await renderPages();}finally{performanceTurning=false;controls();}},
  stopFollowing:()=>state.phase==='following'?stopSession():undefined,
  fullscreen:()=>settings.value.fullscreen?requestScoreFullscreen():false,
  exitFullscreen:leaveScoreFullscreen,
  wakeLock:()=>document.hidden?undefined:navigator.wakeLock?.request('screen'),
});
$('performance-open').onclick=()=>{if(!canPerform())return;$('performance-setup-status').classList.remove('error');controls();$('performance-dialog').showModal();};
$('performance-listen').onclick=async()=>{
  if(!canPerform()||!state.reference)return;
  $('performance-setup-status').classList.remove('error');
  try{await startFollowing();}catch(error){$('performance-setup-status').classList.add('error');$('performance-setup-status').textContent=`${errorMessage(error)} 仍可进入演出并手动翻页。`;}
};
$('performance-begin').onclick=()=>{if(!canPerform())return;performanceMode.enter().catch(e=>toast(errorMessage(e)));};
$('performance-exit').onclick=action(()=>performanceMode.exit());
for(const event of ['fullscreenchange','webkitfullscreenchange'])document.addEventListener(event,()=>{
  if(!performing())return;
  if(fullscreenElement())performanceMode.native=true;
  else if(performanceMode.native)action(()=>performanceMode.exit())();
});
$('score-stage').addEventListener('contextmenu',e=>{if(performing())e.preventDefault();});

for(const id of ['import-button','empty-import','imslp-upload'])$(id).onclick=()=>{if(performing())return;$('imslp-dialog').close();$('pdf-input').click();};
$('pdf-input').onchange=action(async e=>{const file=e.target.files[0];e.target.value='';if(file)await openPDF(await file.arrayBuffer(),file.name);});
$('audio-button').onclick=()=>$('audio-input').click();$('audio-input').onchange=action(async e=>{const file=e.target.files[0];e.target.value='';if(file)await learnFile(file);});
$('help-button').onclick=()=>$('help-dialog').showModal();$('imslp-button').onclick=()=>$('imslp-dialog').showModal();
document.querySelectorAll('.dialog-close,.dialog-done').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('prev-button').onclick=()=>requestTurn(-1);
$('next-button').onclick=()=>requestTurn(1);
$('page-input').onchange=action(()=>navigate(Number($('page-input').value)));
// Dragging shows the page you are heading for; the turn happens when you let go.
$('page-range').oninput=()=>{$('page-input').value=$('page-range').value;$('page-label').textContent=`PDF 第 ${$('page-range').value} 页`;};
$('page-range').onchange=action(()=>navigate(Number($('page-range').value)));
$('single-button').onclick=action(async()=>{state.spread=false;controls();await renderPages();});
$('spread-button').onclick=action(async()=>{state.spread=true;controls();await renderPages();});
$('score-zoom').onchange=action(async e=>{const value=e.target.value;state.zoom=['screen','page'].includes(value)?1:Number(value);if(['screen','page'].includes(value))state.fit=value;await renderPages();});
$('reading-position-reset').onclick=action(()=>readingPosition.reset());
$('fullscreen-button').onclick=async()=>{if(fullscreenElement())await leaveScoreFullscreen();else if(!await requestScoreFullscreen())toast('此浏览器未提供全屏。iPad 可通过 Safari“添加到主屏幕”减少浏览器栏。');shell.close();};
$('learn-button').onclick=action(learnLive);$('finish-button').onclick=action(finishLearning);$('cancel-button').onclick=action(stopSession);$('listen-button').onclick=action(startFollowing);$('mark-button').onclick=action(()=>navigate(state.page+1));
$('lead-select').onchange=()=>{if(state.turner)state.turner.lead=Number($('lead-select').value);};
$('set-start-button').onclick=action(()=>{
  if(state.phase!=='reference')return;const time=$('reference-audio').currentTime;
  state.draft.anchors=[{time,page:state.page},...state.draft.anchors.filter(a=>a.time>time+.25)];
  renderAnchors();controls();toast(`从 ${formatTime(time)}、第 ${state.page} 页开始练习`);
});
$('rest-button').onclick=action(()=>{
  if(state.phase!=='reference')return;const time=$('reference-audio').currentTime;
  if(state.draft.restStart===undefined){state.draft.restStart=time;toast('休止开始已标记。把录音移到钢琴重新进入处，再点一次。');}
  else{if(time<=state.draft.restStart+.2)throw new Error('重新进入必须晚于休止开始。');
    if(state.draft.anchors.some(a=>a.time>state.draft.restStart&&a.time<time))throw new Error('休止中已有翻页点，请先删除或移动该翻页点。');
    state.draft.rests.push({start:state.draft.restStart,end:time});delete state.draft.restStart;toast('这段纯乐队声音将从跟谱参考中排除。');}
  controls();
});
$('url-import').onclick=action(async()=>{
  const url=new URL($('pdf-url').value);if(url.protocol!=='https:'&&url.protocol!=='http:')throw new Error('请输入 HTTP 或 HTTPS PDF 链接。');
  if(/imslp\.org$/.test(url.hostname)&&!url.pathname.toLowerCase().endsWith('.pdf'))throw new Error('这是 IMSLP 页面。请在原网站下载 PDF，再从本机导入。');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{const response=await fetch(url,{credentials:'omit',signal:controller.signal});if(!response.ok)throw new Error('无法读取 PDF');const data=await response.arrayBuffer();await openPDF(data,decodeURIComponent(url.pathname.split('/').pop())||'IMSLP 曲谱');$('imslp-dialog').close();}
  catch{throw new Error('这个网站不允许直接读取，请打开原链接下载 PDF，再导入文件。');}finally{clearTimeout(timer);}
});
$('demo-button').onclick=action(async()=>{
  const response=await fetch('./local/chopin.pdf');
  if(!response.ok)throw new Error('肖邦示例在本机版本中可用。这里请导入你下载的肖邦第二钢协 PDF。');
  await openPDF(await response.arrayBuffer(),'肖邦 · 第二钢琴协奏曲 / I. Maestoso');
  if(!state.reference)await navigate(3,{mark:false});
  toast('第一乐章共 16 页，钢琴独奏从 PDF 第 3 页进入。');
  if(!document.getElementById('chopin-audio')){
    const b=document.createElement('button');b.id='chopin-audio';b.className='secondary full';b.textContent='载入第一乐章参考录音';
    b.onclick=action(async()=>{if(state.phase!=='idle')return;const response=await fetch('./local/chopin.mp3');if(!response.ok)throw new Error('本机参考录音不可用，请导入自己的录音。');await learnFile(new File([await response.blob()],'Chopin Op.21 · I. Maestoso.mp3',{type:'audio/mpeg'}),state.page===3?147.24:0);});
    $('score-card').append(b);
  }
});
document.addEventListener('keydown',e=>{
  if(performing()){
    if(e.target.matches('input,select,textarea')||document.querySelector('dialog[open]'))return;
    const intent=performanceKey(e);
    if(intent===null)return;
    e.preventDefault();
    if(intent==='exit')action(()=>performanceMode.exit())();
    else if(intent!=='ignore')requestTurn(intent);
    return;
  }
  action(async()=>{
  if(e.key==='Escape'&&['following','learning','starting'].includes(state.phase)){await stopSession();return;}
  if(e.target.matches('input,select,textarea')||document.querySelector('dialog[open]'))return;
  if(e.key==='ArrowRight'&&state.pdf&&!e.repeat){e.preventDefault();await requestTurn(1);}
  if(e.key==='ArrowLeft'&&state.pdf&&!e.repeat){e.preventDefault();await requestTurn(-1);}
  })();
});
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>action(renderPages)(),250);});
new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>action(renderPages)(),200);}).observe($('score-stage'));
window.addEventListener('pagehide',()=>{state.microphone?.stop();state.abort?.abort();performanceMode.suspend();});
document.addEventListener('visibilitychange',()=>{
  if(performing()){if(document.hidden)performanceMode.suspend();else performanceMode.resume();}
  if(document.hidden&&state.phase==='following')action(async()=>{await stopSession();toast('页面切到后台，聆听已暂停。');})();
});

function readState(){return {title:state.score?.name||null,page:state.page,pages:state.pdf?.numPages||0,phase:state.phase,learned:!!state.reference&&state.phase!=='saving',anchors:state.reference?.anchors.map(a=>({time:a.time,page:a.page}))||[]};}
if(document.modelContext?.registerTool){
  const lifecycle=new AbortController();
  const register=(tool)=>Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});
  register({name:'read_score_state',description:'Read current PDF page, learning state, and saved page-turn anchors.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:readState});
  register({name:'navigate_score_page',description:'Navigate to a PDF page in idle viewing mode. Does not start microphone or mark learning data.',inputSchema:{type:'object',properties:{page:{type:'integer',minimum:1}},required:['page'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:async input=>{if(!state.pdf||state.phase!=='idle'||!input||!Number.isInteger(input.page)||input.page<1||input.page>state.pdf.numPages)throw new Error('Open a score in idle viewing mode and provide a valid page.');await navigate(input.page,{mark:false});return readState();}});
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
controls();ready();
library=setupLibrary(openPDF,toast,()=>state.phase==='idle'&&!performing(),()=>state.score,offlineScore);
midi=setupMIDI({
  sources:()=>library?.item(state.score?.id)?.sources||[],
  // A folder on this device answers first; otherwise the private route serves it.
  url:name=>{
    if(!state.score||!name)return null;
    return library?.local?.sourceURL(state.score.id,name)
      ||new URL('./sources/'+state.score.id+'/'+encodeURIComponent(name),import.meta.url).href;
  },
  toast,
});
inkFolder=setupInkFolder({ink,library,toast,canRun:()=>state.phase==='idle'&&!performing(),drain:drainInk,showMerged});
  const localFolder=setupLocalFolder({toast,onLibrary:async source=>{await library?.useLocal(source);await inkFolder?.onFolder();emptyState();}});
  const localRestore=localFolder?.restore?.()||Promise.resolve(null);
// The first thing a reader sees should be the thing that fills the shelf. Once it is filled,
// the same place becomes the way back into it.
function emptyState(){
  const connected=!!library?.local;
  $('empty-folder').textContent=connected?'打开曲谱库':'选择曲谱文件夹';
  $('empty-folder').append(Object.assign(document.createElement('span'),{ariaHidden:'true',textContent:' ↗'}));
  $('empty-hint').hidden=connected;
}
$('empty-folder').onclick=()=>{
  if(performing())return;
  if(library?.local)$('library-button').click();else localFolder?.choose();
};
emptyState();
inkFolder?.describe();
// Markings are written back at the moments a reader would expect them to be safe: when the
// score is put down, and when the app goes away.
addEventListener('pagehide',()=>{inkFolder?.save({quiet:true}).catch(()=>{});});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')inkFolder?.save({quiet:true}).catch(()=>{});});
bookmarks=setupBookmarks({
  score:()=>state.score,page:()=>state.page,
  canJump:()=>!!state.pdf&&['idle','following','learning','reference'].includes(state.phase),
  jump:page=>{shell?.close();navigate(page).catch(error=>toast(errorMessage(error)));},
  toast,
});
recent=setupRecentScores({
  canOpen:()=>state.phase==='idle'&&!performing(),
  open:async id=>{
    const saved=await loadScore(id),item=recent?.items.find(entry=>entry.id===id);
    if(saved?.buffer){await openPDF(saved.buffer,saved.name,saved);return;}
    if(library?.local?.needsFolder)await library.local.reopen?.();
    const local=library?.local?.url?.(id)||library?.local?.pathURL?.(item?.path);
    if(local){await openPDF({id,url:local,path:item?.path||library.local.path?.(id),local:true},item?.name||saved?.name||'未命名曲谱',saved||null);return;}
    const offlineCopy=await offlineScore(id);
    if(offlineCopy){const restored={...saved,...offlineCopy,remote:offlineCopy.remote};await openPDF(restored.remote,restored.name,restored);return;}
    throw new Error('这份曲谱尚未在当前本地数据库中找到，请重新选择数据库后再试。');
  },
  onError:error=>toast(errorMessage(error)),
});
offline=setupOffline(()=>state.score,openPDF,toast,()=>settings.value);
const deploy=setupDeploy({toast,onDone:()=>offline?.refresh(),local:()=>library?.local});
$('offline-deploy').onclick=()=>deploy?.open();
setupAnnotationBackup(ink,toast,()=>state.phase==='idle'&&!performing());
$('account-note').textContent='本机阅谱 · 曲谱来自你选的文件夹，批注保存在本机';
// Nothing to sign in to: the reader opens straight into whatever this device already holds.
(async()=>{
  const query=new URLSearchParams(location.search);
  // Library entry is a recovery route: do not reopen a heavy last PDF first.
  if(query.get('library')==='1'){$('library-button').click();return;}
  await localRestore.catch(()=>null);
  const saved=await loadScore();
  if(saved?.system){try{await openPDF(VERSION_UPDATE,VERSION_UPDATE.name,saved);}catch{toast('版本说明页暂时无法打开。');}}
  else if(saved?.buffer){try{await openPDF(saved.buffer,saved.name,saved);}catch{toast('上次曲谱无法恢复，请从本地曲谱库重新打开。');}}
  else if(saved&&library?.local&&!library.local.needsFolder){
    const local=library.local.url?.(saved.id)||library.local.pathURL?.(saved.path);
    if(local){try{await openPDF({id:saved.id,url:local,path:saved.path||library.local.path?.(saved.id),local:true},saved.name,saved);}catch{toast('上次曲谱无法恢复，请从本地曲谱库重新打开。');}}
    else await openPDF(VERSION_UPDATE,VERSION_UPDATE.name,null).catch(()=>{});
  }else await openPDF(VERSION_UPDATE,VERSION_UPDATE.name,null).catch(()=>{});
  if(query.get('piece')==='chopin'&&['localhost','127.0.0.1'].includes(location.hostname))$('demo-button').click();
})().catch(()=>toast('本机曲谱未能恢复，可从曲谱库重新打开；批注仍保留。'));
$('demo-button').onclick=()=>$('library-button').click();
const buildVersion=$('build-version');if(buildVersion)buildVersion.textContent=`版本时间：${BUILD_INFO.label}`;
