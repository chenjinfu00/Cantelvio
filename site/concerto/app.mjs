import {parseMidi,splitScore} from './midi.mjs';
import {Transport,restoreState} from './transport.mjs';
import {BrowserFollower} from './follower.mjs';
import {OrchestraSynth,LiveMic} from './audio.mjs';
import {demoMidi} from './demo.mjs';
import {SCORE_BASIS,loadScoreMap,scoreStart} from './alignment.mjs?v=20261018-score-1';
import {SessionStore,snapshot,settings,WORK_ID} from './session.mjs?v=20261018-score-1';
import {decodePreset,loadPublishedPreset,digest,CHOPIN_MIDI_SHA} from './preset.mjs?v=20261018-score-1';
const $=id=>document.getElementById(id);
const t=(zh,en)=>document.documentElement.lang.startsWith('zh')?zh:en;
let midi=null,soloMidi=null,transport=null,follower=null,synth=null,mic=null,timer=null,run=0,starting=false,loading=false,fileGeneration=0,sourceLabel='',demo=false;
let pdf=null,pdfTask=null,pdfRender=null,pdfGeneration=0,renderGeneration=0,page=1;
const store=new SessionStore();
let files={midi:null,solo:null,pdf:null},restoring=true,workRevision=0,saveTimer=null,presetAbort=null;
const message=(text,error=false)=>{$('message').textContent=text;$('message').classList.toggle('error',error);};
const savedStatus=(zh,en)=>{$('saved-status').textContent=t(zh,en);};
const selected=()=>Array.from($('track-list').querySelectorAll('input:checked'),e=>Number(e.value));
const split=()=>{const result=splitScore(midi,selected());if(soloMidi){result.solo=soloMidi.tracks.flatMap(t=>t.intervals).sort((a,b)=>a.beat-b.beat);result.phrases=splitScore(soloMidi,soloMidi.tracks.map(t=>t.id)).phrases;}return result;};
function controls() {
  const busy=starting || transport?.playing || restoring;
  for(const input of document.querySelectorAll('.setup input:not(#rate):not(#volume),.setup select,.setup button'))input.disabled=!!busy;
  $('tracks').disabled=!midi || !!busy;$('pdf').disabled=restoring;
  $('start').disabled=!!busy || loading || !midi || !$('confirmed').checked;
  $('release').disabled=!transport?.playing || !follower;
  $('mic-settings').hidden=$('mode').value!=='follow';
}
async function readMidi(blob,align=true){
  const bytes=await blob.arrayBuffer(),parsed=parseMidi(bytes);
  if(align && await digest(bytes)===CHOPIN_MIDI_SHA)parsed.scoreMap=await loadScoreMap(CHOPIN_MIDI_SHA);
  return parsed;
}
function localText(id,zh,en){const e=$(id);e.dataset.zh=zh;e.dataset.en=en;e.textContent=t(zh,en);}
function positionText(beat){
  const p=(midi.scoreMap || midi.meter).atBeat(beat);
  if(p.preparing)return t('准备 · 开头弱起','Ready · opening pickup');
  if(p.complete)return t('第348小节 · 乐章结束','Bar 348 · movement end');
  if(p.freeTime)return t(`第 ${p.measure} 小节 · 延长／华彩`,`Bar ${p.measure} · fermata / cadenza`);
  if(p.pickup)return t(`弱起 · ${p.beat.toFixed(2)} 拍`,`Pickup · beat ${p.beat.toFixed(2)}`);
  const count=(Math.floor((p.beat+1e-8)*10)/10).toFixed(1);
  return midi.scoreMap?t(`第 ${p.measure} 小节 · ${count} 拍`,`Bar ${p.measure} · beat ${count}`):t(`MIDI格 ${p.measure} · ${count} 拍`,`MIDI grid ${p.measure} · beat ${count}`);
}
function startBeat(){return (midi.scoreMap || midi.meter).atMeasure(Number($('measure').value));}
function showTracks() {
  $('track-list').replaceChildren();
  for(const track of midi.tracks.filter(t=>t.notes)) {
    const label=document.createElement('label');label.className='check';const check=document.createElement('input');check.type='checkbox';check.value=track.id;
    check.checked=/pianoforte|solo.*piano|piano.*solo/i.test(track.name);
    const text=document.createElement('span');text.textContent=`${track.id+1}. ${track.name} · ${track.notes} ${t('音','notes')}`;
    label.append(check,text);$('track-list').append(label);check.addEventListener('change',()=>{$('confirmed').checked=false;controls();queueSave();});
  }
  const map=midi.scoreMap;
  $('midi-info').textContent=map?`${sourceLabel} · ${midi.tracks.length} ${t('轨','tracks')} · 348 ${t('原谱完整小节 + 弱起','score bars + pickup')}`:`${sourceLabel} · ${midi.tracks.length} ${t('轨','tracks')} · ${midi.meter.atBeat(Math.max(0,midi.endBeat-.001)).measure} ${t('MIDI 时间格（非原谱编号）','MIDI grids (not score numbering)')}`;
  $('confirmed').checked=false;$('measure').min=map?0:1;$('measure').value=map?0:1;$('measure').max=map?348:midi.meter.atBeat(midi.endBeat).measure;
  localText('start-label',map?'开始位置（原谱小节；0 = 开头弱起）':'开始位置（MIDI 时间格，非原谱小节）',map?'Start at score bar (0 = opening pickup)':'Start at MIDI grid (not score bars)');
  localText('entry-hint',map?'0 从开头弱起开始；1 从首个完整小节开始。原谱第71小节钢琴进入；拍数按四分音符计。':'此文件未与原谱对齐，显示文件自身的 MIDI 时间格。',map?'0 includes the pickup; 1 starts at the first complete bar. Piano enters in score bar 71. Beats count quarter notes.':'This file has no score alignment; positions use its own MIDI grid.');
  $('position').textContent=positionText(startBeat());$('state').textContent=t('已载入 · 核对独奏轨后开始','Loaded · check solo tracks before starting');controls();
}
async function loadMidi(file,reference=false) {
  if(!file)return;
  ++workRevision;const id=++fileGeneration;loading=true;controls();
  try {
    if(file.size>20*1024*1024)throw Error(t('MIDI 文件需小于 20 MB','MIDI must be under 20 MB'));
    const parsed=await readMidi(file,!reference),known=!!parsed.scoreMap;if(id!==fileGeneration)return;
    if(reference){soloMidi=parsed;files.solo={name:file.name,blob:file};$('solo-info').textContent=`${file.name} · ${parsed.tracks.reduce((s,t)=>s+t.notes,0)} ${t('音（仅参考，不发声）','notes (silent reference)')}`;}
    else {await stop(false);if(id!==fileGeneration)return;midi=parsed;soloMidi=null;files.midi={name:file.name,blob:file};files.solo=null;$('solo').value='';$('solo-info').textContent='';sourceLabel=file.name;demo=false;showTracks();if(known){$('confirmed').checked=true;applySettings({positionBasis:SCORE_BASIS,measure:0,rate:94,volume:$('volume').value,mode:'fixed',speaker:true});}}
    await saveNow();
    message(known?t('肖邦第一乐章已识别：独奏轨已静音，可直接开始。','Chopin movement I recognised: solo track muted, ready to start.'):t('文件已在浏览器载入并记住。请核对独奏轨与开始位置。','Files loaded and remembered in this browser. Check solo tracks and starting bar.'));
  }catch(e){if(id===fileGeneration)message(e.message,true);}finally{if(id===fileGeneration){loading=false;controls();}}
}
function currentSettings(){return settings({positionBasis:midi?.scoreMap?SCORE_BASIS:'midi',measure:$('measure').value,rate:$('rate').value,volume:$('volume').value,mode:$('mode').value,speaker:$('speaker').checked,deviceId:$('device').value});}
function applySettings(value){const clean=scoreStart(settings(value),midi?.scoreMap,midi?.meter);for(const id of ['measure','rate','volume','mode'])$(id).value=clean[id];$('speaker').checked=clean.speaker;if(clean.deviceId && !$('device').querySelector(`option[value="${CSS.escape(clean.deviceId)}"]`))$('device').add(new Option(t('上次使用的麦克风','Previously selected microphone'),clean.deviceId));$('device').value=clean.deviceId;for(const id of ['rate','volume'])$(id+'-label').textContent=$(id).value+'%';if(midi)$('position').textContent=positionText(startBeat());}
async function saveNow(){
  if(restoring || demo || !files.midi && !files.pdf)return;
  const revision=workRevision;
  try{await store.save({version:1,workId:WORK_ID,...files,soloTrackIds:selected(),confirmed:$('confirmed').checked,settings:currentSettings(),page});if(revision===workRevision)savedStatus('已保存在此浏览器 · 下次打开自动恢复','Saved in this browser · automatically restored next time');}
  catch(e){if(revision===workRevision)savedStatus('当前可用，但无法记住更改；下次将载入默认配置','Usable now, but changes cannot be saved; defaults load next time');}
}
function queueSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;saveNow();},250);}
async function applyConfiguration(value,revision){
  const clean=snapshot(value),parsed=clean.midi?await readMidi(clean.midi.blob):null,solo=clean.solo?parseMidi(await clean.solo.blob.arrayBuffer()):null;
  if(revision!==workRevision)return false;
  await stop(false);if(revision!==workRevision)return false;
  files={midi:clean.midi,solo:clean.solo,pdf:clean.pdf};midi=parsed;soloMidi=solo;demo=false;sourceLabel=clean.midi?.name||'';
  if(midi){showTracks();const valid=new Set(midi.tracks.filter(t=>t.notes).map(t=>t.id));for(const check of $('track-list').querySelectorAll('input'))check.checked=clean.soloTrackIds.includes(Number(check.value));$('confirmed').checked=clean.confirmed && clean.soloTrackIds.every(id=>valid.has(id));}
  $('solo-info').textContent=clean.solo?`${clean.solo.name} · ${t('已恢复静音参考','Silent reference restored')}`:'';
  applySettings(clean.settings);
  const pdfReady=!clean.pdf || await loadPDF(clean.pdf,clean.page,false);
  if(revision!==workRevision)return false;
  if(!pdfReady)throw Error('曲谱未完成载入，请恢复默认配置重试 / PDF did not load; restore defaults to retry');
  $('materials-details').open=!(midi && $('confirmed').checked);
  $('state').textContent=midi && $('confirmed').checked?t('已配置 · 可以开始','Configured · ready to start'):t('已恢复演奏文件','Performance files restored');
  return true;
}
async function restoreConfiguration(defaults=false){
  const revision=workRevision;restoring=true;presetAbort?.abort();const request=presetAbort=new AbortController();
  controls();savedStatus('正在准备肖邦第一乐章…','Preparing Chopin movement I…');
  try{
    let restored=false;
    if(!defaults){try{const clean=await store.load();if(revision!==workRevision)return;if(clean)restored=await applyConfiguration(clean,revision);}catch{/* A missing or damaged browser copy falls back to the published work. */}}
    if(revision!==workRevision)return;
    if(!restored){
      savedStatus('正在下载完整 MIDI 和双钢琴曲谱，首次约 15 MB…','Downloading complete MIDI and two-piano score, about 15 MB on first use…');
      const clean=await loadPublishedPreset({signal:request.signal});if(revision!==workRevision)return;
      if(!await applyConfiguration(clean,revision))return;
      restoring=false;await saveNow();
    }else savedStatus('已恢复您的配置 · 无需再次选择文件','Your settings restored · no file selection needed');
    if(revision===workRevision)message(t('曲目与设置已就绪，点击「开始伴奏」即可。','Work and settings are ready. Press Start accompaniment.'));
  }
  catch(e){if(revision===workRevision){savedStatus('准备未完成，请点击「恢复默认配置」重试','Preparation incomplete; select Restore defaults to retry');message(e.message,true);}}
  finally{if(revision===workRevision){restoring=false;controls();}}
}
async function importPreset(file){
  if(!file)return;const revision=++workRevision;++fileGeneration;clearTimeout(saveTimer);restoring=true;controls();savedStatus('正在核对肖邦演奏包…','Verifying Chopin performance pack…');
  try{if(file.size>121*1024*1024)throw Error('演奏包过大 / Performance pack is too large');const clean=await decodePreset(await file.arrayBuffer());if(revision!==workRevision)return;if(!await applyConfiguration(clean,revision))return;restoring=false;await saveNow();message(t('肖邦第一乐章已配置：完整乐队、独奏轨静音、双钢琴谱第13页。以后在此浏览器打开会自动恢复。','Chopin movement I configured: complete orchestra, solo muted, two-piano PDF at page 13. This browser will restore it next time.'));}
  catch(e){if(revision===workRevision){savedStatus('演奏包未完整载入，可重新导入','Pack did not finish loading; please retry');message(e.message,true);}}
  finally{if(revision===workRevision){restoring=false;controls();}$('pack').value='';}
}
async function stop(notify=true) {
  ++run;starting=false;if(timer)clearInterval(timer);timer=null;transport?.stop();
  const oldSynth=synth,oldMic=mic;synth=null;mic=null;follower=null;
  await Promise.allSettled([oldSynth?.stop(),oldMic?.stop()]);
  $('release').disabled=true;$('state').textContent=t('已停止','Stopped');
  if(notify)message(t('伴奏与麦克风已停止。重新开始将从所选小节演奏。','Orchestra and microphone stopped. Start again from the selected bar.'));controls();
}
async function start() {
  if(starting || transport?.playing || !midi || !$('confirmed').checked)return;
  const score=split(),measure=Number($('measure').value),beat=Number.isInteger(measure)?startBeat():NaN;
  if(!Number.isInteger(measure) || measure<(midi.scoreMap?0:1) || !Number.isFinite(beat) || beat>=midi.endBeat){message(t('请选择 MIDI 范围内的起始小节。','Choose a starting bar within this MIDI.'),true);return;}
  if(!score.orchestra.some(e=>e.command===9 && e.b)){message(t('乐队没有音符，请保留至少一条伴奏轨。','No orchestra notes. Leave at least one accompaniment track.'),true);return;}
  const follow=$('mode').value==='follow';
  if(follow && !score.solo.length){message(t('跟随需要独奏参考：请勾选独奏轨，或另载入对齐的独奏 MIDI。','Following needs a solo reference. Select solo tracks or load aligned solo MIDI.'),true);return;}
  if(follow && !navigator.mediaDevices?.getUserMedia){message(t('此浏览器无法使用麦克风，请用 HTTPS 下的 Chrome 或 Edge。','Microphone unavailable. Use Chrome or Edge over HTTPS.'),true);return;}
  const id=++run;starting=true;controls();$('position').textContent=positionText(beat);$('state').textContent=t('正在准备音色…','Preparing sound…');message(t('首次需载入约 38 MB 乐队音色。可随时按停止取消。','First use downloads about 38 MB of orchestra sounds. Stop cancels preparation.'));
  const output=synth=new OrchestraSynth();let input;
  try {
    await output.init(Number($('volume').value)/100);if(id!==run){await output.stop();return;}
    if(follow) {
      const orchestra=midi.tracks.filter(tr=>!selected().includes(tr.id)).flatMap(tr=>tr.intervals).sort((a,b)=>a.beat-b.beat);
      follower=new BrowserFollower({solo:score.solo,phrases:score.phrases,orchestra,clock:midi.clock,speaker:$('speaker').checked});follower.reset(beat);
      input=mic=new LiveMic();$('state').textContent=t('请允许麦克风…','Allow microphone access…');message(t('请在浏览器提示中允许麦克风。如无提示，请使用 Chrome 或 Edge 打开此页。','Allow the microphone in your browser. If no prompt appears, open this page in Chrome or Edge.'));
      await input.start({deviceId:$('device').value,speaker:$('speaker').checked,onFrame:frame=>{if(id!==run || !transport?.playing)return;follower.observe(frame,transport.beat,output.context.currentTime);$('mic-status').textContent=`${frame.db.toFixed(0)} dBFS · ${t('匹配','Match')} ${Math.round(follower.confidence*100)}%`;},onEnded:()=>{if(id===run){stop(false);message(t('麦克风已断开，伴奏停止。','Microphone disconnected; accompaniment stopped.'),true);}}});
      if(id!==run){await input.stop();await output.stop();return;}
      const devices=await navigator.mediaDevices.enumerateDevices();const previous=$('device').value;
      $('device').replaceChildren(new Option(t('系统默认麦克风','System default microphone'),''),...devices.filter(d=>d.kind==='audioinput').map((d,i)=>new Option(d.label||`Microphone ${i+1}`,d.deviceId)));$('device').value=previous;
    }
    if(id!==run){await input?.stop();await output.stop();return;}
    transport=new Transport({midi,events:score.orchestra,clock:()=>output.context.currentTime,send:(e,at)=>output.send(e,at),onState:showPlayback,onEnd:()=>{stop(false);message(t('本次播放完成。','Playback complete.'));},onError:e=>{stop(false);message(e.message,true);}});
    restoreState(score.orchestra,beat,(e,at)=>output.send(e,at),output.context.currentTime);
    transport.start(beat,Number($('rate').value)/100);starting=false;controls();
    message(demo?t('正在播放自制音色示例（并非肖邦曲目）。','Playing the original sound example, not the Chopin work.'):t('乐队已开始。曲谱请手动翻页；Esc 随时停止。','Orchestra started. Turn PDF pages manually; Esc stops at any time.'));
    timer=setInterval(()=>{
      if(id!==run)return;
      const control=follower?.control(transport.beat,output.context.currentTime) || {gate:Infinity,scale:1,label:'fixed'};
      transport.label=control.label;
      transport.tick(Number($('rate').value)/100*control.scale,control.gate);
    },25);
  }catch(e){if(id===run){await stop(false);message(`${t('无法开始','Unable to start')}: ${e.message}`,true);}else{await input?.stop();await output.stop();}}
}
const states={fixed:['参考速度播放','Reference tempo'],rest:['乐队前奏 / 独奏休止','Orchestra / solo rest'],waiting:['等待独奏匹配','Waiting for solo'],lost:['匹配丢失 · 已等待','Alignment lost · holding'],following:['试验跟随','Experimental following'],manual:['此乐句按原速','Reference tempo for this phrase']};
function showPlayback(player) {
  const label=states[player.label] || states.fixed;
  $('state').textContent=t(...label);$('position').textContent=positionText(player.beat);
  const bpm=midi.scoreMap?midi.scoreMap.bpmAt(player.beat,midi.clock,player.rate):midi.clock.bpm(player.beat)*player.rate;
  $('tempo').textContent=midi.scoreMap?.atBeat(player.beat).freeTime?t('自由速度','Free time'):`${bpm.toFixed(0)} BPM`;
}
$('midi').addEventListener('change',e=>loadMidi(e.target.files[0]));$('solo').addEventListener('change',e=>loadMidi(e.target.files[0],true));
$('confirmed').addEventListener('change',()=>{controls();queueSave();});$('mode').addEventListener('change',()=>{controls();queueSave();});
$('pack').addEventListener('change',e=>importPreset(e.target.files[0]));for(const id of ['measure','speaker','device'])$(id).addEventListener('change',()=>{if(id==='measure' && midi && !transport?.playing){try{$('position').textContent=positionText(startBeat());}catch{}}queueSave();});
$('start').addEventListener('click',start);$('stop').addEventListener('click',()=>stop());$('release').addEventListener('click',()=>follower?.release());
for(const id of ['rate','volume'])$(id).addEventListener('input',()=>{$(id+'-label').textContent=$(id).value+'%';if(id==='volume')synth?.volume(Number($(id).value)/100);queueSave();});
$('demo').addEventListener('click',async()=>{++workRevision;clearTimeout(saveTimer);restoring=false;await stop(false);++fileGeneration;loading=false;midi=parseMidi(demoMidi());soloMidi=null;sourceLabel=t('8 小节自制示例','8-bar original example');demo=true;$('midi').value='';$('solo').value='';$('solo-info').textContent='';showTracks();$('confirmed').checked=true;$('rate').value=100;$('rate-label').textContent='100%';message(t('自制示例已就绪，点击开始。它不是肖邦曲目的片段。','Original example ready. Press Start; this is not a Chopin excerpt.'));controls();});
$('clear').addEventListener('click',async()=>{const revision=++workRevision;presetAbort?.abort();++fileGeneration;clearTimeout(saveTimer);restoring=true;loading=false;++pdfGeneration;files={midi:null,solo:null,pdf:null};await stop(false);if(revision!==workRevision)return;try{await store.clear();savedStatus('本浏览器保存的配置已清除','Saved configuration cleared from this browser');}catch(e){savedStatus('未能清除浏览器保存，请重试','Could not clear saved settings; please retry');}if(revision!==workRevision)return;midi=null;soloMidi=null;demo=false;sourceLabel='';$('midi').value='';$('solo').value='';$('pdf').value='';$('track-list').replaceChildren();$('confirmed').checked=false;$('solo-info').textContent='';$('midi-info').textContent=t('未载入 MIDI','No MIDI loaded');$('position').textContent='—';$('tempo').textContent='— BPM';++pdfGeneration;await pdfTask?.destroy();if(revision!==workRevision)return;pdfTask=null;pdf=null;$('score-canvas').hidden=true;$('score-empty').hidden=false;$('page-count').textContent='/ —';for(const id of ['page','previous','next'])$(id).disabled=true;$('materials-details').open=true;await restoreConfiguration(true);});
document.addEventListener('visibilitychange',()=>{if(document.hidden && (starting || transport?.playing)){stop(false);message(t('页面进入后台，伴奏已停止。','Page moved to the background; playback stopped.'));}});
window.addEventListener('pagehide',()=>{stop(false);pdfTask?.destroy();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();stop();}if(!/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)){if(e.key==='ArrowLeft'){e.preventDefault();turn(-1);}if(e.key==='ArrowRight'){e.preventDefault();turn(1);}}});
async function renderPDF() {
  if(!pdf)return;
  const id=pdfGeneration,renderId=++renderGeneration,doc=pdf,currentPage=page;
  try{const sheet=await doc.getPage(currentPage);if(id!==pdfGeneration || renderId!==renderGeneration)return;
    const previousRender=pdfRender;previousRender?.cancel();await previousRender?.promise.catch(()=>{});
    if(id!==pdfGeneration || renderId!==renderGeneration)return;
    const scale=Math.min(2,Math.max(.5,($('score-canvas').parentElement.clientWidth-44)/sheet.getViewport({scale:1}).width))*(window.devicePixelRatio||1);
    const viewport=sheet.getViewport({scale}),canvas=$('score-canvas');canvas.width=viewport.width;canvas.height=viewport.height;canvas.hidden=false;$('score-empty').hidden=true;
    pdfRender=sheet.render({canvasContext:canvas.getContext('2d'),viewport});await pdfRender.promise;
    if(id!==pdfGeneration || renderId!==renderGeneration)return;$('page').value=currentPage;$('page-count').textContent=`/ ${doc.numPages}`;$('page').max=doc.numPages;$('page').disabled=false;$('previous').disabled=currentPage<=1;$('next').disabled=currentPage>=doc.numPages;queueSave();return true;
  }catch(e){if(e.name!=='RenderingCancelledException' && id===pdfGeneration)message(e.message,true);return false;}
}
function turn(delta){if(pdf){page=Math.max(1,Math.min(pdf.numPages,page+delta));renderPDF();}}
function jumpPDF(){if(pdf){page=Math.max(1,Math.min(pdf.numPages,Math.floor(Number($('page').value)||1)));renderPDF();}}
$('previous').addEventListener('click',()=>turn(-1));$('next').addEventListener('click',()=>turn(1));$('page').addEventListener('change',jumpPDF);$('page').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();jumpPDF();}});
async function loadPDF(asset,targetPage=1,save=true) {
  const file=asset.blob,id=++pdfGeneration;
  try{if(file.size>100*1024*1024)throw Error(t('PDF 需小于 100 MB','PDF must be under 100 MB'));await pdfTask?.destroy();pdf=null;
    const pdfjs=await import('../stage/vendor/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc=new URL('../stage/vendor/pdf.worker.mjs',import.meta.url).href;
    const data=await file.arrayBuffer();if(id!==pdfGeneration)return false;
    pdfTask=pdfjs.getDocument({data,cMapUrl:new URL('../stage/vendor/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('../stage/vendor/standard_fonts/',import.meta.url).href,wasmUrl:new URL('../stage/vendor/wasm/',import.meta.url).href,isEvalSupported:false});
    const doc=await pdfTask.promise;if(id!==pdfGeneration){await doc.destroy();return false;}pdf=doc;page=Math.max(1,Math.min(doc.numPages,Math.floor(targetPage)||1));if(await renderPDF()===false)return false;if(id!==pdfGeneration)return false;files.pdf=asset;$('pdf-info').textContent=`${asset.name} · ${t('PDF手动翻页 · 页码对应所选PDF版本','Manual PDF page turns · page numbers refer to the selected PDF')}`;if(save)await saveNow();return true;
  }catch(error){if(id===pdfGeneration)message(error.message,true);return false;}
}
$('pdf').addEventListener('change',async e=>{const file=e.target.files[0];if(file){++workRevision;restoring=false;await loadPDF({name:file.name,blob:file});}});
controls();$('state').textContent=t('正在准备曲目…','Preparing work…');restoreConfiguration();
