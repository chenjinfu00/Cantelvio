import {inkDraft} from './storage.js';
import {mergeInk,distanceToSegment} from './ink-model.js';
import {PUBLIC_LIBRARY} from './site-config.js';
const blank=()=>({version:1,strokes:[]}),copy=structuredClone;
const $=id=>document.getElementById(id);
const timedFetch=(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(12000)});
export class Ink {
  constructor(toast,{localOnly=PUBLIC_LIBRARY}={}){this.toast=toast;this.localOnly=localOnly;this.records=new Map();this.views=new Set();this.scoreId=null;this.mode='read';this.page=1;this.color='#21382d';
    for(const mode of ['read','pen','erase'])$('ink-'+mode).onclick=()=>this.setMode(mode);
    $('ink-color').onchange=e=>this.color=e.target.value;
    $('ink-undo').onclick=()=>this.history(false);$('ink-redo').onclick=()=>this.history(true);
    $('ink-export').onclick=()=>this.export();
    window.addEventListener('online',()=>{for(const r of this.records.values())if(r.dirty)this.flush(r);});
  }
  setScore(id){this.clearViews();this.scoreId=id;this.setMode('read');for(const [key,r] of this.records)if(!key.startsWith(id+'/')&&!r.dirty&&!r.saving)this.records.delete(key);}
  setMode(mode){for(const v of this.views)v.finish?.();this.mode=mode;for(const m of ['read','pen','erase']){$('ink-'+m).classList.toggle('selected',m===mode);$('ink-'+m).setAttribute('aria-pressed',String(m===mode));}for(const v of this.views)v.canvas.classList.toggle('writing',mode!=='read');}
  status(message){$('ink-status').textContent=message;}
  async record(id,page){
    const key=id+'/'+page;if(this.records.has(key)){const cached=this.records.get(key);return cached.ready||cached;}
    const r={key,data:blank(),base:blank(),etag:'"new"',dirty:false,revision:0,undo:[],redo:[],views:new Set(),loading:true};
    r.ready=new Promise(resolve=>r.resolveReady=resolve);this.records.set(key,r);
    const draft=await inkDraft(key).catch(()=>null);
    if(this.localOnly){
      r.data=draft?.data||blank();r.base=copy(r.data);r.loading=false;r.dirty=false;
      this.status('批注仅保存在当前浏览器 · 建议定期导出备份');
      r.resolveReady(r);delete r.resolveReady;return r;
    }
    try{
      const response=await timedFetch('./api/notes/'+key,{cache:'no-store'});if(!response.ok)throw new Error('读取失败');
      const remote=await response.json();r.etag=response.headers.get('ETag');r.base=copy(remote);
      r.data=draft?.dirty?mergeInk(draft.base,draft.data,remote):remote;r.dirty=!!draft?.dirty;r.loading=false;
      if(r.dirty)this.flush(r);else this.status('批注已载入');
    }catch{r.data=draft?.data||blank();r.base=draft?.base||blank();r.etag=draft?.etag||'"new"';r.dirty=!!draft?.dirty;r.loading=false;this.status('离线草稿 · 联网后重试同步');}
    r.resolveReady(r);delete r.resolveReady;return r;
  }
  clearViews(){for(const v of this.views){v.finish?.();v.abort.abort();v.record.views.delete(v);}this.views.clear();}
  async attach(sheet,page){
    if(!this.scoreId)return;const id=this.scoreId,r=await this.record(id,page);
    if(id!==this.scoreId||!sheet.isConnected)return;
    const canvas=document.createElement('canvas'),base=sheet.querySelector('canvas');canvas.width=base.width;canvas.height=base.height;
    canvas.className='ink-overlay'+(this.mode!=='read'?' writing':'');canvas.ariaLabel='手写批注层';sheet.append(canvas);
    const v={canvas,record:r,abort:new AbortController()};this.views.add(v);r.views.add(v);
    let current=null,active=null,before=null;
    const point=e=>{const rect=canvas.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height)),Math.max(.1,Math.min(1,e.pressure||.5))];};
    const erase=p=>{r.data.strokes=r.data.strokes.filter(s=>!s.points.some((b,i)=>distanceToSegment(p,i?s.points[i-1]:b,b)<.016));};
    const finish=()=>{
      if(active===null)return;
      if(current?.points.length)r.data.strokes.push(current);
      r.undo.push(before);if(r.undo.length>25)r.undo.shift();r.redo=[];current=null;active=null;this.changed(r);this.draw(r);
    };v.finish=finish;
    const options={signal:v.abort.signal};
    canvas.addEventListener('pointerdown',e=>{
      // Touch is intentionally ignored in writing mode (palm/fingers).
      if(this.mode==='read'||!['pen','mouse'].includes(e.pointerType)||e.button!==0||active!==null||r.loading)return;
      e.preventDefault();e.stopPropagation();this.page=page;active=e.pointerId;before=copy(r.data);canvas.setPointerCapture(active);
      if(this.mode==='pen')current={id:crypto.randomUUID(),color:this.color,width:.0024,points:[point(e)]};else erase(point(e));
      this.draw(r,current);
    },options);
    canvas.addEventListener('pointermove',e=>{
      if(e.pointerId!==active)return;e.preventDefault();
      const events=e.getCoalescedEvents?.();for(const event of events?.length?events:[e]){if(current)current.points.push(point(event));else erase(point(event));}
      this.draw(r,current);
    },options);
    for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,e=>{if(e.pointerId===active)finish();},options);
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
  cache(r){return inkDraft(r.key,{data:r.data,base:r.base,etag:r.etag,dirty:r.dirty}).catch(()=>this.toast('本机草稿保存失败，请保持页面打开并导出批注备份。'));}
  async flush(r){
    if(r.saving||!r.dirty)return;r.saving=true;
    if(this.localOnly){
      try{
        while(r.dirty){const revision=r.revision,sent=copy(r.data);await inkDraft(r.key,{data:sent,base:sent,etag:'"local"',dirty:false});r.base=sent;r.dirty=r.revision!==revision;}
        this.status('批注已保存到当前浏览器 · 不会上传');
      }catch{this.status('批注保存失败 · 请立即导出备份');this.toast('浏览器存储不可用，请保持页面打开并导出批注备份。');}
      finally{r.saving=false;}return;
    }
    try{
      for(let attempt=0;attempt<3&&r.dirty;attempt++){
        const sent=copy(r.data),revision=r.revision;
        const response=await timedFetch('./api/notes/'+r.key,{method:'PUT',headers:{'Content-Type':'application/json','If-Match':r.etag},body:JSON.stringify(sent)});
        if(response.status===409){
          const latest=await timedFetch('./api/notes/'+r.key,{cache:'no-store'});if(!latest.ok)throw new Error('暂时无法合并');
          const remote=await latest.json();r.data=mergeInk(r.base,r.data,remote);r.base=copy(remote);r.etag=latest.headers.get('ETag');this.draw(r);await this.cache(r);continue;
        }
        if(!response.ok)throw new Error('同步暂不可用');
        r.etag=response.headers.get('ETag');r.base=sent;r.dirty=r.revision!==revision;await this.cache(r);
      }
      this.status(r.dirty?'批注合并中，请稍后重试':'批注已保存');
    }catch{this.status('批注保留在本机草稿 · 尚未同步');await this.cache(r);}
    finally{r.saving=false;if(r.dirty&&navigator.onLine){clearTimeout(r.timer);r.timer=setTimeout(()=>this.flush(r),15000);}}
  }
  history(redo){
    const r=this.records.get(this.scoreId+'/'+this.page);if(!r)return;
    const from=redo?r.redo:r.undo,to=redo?r.undo:r.redo;if(!from.length)return;
    to.push(copy(r.data));if(to.length>25)to.shift();r.data=from.pop();this.changed(r);this.draw(r);
  }
  export(){
    const pages={};for(const [key,r] of this.records)if(key.startsWith(this.scoreId+'/'))pages[key.split('/')[1]]=r.data;
    const blob=new Blob([JSON.stringify({version:1,scoreId:this.scoreId,pages},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='volta-annotations.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    this.toast('已导出本次打开过的页面批注备份。');
  }
}
