export class ScreenAwake{
  constructor({request,visible=()=>true}={}){this.request=request;this.visible=visible;this.sentinel=null;this.pending=null;}
  acquire(){
    if(!this.request||!this.visible()||this.sentinel&&!this.sentinel.released)return this.pending||Promise.resolve(this.sentinel);
    if(this.pending)return this.pending;
    this.pending=Promise.resolve().then(()=>this.request()).then(sentinel=>{
      if(!sentinel)return null;
      this.sentinel=sentinel;
      sentinel.addEventListener?.('release',()=>{if(this.sentinel===sentinel)this.sentinel=null;},{once:true});
      return sentinel;
    }).catch(()=>null).finally(()=>{this.pending=null;});
    return this.pending;
  }
  clear(){this.sentinel=null;}
  async release(){const sentinel=this.sentinel;this.sentinel=null;try{await sentinel?.release?.();}catch{}}
}

export function installScreenAwake({doc=globalThis.document,nav=globalThis.navigator}={}){
  const awake=new ScreenAwake({request:nav?.wakeLock?.request?()=>nav.wakeLock.request('screen'):null,visible:()=>doc?.visibilityState!=='hidden'});
  const acquire=()=>awake.acquire();
  acquire();
  // Safari can wait for a user gesture. Once held, these retries are no-ops.
  doc?.addEventListener?.('pointerdown',acquire,{capture:true,passive:true});
  doc?.addEventListener?.('keydown',acquire,true);
  doc?.addEventListener?.('visibilitychange',()=>{if(doc.visibilityState==='hidden')awake.clear();else acquire();});
  globalThis.addEventListener?.('pagehide',()=>awake.release(),{once:true});
  return awake;
}
