export function performanceKey(event){
  if(event.ctrlKey||event.metaKey||event.altKey)return null;
  if(event.key==='Escape')return 'exit';
  const direction=['ArrowLeft','ArrowUp','PageUp'].includes(event.key)?-1:['ArrowRight','ArrowDown','PageDown',' '].includes(event.key)?1:null;
  return direction===null?null:event.repeat?'ignore':direction;
}

// Reject automatic turns queued before a manual correction, and allow time to settle.
export class ManualTurnGuard {
  constructor(now=()=>performance.now()){this.now=now;this.revision=0;this.until=0;}
  manual(){this.revision++;this.until=this.now()+2500;}
  permits(revision=this.revision){return revision===this.revision&&this.now()>=this.until;}
}

// Screen-only mode: no OS notification settings are changed or claimed.
export class PerformanceMode {
  constructor(effects){this.effects=effects;this.active=false;this.native=false;this.revision=0;this.lock=null;this.lockRevision=0;}
  async enter(){
    if(this.active)return;
    this.active=true;const revision=++this.revision;
    try{
      this.effects.activate();
      // Request synchronously from the entry click, before awaiting rendering.
      try{Promise.resolve(this.effects.fullscreen()).then(granted=>{
        if(this.active&&revision===this.revision)this.native=!!granted;
        else if(!this.active&&granted)Promise.resolve(this.effects.exitFullscreen()).catch(()=>{});
      }).catch(()=>{});}catch{}
      this.resume();
      await this.effects.render();
    }catch(error){if(this.active&&revision===this.revision)await this.exit();throw error;}
  }
  async exit(){
    if(!this.active)return;
    this.active=false;this.native=false;this.revision++;this.suspend();
    this.effects.deactivate();
    try{await this.effects.exitFullscreen();}catch{}
    await this.effects.stopFollowing?.();
    await this.effects.render();
  }
  resume(){
    if(!this.active||this.lock&&!this.lock.released)return;
    const revision=++this.lockRevision;
    try{Promise.resolve(this.effects.wakeLock()).then(lock=>{
      if(!this.active||revision!==this.lockRevision){Promise.resolve(lock?.release()).catch(()=>{});return;}
      this.lock=lock;
    }).catch(()=>{});}catch{}
  }
  suspend(){
    this.lockRevision++;const lock=this.lock;this.lock=null;
    try{Promise.resolve(lock?.release()).catch(()=>{});}catch{}
  }
}
