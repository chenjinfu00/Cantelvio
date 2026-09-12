import * as pdfjs from './vendor/pdf.mjs';
import {analyzeAudio,Microphone} from './audio.js';
import {OnlineMatcher,TurnController,frameAtTime,validateReference,FEATURE_VERSION,MAX_FRAMES} from './matcher.js';
import {scoreID,saveScore,loadScore} from './storage.js';
import {setupLibrary} from './library.js';
import {Ink} from './ink.js';
import {loadPDFDocument} from './pdf-document.js';
import {PerformanceMode,performanceKey,ManualTurnGuard} from './performance-mode.js';
import {PUBLIC_LIBRARY} from './site-config.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs',import.meta.url).href;
const $ = id => document.getElementById(id);
const state={score:null,pdf:null,page:1,spread:false,phase:'idle',draft:null,reference:null,microphone:null,matcher:null,turner:null,renderId:0,audioURL:null,abort:null,startAnchor:0,frameTime:0,op:0,zoom:1};
const ink=new Ink(toast);
let toastTimer,wakeLock,resizeTimer,library,performanceMode,performanceSnapshot,performanceTurning=false;
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
  $('ink-toolbar').hidden=!loaded;
  for(const id of ['ink-pen','ink-erase','ink-undo','ink-redo','score-zoom'])$(id).disabled=!loaded||state.phase!=='idle';
  if(state.phase!=='idle'&&ink.mode!=='read')ink.setMode('read');
  for(const id of ['import-button','empty-import','demo-button','url-import'])$(id).disabled=locked||learning()||state.phase==='following';
  $('audio-button').disabled=!loaded||state.phase!=='idle';$('learn-button').disabled=!loaded||state.phase!=='idle';
  $('prev-button').disabled=!loaded||state.page===1||locked;$('next-button').disabled=!loaded||state.page>=state.pdf.numPages||locked;
  $('page-input').disabled=!loaded||locked;$('page-input').value=state.page;
  $('page-count').textContent=loaded?`/ ${state.pdf.numPages}`:'/ —';
  $('page-label').textContent=loaded?`PDF 第 ${state.page}${state.spread&&state.page<state.pdf.numPages?'–'+(state.page+1):''} 页`:'等待导入';
  $('listen-button').disabled=state.phase!=='following'&&(state.phase!=='idle'||!state.reference);
  $('listen-button').textContent=state.phase==='following'?'停止聆听':'开始聆听 ↗';
  $('finish-button').disabled=!learning();$('mark-button').disabled=!learning()||state.page>=state.pdf?.numPages;
  $('mark-page').textContent=state.page+1;
  $('spread-button').disabled=learning()||locked;
  $('single-button').classList.toggle('selected',!state.spread);$('single-button').setAttribute('aria-pressed',String(!state.spread));
  $('spread-button').classList.toggle('selected',state.spread);$('spread-button').setAttribute('aria-pressed',String(state.spread));
  $('reference-panel').hidden=!learning()&&state.phase!=='analyzing';
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
  try{
    const id=remote?.id||await scoreID(buffer),saved=restored||await loadScore(id).catch(()=>null);
    const source=remote?{url:remote.url,withCredentials:true,disableAutoFetch:true,disableStream:true,rangeChunkSize:262144}:{data:new Uint8Array(buffer.slice(0))};
    onProgress?.('正在读取曲谱…');
    const pdf=await loadPDFDocument(pdfjs.getDocument,{...source,cMapUrl:new URL('./vendor/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/wasm/',import.meta.url).href,isEvalSupported:false},state.pdf,({loaded,total})=>{
      onProgress?.(total?`正在读取曲谱 ${Math.min(100,Math.round(loaded/total*100))}%…`:'正在读取曲谱…');
    });
    $('chopin-audio')?.remove();
    state.pdf=pdf;state.score=remote?{id,name,remote}:{id,name,buffer};state.reference=null;state.draft=null;state.startAnchor=0;state.zoom=1;$('score-zoom').value='1';ink.setScore(id);
    if(saved?.reference){try{state.reference=validateReference(saved.reference,pdf.numPages);}catch{toast('旧的学习记录需要重新建立；PDF 已恢复。');}}
    state.page=Math.max(1,Math.min(pdf.numPages,saved?.page||1));
    $('score-title').textContent=name.replace(/\.pdf$/i,'');$('score-meta').textContent=`${pdf.numPages} 页 · ${remote?'曲谱库 · 按需读取':'本机导入'} · 批注独立保存`;
    $('empty-state').hidden=true;$('pages').hidden=false;
    onProgress?.('正在显示谱页…');
    controls();renderAnchors();ready();await renderPages();await persist();library?.setCurrent(state.score);
  }finally{state.phase=oldPhase;$('render-status').hidden=true;controls();}
}
async function renderPages(){
  if(!state.pdf)return;
  const version=++state.renderId,pdf=state.pdf,page=state.page;
  $('render-status').hidden=false;
  const container=document.createDocumentFragment();
  try{
    const numbers=[page];if(state.spread&&page<pdf.numPages)numbers.push(page+1);
    const available=Math.max(120,$('score-stage').clientWidth-(performing()?20:50)),width=(available-(numbers.length-1)*20)/numbers.length;
    for(const number of numbers){
      const p=await pdf.getPage(number),natural=p.getViewport({scale:1});
      const availableHeight=Math.max(100,$('score-stage').clientHeight-(performing()?20:38));
      const cssWidth=Math.min(width,performing()?Infinity:780,availableHeight*natural.width/natural.height)*state.zoom,density=Math.min(window.devicePixelRatio||1,2),viewport=p.getViewport({scale:cssWidth/natural.width*density});
      const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);canvas.style.width=cssWidth+'px';canvas.setAttribute('aria-label',`PDF 第 ${number} 页`);
      await p.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      const sheet=document.createElement('div');sheet.className='sheet';sheet.dataset.page=String(number);sheet.style.width=cssWidth+'px';sheet.append(canvas);container.append(sheet);
    }
    if(version!==state.renderId)return;
    ink.clearViews();$('pages').replaceChildren(container);$('score-stage').scrollTop=0;ink.page=page;
    $('pages').classList.toggle('zoomed',state.zoom>1);$('score-stage').classList.toggle('zoomed',state.zoom>1);
    for(const sheet of $('pages').children){if(version!==state.renderId)return;await ink.attach(sheet,Number(sheet.dataset.page));}
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
  try{await renderPages();if(!learning())await persist();}
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
performanceMode=new PerformanceMode({
  activate(){
    performanceSnapshot={zoom:state.zoom,inkMode:ink.mode,inert:[]};
    ink.setMode('read');state.zoom=1;$('score-zoom').value='1';manualTurnGuard.manual();
    $('reference-audio').pause();clearTimeout(toastTimer);$('toast').hidden=true;$('performance-error').hidden=true;
    document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
    document.body.classList.add('performance-mode');
    for(const node of document.querySelectorAll('.topbar,.sidebar,.reader-toolbar,#edition-toolbar,#ink-toolbar,#reference-panel,.listening-bar,.reader-footer')){performanceSnapshot.inert.push([node,node.inert]);node.inert=true;}
    controls();$('score-stage').focus({preventScroll:true});
  },
  deactivate(){
    document.body.classList.remove('performance-mode');
    for(const [node,inert] of performanceSnapshot?.inert||[])node.inert=inert;
    state.zoom=performanceSnapshot?.zoom||1;$('score-zoom').value=String(state.zoom);ink.setMode(performanceSnapshot?.inkMode||'read');
    $('performance-error').hidden=true;controls();$('performance-open').focus({preventScroll:true});
  },
  render:async()=>{performanceTurning=true;controls();try{await renderPages();}finally{performanceTurning=false;controls();}},
  stopFollowing:()=>state.phase==='following'?stopSession():undefined,
  fullscreen:()=>document.fullscreenElement===reader?true:reader.requestFullscreen?.().then(()=>true),
  exitFullscreen:()=>document.fullscreenElement===reader?document.exitFullscreen():undefined,
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
document.addEventListener('fullscreenchange',()=>{
  if(!performing())return;
  if(document.fullscreenElement===reader)performanceMode.native=true;
  else if(performanceMode.native)action(()=>performanceMode.exit())();
});
$('score-stage').addEventListener('contextmenu',e=>{if(performing())e.preventDefault();});

for(const id of ['import-button','empty-import','imslp-upload'])$(id).onclick=()=>{if(performing())return;$('imslp-dialog').close();$('pdf-input').click();};
$('pdf-input').onchange=action(async e=>{const file=e.target.files[0];e.target.value='';if(file)await openPDF(await file.arrayBuffer(),file.name);});
$('audio-button').onclick=()=>$('audio-input').click();$('audio-input').onchange=action(async e=>{const file=e.target.files[0];e.target.value='';if(file)await learnFile(file);});
$('help-button').onclick=()=>$('help-dialog').showModal();$('imslp-button').onclick=()=>$('imslp-dialog').showModal();
document.querySelectorAll('.dialog-close,.dialog-done').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('prev-button').onclick=action(()=>navigate(Math.max(1,state.page-(state.spread?2:1))));
$('next-button').onclick=action(()=>navigate(Math.min(state.pdf.numPages,state.page+(state.spread?2:1))));
$('page-input').onchange=action(()=>navigate(Number($('page-input').value)));
$('single-button').onclick=action(async()=>{state.spread=false;controls();await renderPages();});
$('spread-button').onclick=action(async()=>{state.spread=true;controls();await renderPages();});
$('score-zoom').onchange=action(async e=>{state.zoom=Number(e.target.value);await renderPages();});
$('fullscreen-button').onclick=action(async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await document.querySelector('.reader').requestFullscreen();});
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
    const intent=performanceKey(e);
    if(intent===null)return;
    e.preventDefault();
    if(intent==='exit')action(()=>performanceMode.exit())();
    else if(intent!=='ignore')action(()=>navigate(Math.max(1,Math.min(state.pdf.numPages,state.page+intent*(state.spread?2:1))),{mark:false}))();
    return;
  }
  action(async()=>{
  if(e.key==='Escape'&&['following','learning','starting'].includes(state.phase)){await stopSession();return;}
  if(e.target.matches('input,select,textarea')||document.querySelector('dialog[open]'))return;
  if(e.key==='ArrowRight'&&state.pdf&&!busy()){e.preventDefault();await navigate(Math.min(state.pdf.numPages,state.page+(state.spread?2:1)));}
  if(e.key==='ArrowLeft'&&state.pdf&&!busy()){e.preventDefault();await navigate(Math.max(1,state.page-(state.spread?2:1)));}
  })();
});
let touchX=null;$('score-stage').addEventListener('touchstart',e=>{if(ink.mode!=='read'||state.zoom>1){touchX=null;return;}touchX=e.touches[0].clientX;},{passive:true});
$('score-stage').addEventListener('touchend',action(async e=>{if(touchX===null||!state.pdf)return;const delta=e.changedTouches[0].clientX-touchX;touchX=null;if(Math.abs(delta)>80)await navigate(Math.min(state.pdf.numPages,Math.max(1,state.page+(delta<0?1:-1)*(state.spread?2:1))));}),{passive:true});
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
library=setupLibrary(openPDF,toast,()=>state.phase==='idle'&&!performing(),()=>state.score);
if(PUBLIC_LIBRARY)$('account-note').textContent='公开试用 · 批注保存在本机';
else if(['localhost','127.0.0.1'].includes(location.hostname))$('account-note').textContent='本机开发版 · 曲谱与批注尚未上线';
loadScore().then(saved=>saved&&openPDF(saved.buffer||saved.remote,saved.name,saved)).catch(()=>toast('本机曲谱未能恢复，请重新导入。')).finally(()=>{const query=new URLSearchParams(location.search);if(query.get('piece')==='chopin'&&['localhost','127.0.0.1'].includes(location.hostname))$('demo-button').click();if(query.get('library')==='1')$('library-button').click();});
if(PUBLIC_LIBRARY||!['localhost','127.0.0.1'].includes(location.hostname)){$('demo-button').textContent=PUBLIC_LIBRARY?'打开曲谱库':'打开曲谱库';$('demo-button').onclick=()=>$('library-button').click();}
