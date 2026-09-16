import {inkDraft} from './storage.js';
import {distanceToSegment} from './ink-model.js';
import {PencilInput,strokeID} from './pencil-input.js';
const blank=()=>({version:1,strokes:[]}),copy=structuredClone;
const $=id=>document.getElementById(id);
// Slider steps 1–10 map to a stroke that stays inside the validator's 0 < width <= .1 range.
export const strokeWidth=step=>Math.round((.0012+(Math.max(1,Math.min(10,Number(step)||1))-1)*.0012)*1e6)/1e6;
export const eraserRadius=step=>Math.round((.008+(Math.max(1,Math.min(10,Number(step)||1))-1)*.006)*1e6)/1e6;
export class Ink {
  constructor(toast,{canWrite=()=>true,draft=inkDraft,inputOptions={}}={}){this.toast=toast;this.canWrite=canWrite;this.draft=draft;this.inputOptions=inputOptions;this.records=new Map();this.views=new Set();this.scoreId=null;this.mode='read';this.page=1;this.color='#2858aa';this.width=strokeWidth(2);this.eraser=eraserRadius(2);this.penDown=false;this.palmUntil=0;
    for(const mode of ['pen','erase'])this.holdable($('ink-'+mode),mode);
    for(const button of document.querySelectorAll('[data-ink-color]'))button.onclick=()=>this.setColor(button.dataset.inkColor);
    // A stroke is stored as a fraction of the page, so the slider works the same on any paper size.
    $('ink-width').oninput=e=>{this.width=strokeWidth(e.target.value);this.preview('ink-width-preview',this.width);};
    $('eraser-width').oninput=e=>{this.eraser=eraserRadius(e.target.value);this.preview('eraser-width-preview',this.eraser);};
    this.preview('ink-width-preview',this.width);this.preview('eraser-width-preview',this.eraser);
    $('ink-undo').onclick=()=>this.history(false);$('ink-redo').onclick=()=>this.history(true);
    $('ink-export').onclick=()=>this.export();
    // A settings panel opened by holding should close the way any popover does.
    document.addEventListener('pointerdown',event=>{
      const dock=$('ink-toolbar');
      if(dock&&!dock.contains(event.target))for(const popover of document.querySelectorAll('.pencil-popover'))popover.open=false;
    },true);
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape')for(const popover of document.querySelectorAll('.pencil-popover'))popover.open=false;
    });
    window.addEventListener('online',()=>{for(const r of this.records.values())if(r.dirty)this.flush(r);});
  }
  // Tap switches tool, hold opens that tool's settings. One button, both jobs, and no row of
  // dots taking up the dock for a panel that is wanted once a session.
  holdable(button,mode,{delay=450}={}){
    let timer=null,held=false;
    const cancel=()=>{clearTimeout(timer);timer=null;};
    const hold=()=>{held=true;cancel();this.setMode(mode,{finish:false});this.openOptions(mode);};
    button.addEventListener('pointerdown',event=>{
      if(event.button)return;held=false;cancel();timer=setTimeout(hold,delay);
    });
    for(const name of ['pointerup','pointerleave','pointercancel'])button.addEventListener(name,cancel);
    button.addEventListener('contextmenu',event=>{event.preventDefault();hold();});
    button.onclick=event=>{
      if(held){held=false;event.preventDefault();return;}   // the hold already did the work
      this.setMode(this.mode===mode?'read':mode);
    };
  }
  openOptions(mode){
    const panel=$(mode+'-options');
    if(!panel)return;
    for(const other of document.querySelectorAll('.pencil-popover'))other.open=other===panel;
    this.feedback(mode==='erase'?'橡皮大小':'颜色与粗细');
  }
  setScore(id){this.clearViews();this.scoreId=id;this.setMode('read');this.refreshHistory();for(const [key,r] of this.records)if(!key.startsWith(id+'/')&&!r.dirty&&!r.saving)this.records.delete(key);}
  setColor(color){this.color=color;for(const button of document.querySelectorAll('[data-ink-color]'))button.setAttribute('aria-pressed',String(button.dataset.inkColor===color));}
  preview(id,fraction){const node=$(id);if(node)node.style.setProperty('--dot',Math.max(3,Math.round(fraction*1400))+'px');}
  setMode(mode,{finish=true}={}){for(const popover of document.querySelectorAll('.pencil-popover'))if(popover.id!==mode+'-options')popover.open=false;
    if(mode==='read')for(const popover of document.querySelectorAll('.pencil-popover'))popover.open=false;
    if(finish)for(const v of this.views)v.finish?.();this.mode=mode;for(const m of ['pen','erase']){$('ink-'+m).classList.toggle('selected',m===mode);$('ink-'+m).setAttribute('aria-pressed',String(m===mode));}for(const v of this.views)v.canvas.classList.toggle('writing',mode!=='read');}
  get guardingTouch(){return this.penDown||performance.now()<this.palmUntil;}
  feedback(message){$('pencil-feedback').textContent=message;$('pencil-feedback').hidden=false;clearTimeout(this.feedbackTimer);this.feedbackTimer=setTimeout(()=>$('pencil-feedback').hidden=true,1300);}
  status(message){$('ink-status').textContent=message;}
  async record(id,page){
    const key=id+'/'+page;if(this.records.has(key)){const cached=this.records.get(key);return cached.ready||cached;}
    const r={key,data:blank(),base:blank(),etag:'"new"',dirty:false,revision:0,undo:[],redo:[],views:new Set(),loading:true};
    r.ready=new Promise(resolve=>r.resolveReady=resolve);this.records.set(key,r);
    const draft=await this.draft(key).catch(()=>null);
    r.data=draft?.data||blank();r.base=copy(r.data);r.loading=false;r.dirty=false;
    r.resolveReady(r);delete r.resolveReady;return r;
  }
  clearViews(){for(const v of this.views){v.finish?.();v.abort.abort();v.record.views.delete(v);v.canvas.remove();v.canvas.width=0;v.canvas.height=0;}this.views.clear();}
  async attach(sheet,page){
    if(!this.scoreId)return;const id=this.scoreId,r=await this.record(id,page);
    if(id!==this.scoreId||!sheet.isConnected)return;
    const canvas=document.createElement('canvas'),base=sheet.querySelector('canvas');canvas.width=base.width;canvas.height=base.height;
    canvas.className='ink-overlay'+(this.mode!=='read'?' writing':'');canvas.ariaLabel='手写批注层';sheet.append(canvas);
    const v={canvas,record:r,abort:new AbortController()};this.views.add(v);r.views.add(v);
    let current=null,before=null;
    const point=e=>{const rect=canvas.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height)),Math.max(.1,Math.min(1,e.pressure||.5))];};
    const erase=p=>{const radius=this.eraser;r.data.strokes=r.data.strokes.filter(s=>!s.points.some((b,i)=>distanceToSegment(p,i?s.points[i-1]:b,b)<radius));};
    const input=new PencilInput({
      allowed:e=>!r.loading&&!this.penDown&&this.canWrite()&&(e.pointerType==='pen'||this.mode!=='read'),
      begin:e=>{
        if(e.pointerType==='pen'&&this.mode==='read')this.setMode('pen',{finish:false});
        this.penDown=true;this.page=page;before=copy(r.data);
        if(this.mode==='pen')current={id:strokeID(),color:this.color,width:this.width,points:[point(e)]};else erase(point(e));
        this.draw(r,current);
      },
      move:events=>{for(const event of events){if(current)current.points.push(point(event));else erase(point(event));}this.draw(r,current);},
      commit:()=>{
        if(current?.points.length)r.data.strokes.push(current);
        // Erasing an empty area should not consume an undo step.
        if(current||r.data.strokes.length!==before.strokes.length){r.undo.push(before);if(r.undo.length>25)r.undo.shift();r.redo=[];this.changed(r);}
        this.refreshHistory();
        current=null;before=null;this.draw(r);
      },
      cancel:()=>{if(before)r.data=before;current=null;before=null;this.draw(r);},
      toggle:()=>{this.setMode(this.mode==='erase'?'pen':'erase',{finish:false});this.feedback(this.mode==='erase'?'已切换橡皮 · 抬笔后擦除':'已切换画笔 · 抬笔后书写');},
      end:()=>{this.penDown=false;this.palmUntil=performance.now()+400;},
    },this.inputOptions);v.finish=()=>input.finish();
    const options={signal:v.abort.signal};
    // Cancel only stylus-native callouts/gestures; ordinary finger navigation
    // and two-finger zoom remain available while the pen is not down.
    for(const type of ['touchstart','touchmove'])canvas.addEventListener(type,e=>{
      if(this.penDown||Array.from(e.changedTouches||[]).some(t=>t.touchType==='stylus'))e.preventDefault();
    },{...options,passive:false});
    canvas.addEventListener('pointerdown',e=>{
      if(!input.down(e))return;e.preventDefault();e.stopPropagation();try{canvas.setPointerCapture(e.pointerId);}catch{}
    },options);
    canvas.addEventListener('pointermove',e=>{
      if(input.move(e)){e.preventDefault();e.stopPropagation();}
    },options);
    for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,e=>{if(input.end(e,event!=='pointerup')){e.preventDefault();e.stopPropagation();}},options);
    canvas.addEventListener('contextmenu',e=>{if(this.mode!=='read'||this.penDown)e.preventDefault();},options);
    this.draw(r);
  }
  draw(r,draft=null){
    r.pendingDraft=draft;if(r.paintQueued)return;r.paintQueued=true;
    requestAnimationFrame(()=>{r.paintQueued=false;this.paint(r,r.pendingDraft);});
  }
  paint(r,draft=null){
    for(const {canvas} of r.views){const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.lineCap='round';ctx.lineJoin='round';
      for(const stroke of [...r.data.strokes,...(draft?[draft]:[])]){
        ctx.strokeStyle=ctx.fillStyle=stroke.color;
        for(let i=0;i<stroke.points.length;i++){
          const p=stroke.points[i],previous=stroke.points[Math.max(0,i-1)];ctx.lineWidth=stroke.width*canvas.width*(.55+p[2]);
          if(i===0){ctx.beginPath();ctx.arc(p[0]*canvas.width,p[1]*canvas.height,ctx.lineWidth/2,0,Math.PI*2);ctx.fill();}
          else{ctx.beginPath();ctx.moveTo(previous[0]*canvas.width,previous[1]*canvas.height);ctx.lineTo(p[0]*canvas.width,p[1]*canvas.height);ctx.stroke();}
        }
      }
    }
  }
  changed(r){r.dirty=true;r.revision++;this.status('正在保存批注…');this.cache(r);clearTimeout(r.timer);r.timer=setTimeout(()=>this.flush(r),400);}
  cache(r){return this.draft(r.key,{data:r.data,base:r.base,etag:r.etag,dirty:r.dirty}).catch(()=>this.toast('本机草稿保存失败，请保持页面打开并导出批注备份。'));}
  flush(r){
    if(r.savePromise)return r.savePromise;
    r.savePromise=this.flushNow(r).finally(()=>{r.savePromise=null;});return r.savePromise;
  }
  async flushNow(r){
    if(!r.dirty)return;r.saving=true;
    try{
      while(r.dirty){const revision=r.revision,sent=copy(r.data);await this.draft(r.key,{data:sent,base:sent,etag:'"local"',dirty:false});r.base=sent;r.dirty=r.revision!==revision;}
      this.status('批注已保存在这台设备上');
    }catch{this.status('批注保存失败 · 请立即导出备份');this.toast('浏览器存储不可用，请保持页面打开并导出批注备份。');}
    finally{r.saving=false;}
  }
  // Undo and redo say plainly whether there is anything to undo on the page you last wrote on.
  refreshHistory(){
    const r=this.records.get(this.scoreId+'/'+this.page);
    $('ink-undo').disabled=!r?.undo?.length;$('ink-redo').disabled=!r?.redo?.length;
  }
  history(redo){
    const r=this.records.get(this.scoreId+'/'+this.page);if(!r)return;
    const from=redo?r.redo:r.undo,to=redo?r.undo:r.redo;if(!from.length)return;
    to.push(copy(r.data));if(to.length>25)to.shift();r.data=from.pop();this.changed(r);this.draw(r);this.refreshHistory();
  }
  export(){
    const pages={};for(const [key,r] of this.records)if(key.startsWith(this.scoreId+'/'))pages[key.split('/')[1]]=r.data;
    const blob=new Blob([JSON.stringify({version:1,scoreId:this.scoreId,pages},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='volta-annotations.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    this.toast('已导出本次打开过的页面批注备份。');
  }
}
