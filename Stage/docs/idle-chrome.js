// Floating controls fade to fully transparent while unused, so nothing covers the score during play.
export const IDLE_DELAY=2800,WAKE_THROTTLE=250;
export const CHROME_SELECTOR='.edge-reveal,.pencil-dock';

export class IdleChrome{
  constructor({show,hide,held=()=>false,delay=IDLE_DELAY,now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}={}){
    Object.assign(this,{show,hide,held,delay,now,setTimer,clearTimer});
    this.faded=false;this.timer=null;this.armed=-Infinity;this.arm();
  }
  arm(){
    if(this.timer!==null)this.clearTimer(this.timer);
    this.armed=this.now();
    this.timer=this.setTimer(()=>{
      this.timer=null;
      // A held control (open drawer, dialog, active pen, focus) stays on screen and waits again.
      if(this.held()){if(this.faded){this.faded=false;this.show();}this.arm();return;}
      if(!this.faded){this.faded=true;this.hide();}
    },this.delay);
  }
  wake(){
    if(this.faded){this.faded=false;this.show();this.arm();return;}
    // Continuous pointer movement must not restart the timer on every frame.
    if(this.timer===null||this.now()-this.armed>=WAKE_THROTTLE)this.arm();
  }
  // A tap on a faded control only brings it back; the button itself waits for the next tap.
  press(inside){
    if(!inside)return false;
    const reveal=this.faded;
    if(reveal){this.faded=false;this.show();}
    this.arm();
    return reveal;
  }
  hideNow(){
    if(this.timer!==null)this.clearTimer(this.timer);
    this.timer=null;
    if(!this.faded){this.faded=true;this.hide();}
  }
  stop(){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
}

export function installIdleChrome({isWriting=()=>false,...options}={}){
  const body=document.body;
  const held=()=>isWriting()||body.matches('.shelf-open,.tools-open')||!!document.querySelector('dialog[open]')
    ||!!document.querySelector('.pencil-dock.dragging,.pencil-dock details[open]');
  const chrome=new IdleChrome({show:()=>body.classList.remove('chrome-idle'),hide:()=>body.classList.add('chrome-idle'),held,...options});
  let swallow=false;
  document.addEventListener('pointerdown',event=>{
    swallow=chrome.press(!!event.target?.closest?.(CHROME_SELECTOR));
    if(swallow){event.preventDefault();event.stopPropagation();}
  },true);
  document.addEventListener('click',event=>{
    if(!swallow)return;
    swallow=false;event.preventDefault();event.stopPropagation();
  },true);
  // Taps on the score never wake the controls; a mouse, a key or focus does.
  document.addEventListener('pointermove',event=>{if(event.pointerType==='mouse')chrome.wake();},{capture:true,passive:true});
  document.addEventListener('keydown',()=>chrome.wake(),true);
  document.addEventListener('focusin',()=>chrome.wake(),true);
  // Give the dock a full quiet period after the Pencil leaves the paper. An already-hidden
  // dock remains hidden while the user continues writing on the score.
  document.addEventListener('pointerup',event=>{if(event.pointerType==='pen'&&!chrome.faded)chrome.arm();},true);
  return chrome;
}
