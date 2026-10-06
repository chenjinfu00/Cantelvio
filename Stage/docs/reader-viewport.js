// Screen dimensions are CSS pixels, not native panel pixels. Use them only for
// a small, full-width iPad Home Screen inset; never expand a smaller app window.
export function homeScreenHeight(width,height,{ipadStandalone=false,screenWidth=0,screenHeight=0,editing=false}={}){
  if(!ipadStandalone||editing)return height;
  const candidates=[[screenWidth,screenHeight],[screenHeight,screenWidth]];
  for(const [w,h] of candidates){
    const gap=h-height;
    if(Math.abs(w-width)<=2&&gap>0&&gap<=96&&height>=h*.9)return h;
  }
  return height;
}
export function viewportSize({frameWidth,frameHeight,innerWidth,innerHeight,clientHeight,visual,immersive=false,editing=false,...device}){
  if(visual?.scale&&Math.abs(visual.scale-1)>.02)return null; // Preserve native pinch zoom.
  const positive=value=>Number.isFinite(value)&&value>0?value:0;
  const width=positive(frameWidth)||positive(innerWidth);
  const layout=positive(frameHeight)||positive(innerHeight)||positive(clientHeight);
  const visible=positive(visual?.height);
  const height=immersive&&!editing?Math.max(layout,positive(innerHeight),positive(clientHeight),visible):visible?Math.min(layout||visible,visible):layout;
  if(!width||!height)return null;
  return {width:Math.round(width),height:Math.round(homeScreenHeight(width,height,{...device,editing}))};
}

const calibrationKey='volta:screen-calibration:v1';
export function normalizeCalibration(value){
  const clamp=value=>typeof value==='number'&&Number.isFinite(value)?Math.max(-80,Math.min(80,Math.round(value))):0;
  return {portrait:clamp(value?.portrait),landscape:clamp(value?.landscape)};
}
export function calibratedViewport(size,value,enabled){
  const orientation=size.height>=size.width?'portrait':'landscape';
  const adjustment=enabled?normalizeCalibration(value)[orientation]:0;
  return {...size,height:Math.max(100,size.height+adjustment),orientation,adjustment};
}

// Record DOM boundaries and a bottom-edge hit test, not just our requested size.
// This lets a device screenshot distinguish a short layout from OS clipping.
export function readerBoundaries(doc,size){
  const lines=[];
  for(const [name,selector] of [['文档','html'],['页面','body'],['谱架','.reader'],['阅谱区','#score-stage']]){
    const element=doc.querySelector(selector);if(!element)continue;
    const box=element.getBoundingClientRect();lines.push(`${name}：${Math.round(box.top)} → ${Math.round(box.bottom)}`);
  }
  const bottom=doc.elementFromPoint(Math.round(size.width/2),size.height-2);
  lines.push(`底边命中：${bottom?(bottom.id||bottom.getAttribute('aria-label')||bottom.tagName):'窗口之外 / 无元素'}`);
  return lines.join('\n');
}

let installed;
export function installReaderViewport(){
  if(installed)return installed;
  const template=document.getElementById('viewport-details-template');
  if(template)document.querySelector('#settings-dialog .settings-layout > section:last-child')?.append(template.content.cloneNode(true));
  const root=document.documentElement,probe=document.createElement('div');
  probe.className='viewport-probe';probe.setAttribute('aria-hidden','true');document.body.append(probe);
  let frame=0,last='',timers=[],report='',orientation='portrait';
  let calibration;try{calibration=normalizeCalibration(JSON.parse(localStorage.getItem(calibrationKey)));}catch{calibration=normalizeCalibration();}
  function sync(){
    frame=0;const bounds=probe.getBoundingClientRect(),visual=window.visualViewport;
    const active=document.activeElement,editing=!!active?.matches('textarea,[contenteditable="true"],input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="color"]):not([type="file"])');
    const home=!!(navigator.standalone||matchMedia('(display-mode: standalone)').matches||(!document.fullscreenElement&&!document.webkitFullscreenElement&&matchMedia('(display-mode: fullscreen)').matches));
    const ipad=/iPad/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
    root.classList.toggle('home-screen',home);
    const immersive=home||!!(document.fullscreenElement||document.webkitFullscreenElement);
    // The Home Screen document is explicitly sized below. Do not feed its own
    // height back into measurement or a manual +N adjustment could accumulate.
    const input={frameWidth:bounds.width,frameHeight:bounds.height,innerWidth:window.innerWidth,innerHeight:window.innerHeight,clientHeight:home?0:root.clientHeight,visual,immersive,editing};
    const measured=viewportSize(input),automatic=viewportSize({...input,ipadStandalone:ipad&&home,screenWidth:window.screen.width,screenHeight:window.screen.height});
    if(!automatic)return;
    const size=calibratedViewport(automatic,calibration,home&&!editing);orientation=size.orientation;
    const range=document.getElementById('screen-height-adjust'),output=document.getElementById('screen-height-value');
    if(range){range.disabled=!home;range.value=String(calibration[orientation]);}
    if(output)output.textContent=`${calibration[orientation]>0?'+':''}${calibration[orientation]} px · ${orientation==='portrait'?'竖屏':'横屏'}`;
    const key=size.width+':'+size.height;
    if(key!==last){last=key;root.style.setProperty('--reader-height',size.height+'px');root.style.setProperty('--reader-width',size.width+'px');}
    report=`主屏幕适配 v6 · ${home?'主屏幕应用':'网页窗口'}${ipad?' · iPad':''}\n系统报告：${measured.width} × ${measured.height}\n自动尺寸：${automatic.width} × ${automatic.height}\n采用布局：${size.width} × ${size.height}\n屏幕：${window.screen.width} × ${window.screen.height}\n高度补偿：${automatic.height-measured.height} px · 手动 ${size.adjustment} px\n可视区域：${Math.round(visual?.height||0)} · 偏移 ${Math.round(visual?.offsetTop||0)}\n${readerBoundaries(document,size)}\n批注和曲谱不会随诊断上传。`;
    const status=document.getElementById('viewport-diagnostics');if(status)status.textContent=report;
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(sync);};
  // Safari can settle its usable height after the fullscreen/orientation event.
  function refresh(){sync();schedule();timers.forEach(clearTimeout);timers=[60,250,800,1800].map(delay=>setTimeout(schedule,delay));}
  window.addEventListener('resize',schedule,{passive:true});window.visualViewport?.addEventListener('resize',schedule,{passive:true});
  window.visualViewport?.addEventListener('scroll',schedule,{passive:true});
  for(const event of ['orientationchange','pageshow'])window.addEventListener(event,refresh);
  for(const event of ['fullscreenchange','webkitfullscreenchange','focusout'])document.addEventListener(event,refresh);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  window.addEventListener('focus',refresh);
  document.getElementById('viewport-refresh')?.addEventListener('click',refresh);
  const adjust=document.getElementById('screen-height-adjust');
  adjust?.addEventListener('input',()=>{calibration=normalizeCalibration({...calibration,[orientation]:Number(adjust.value)});try{localStorage.setItem(calibrationKey,JSON.stringify(calibration));}catch{}refresh();});
  document.getElementById('screen-height-reset')?.addEventListener('click',()=>{calibration={...calibration,[orientation]:0};try{localStorage.setItem(calibrationKey,JSON.stringify(calibration));}catch{}refresh();});
  new ResizeObserver(schedule).observe(probe);
  installed={refresh,report:()=>report};refresh();return installed;
}
