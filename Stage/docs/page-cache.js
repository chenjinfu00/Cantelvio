import {fitLayout} from './fit-layout.js';
const aborted=()=>new DOMException('Render superseded','AbortError');
export function pageDimensions(natural,metrics){
  const widthScale=metrics.width/natural.width,heightScale=metrics.height/natural.height;
  // Cover the reading area, not merely its width. Wider pages must grow until
  // their height reaches the screen; the reader clips the excess equally left/right.
  const scale=(metrics.fit==='screen'&&!metrics.protectFit?Math.max(widthScale,heightScale):Math.min(widthScale,heightScale))*metrics.zoom;
  return {width:natural.width*scale,height:natural.height*scale};
}
export function adjacentPages(page,total,spread=false){
  const step=spread?2:1,shown=new Set(spread?[page,page+1]:[page]);
  return [...new Set([page+step,...(spread?[page+step+1]:[]),page-1])].filter(p=>p>=1&&p<=total&&!shown.has(p));
}

// Retain only a few rasterized pages, never the entire score. Visible canvases
// are pinned until their replacement is ready, so a cache miss does not blank it.
export class PageRenderCache {
  constructor(render,{maxEntries=5,maxPixels=14_000_000,dispose=value=>{value.canvas.width=0;value.canvas.height=0;}}={}){
    this.render=render;this.maxEntries=maxEntries;this.maxPixels=maxPixels;this.dispose=dispose;this.entries=new Map();this.pinned=new Set();
  }
  key(page,metrics){return page+':'+JSON.stringify(metrics);}
  pin(keys){this.pinned=new Set(keys);this.trim();}
  has(page,metrics){return !!this.entries.get(this.key(page,metrics))?.value;}
  peek(page,metrics){return this.entries.get(this.key(page,metrics))?.value;}
  get(page,metrics){
    const key=this.key(page,metrics),cached=this.entries.get(key);
    if(cached){this.entries.delete(key);this.entries.set(key,cached);return cached.promise;}
    const entry={controller:new AbortController()};this.entries.set(key,entry);
    entry.promise=Promise.resolve().then(()=>this.render(page,metrics,entry.controller.signal)).then(value=>{
      if(entry.controller.signal.aborted||this.entries.get(key)!==entry){this.dispose(value);throw aborted();}
      entry.value=value;this.trim();return value;
    }).catch(error=>{if(this.entries.get(key)===entry)this.entries.delete(key);throw error;});
    return entry.promise;
  }
  prioritize(keys){
    const wanted=new Set(keys);
    for(const [key,entry] of this.entries)if(!entry.value&&!wanted.has(key)){entry.controller.abort();this.entries.delete(key);}
  }
  trim(){
    let pixels=[...this.entries.values()].reduce((sum,e)=>sum+(e.value?.pixels||0),0);
    for(const [key,entry] of this.entries){
      if(this.entries.size<=this.maxEntries&&pixels<=this.maxPixels)break;
      if(!entry.value||this.pinned.has(key))continue;
      this.entries.delete(key);pixels-=entry.value.pixels||0;this.dispose(entry.value);
    }
  }
  clear(){for(const entry of this.entries.values()){entry.controller.abort();if(entry.value)this.dispose(entry.value);}this.entries.clear();this.pinned.clear();}
}

export async function renderScorePage(pdf,page,metrics,signal){
  const source=await pdf.getPage(page);if(signal.aborted)throw aborted();
  const natural=source.getViewport({scale:1});
  const {width:cssWidth,height:cssHeight,clip}=fitLayout(natural,metrics,metrics.bounds);
  const density=Math.min(metrics.density,Math.sqrt(4_000_000/(cssWidth*cssHeight)));
  const viewport=source.getViewport({scale:cssWidth/natural.width*density});
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  // CSS geometry follows the PDF exactly, independent of rounded raster pixels.
  canvas.style.width=cssWidth+'px';canvas.style.height=cssHeight+'px';canvas.setAttribute('aria-label',`PDF 第 ${page} 页`);
  const task=source.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport});
  const cancel=()=>task.cancel();signal.addEventListener('abort',cancel,{once:true});
  try{await task.promise;if(signal.aborted)throw aborted();return {canvas,cssWidth,cssHeight,clip,pixels:canvas.width*canvas.height};}
  catch(error){canvas.width=0;canvas.height=0;if(signal.aborted)throw aborted();throw error;}
  finally{signal.removeEventListener('abort',cancel);source.cleanup();}
}
