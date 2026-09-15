import {installDockPosition} from './dock-position.js';
import {installScoreZoom} from './score-zoom.js';
import {installIdleChrome} from './idle-chrome.js';
export function readingGesture(start,end,{width,performance=false,canTurn=true,tap=true}={}){
  const dx=end.x-start.x,dy=end.y-start.y,ax=Math.abs(dx),ay=Math.abs(dy);
  if(start.y<=48&&dy>48&&ay>ax*1.4)return 'tools';
  if(start.x<=36&&dx>48&&ax>ay*1.4)return performance?'tools':'shelf';
  if(!canTurn)return null;
  if(ax>60&&ax>ay*1.5)return dx<0?'next':'previous';
  if(ax<14&&ay<14){if(end.x<width*.4)return tap?'previous':null;if(end.x>width*.6)return tap?'next':null;return 'tools';}
  return null;
}

export class ReaderShell {
  constructor({turn,canTurn,performing,writing,zoomed,settings=()=>({}),getZoom=()=>1,setZoom=()=>{},onError=()=>{}}){
    this.effects={turn,canTurn,performing,writing,zoomed};this.panel=null;
    this.reader=document.querySelector('.reader');this.shelf=document.querySelector('.sidebar');this.tools=document.getElementById('top-drawer');
    this.backdrop=document.getElementById('drawer-backdrop');this.stage=document.getElementById('score-stage');
    this.shelf.id='shelf-drawer';
    // The controls float over the score. Opening a drawer never changes its size.
    for(const selector of ['#score-card','#edition-toolbar','.reader-toolbar','.page-navigation','#practice-drawer'])this.tools.append(document.querySelector(selector));
    document.body.append(document.getElementById('ink-toolbar'));
    installDockPosition();
    this.idle=installIdleChrome();
    const practice=document.getElementById('practice-live');
    for(const selector of ['#reference-panel','.listening-bar','.reader-footer'])practice.append(document.querySelector(selector));
    this.backdrop.onclick=()=>this.close();
    document.getElementById('shelf-reveal').onclick=()=>this.open('shelf');
    document.getElementById('tools-reveal').onclick=()=>this.open('tools');
    document.querySelectorAll('[data-close-drawer]').forEach(button=>button.onclick=()=>this.close());
    this.tools.addEventListener('pointerdown',()=>this.arm());this.tools.addEventListener('keydown',()=>this.arm());
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&this.panel){event.preventDefault();event.stopImmediatePropagation();this.close();}
    },true);
    const active=new Set();let start=null,blocked=false,lastTurn=-Infinity;
    this.pinch=installScoreZoom(this.stage,{getZoom,canZoom:()=>canTurn()&&!writing()&&!this.panel,commit:setZoom,onError,onStart:()=>{start=null;blocked=true;active.clear();}});
    this.stage.addEventListener('pointerdown',event=>{
      if(event.pointerType==='pen'||event.button!==0||this.pinch.active)return;
      if(!active.size)blocked=false;
      active.add(event.pointerId);if(active.size>1){start=null;blocked=true;return;}
      if(writing()||document.querySelector('dialog[open]'))return;
      start={x:event.clientX,y:event.clientY,id:event.pointerId,scrollX:this.stage.scrollLeft,scrollY:this.stage.scrollTop,panned:false};
    });
    this.stage.addEventListener('pointermove',event=>{
      if(!start||start.id!==event.pointerId||writing()||active.size!==1)return;
      const dx=event.clientX-start.x,dy=event.clientY-start.y;
      // Reserve the top-edge pull for tools even when a tall page can scroll.
      if(start.y<=48&&dy>0&&Math.abs(dy)>Math.abs(dx)*1.4)return;
      if(start.x<=36&&dx>0&&Math.abs(dx)>Math.abs(dy)*1.4)return;
      const vertical=this.stage.scrollHeight>this.stage.clientHeight+2&&Math.abs(dy)>Math.abs(dx)*1.3;
      if(Math.hypot(dx,dy)>12&&(zoomed()||vertical)){
        start.panned=true;this.stage.scrollTop=start.scrollY-dy;if(zoomed())this.stage.scrollLeft=start.scrollX-dx;event.preventDefault();
      }
    });
    this.stage.addEventListener('pointerup',event=>{
      active.delete(event.pointerId);const beginning=start;start=null;
      if(blocked){if(!active.size)blocked=false;return;}
      if(!beginning||beginning.id!==event.pointerId||writing()||beginning.panned)return;
      const intent=readingGesture(beginning,{x:event.clientX,y:event.clientY},{width:innerWidth,performance:performing(),canTurn:canTurn()&&!zoomed(),tap:settings().tap!==false});
      if(intent==='shelf'||intent==='tools')this.open(intent);
      else if(intent){event.preventDefault();const now=performance.now(),delay={fast:90,standard:160,guarded:300}[settings().sensitivity]||90;if(now-lastTurn<delay)return;lastTurn=now;turn(intent==='next'?1:-1);}
    });
    this.stage.addEventListener('pointercancel',event=>{active.delete(event.pointerId);start=null;if(!active.size)blocked=false;});
    this.sync();
  }
  open(panel){
    if(this.effects.performing()&&panel==='shelf')panel='tools';
    for(const popover of document.querySelectorAll('.pencil-popover'))popover.open=false;
    this.panel=panel;this.sync();this.arm();this.idle?.wake();(panel==='shelf'?this.shelf:this.tools).querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }
  arm(){
    clearTimeout(this.timer);if(!this.panel||!this.effects.performing())return;
    this.timer=setTimeout(()=>{if(this.tools.contains(document.activeElement)&&document.activeElement.matches('input,select'))this.arm();else this.close();},5000);
  }
  close({focus=true}={}){this.panel=null;clearTimeout(this.timer);this.sync();this.idle?.wake();if(focus)this.stage.focus({preventScroll:true});}
  sync(){
    document.body.classList.toggle('shelf-open',this.panel==='shelf');document.body.classList.toggle('tools-open',this.panel==='tools');
    this.shelf.inert=this.panel!=='shelf';this.tools.inert=this.panel!=='tools';this.reader.inert=!!this.panel;
    this.shelf.setAttribute('aria-hidden',String(this.panel!=='shelf'));this.tools.setAttribute('aria-hidden',String(this.panel!=='tools'));
    // The backdrop stays on screen while a drawer slides away, then leaves with it.
    clearTimeout(this.backdropTimer);
    if(this.panel)this.backdrop.hidden=false;
    else if(!this.backdrop.hidden)this.backdropTimer=setTimeout(()=>{this.backdrop.hidden=true;},280);
    document.getElementById('shelf-reveal').setAttribute('aria-expanded',String(this.panel==='shelf'));
    document.getElementById('tools-reveal').setAttribute('aria-expanded',String(this.panel==='tools'));
  }
}

// Accumulate intentional taps while a page is rendering, instead of dropping them.
export class TurnQueue {
  constructor({page,total,step=()=>1,navigate}){Object.assign(this,{page,total,step,navigate});this.target=null;this.running=null;}
  turn(delta){
    this.target=Math.max(1,Math.min(this.total(),(this.target??this.page())+delta*this.step()));
    if(!this.running)this.running=Promise.resolve().then(async()=>{while(this.target!==null){const target=this.target;await this.navigate(target);if(this.target===target)this.target=null;}}).finally(()=>{this.running=null;this.target=null;});
    return this.running;
  }
}

export const fullscreenElement=()=>document.fullscreenElement||document.webkitFullscreenElement;
export async function requestScoreFullscreen(){
  if(fullscreenElement())return true;
  const root=document.documentElement,request=root.requestFullscreen||root.webkitRequestFullscreen;
  if(!request)return false;
  try{await request.call(root,{navigationUI:'hide'});return !!fullscreenElement();}catch{return false;}
}
export async function leaveScoreFullscreen(){
  const leave=document.exitFullscreen||document.webkitExitFullscreen;
  if(fullscreenElement()&&leave)await leave.call(document);
}
