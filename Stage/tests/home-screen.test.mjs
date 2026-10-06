import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=(await fs.readFile(new URL('../docs/reader-viewport.js',import.meta.url),'utf8')).replaceAll('export function ','function ');
function homeScreen({home=true}={}){
  const model={home,width:1024,height:1334,screenWidth:1024,screenHeight:1366,hidden:false,editing:false};
  const styles=new Map(),classes=new Set(),frames=new Map(),timers=new Map(),appended=[];let next=0;
  const target=()=>({events:new Map(),addEventListener(name,fn){const list=this.events.get(name)||[];list.push(fn);this.events.set(name,list);},fire(name){for(const fn of this.events.get(name)||[])fn();}});
  const root={get clientHeight(){return model.height;},style:{setProperty:(name,value)=>styles.set(name,value)},classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}};
  const diagnostics={textContent:''},refresh=target(),adjust=Object.assign(target(),{value:'0'}),reset=target(),output={textContent:''},storage=new Map();
  const bottom=()=>Number.parseFloat(styles.get('--reader-height'))||model.height;
  const base={getBoundingClientRect:()=>({top:0,bottom:bottom()})};
  const canvas={tagName:'CANVAS',getAttribute:()=>null};
  const document=Object.assign(target(),{
    documentElement:root,activeElement:{matches:()=>model.editing},
    body:{append:node=>appended.push(node)},getElementById:id=>({'viewport-diagnostics':diagnostics,'viewport-refresh':refresh,'screen-height-adjust':adjust,'screen-height-reset':reset,'screen-height-value':output}[id]),
    querySelector:()=>base,elementFromPoint:(_x,y)=>y<bottom()?canvas:null,
    createElement:()=>({setAttribute(){},getBoundingClientRect:()=>({width:model.width,height:model.height})}),
  });
  Object.defineProperty(document,'hidden',{get:()=>model.hidden});
  const visual=Object.assign(target(),{scale:1,offsetTop:0});Object.defineProperty(visual,'height',{get:()=>model.height});
  const screen={};Object.defineProperties(screen,{width:{get:()=>model.screenWidth},height:{get:()=>model.screenHeight}});
  const window=Object.assign(target(),{visualViewport:visual,screen});Object.defineProperties(window,{innerWidth:{get:()=>model.width},innerHeight:{get:()=>model.height}});
  const navigator={platform:'MacIntel',maxTouchPoints:5,userAgent:'Mozilla/5.0 (Macintosh)'};Object.defineProperty(navigator,'standalone',{get:()=>model.home});
  const context={document,window,navigator,matchMedia:query=>({matches:query.includes('standalone')&&model.home}),localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    requestAnimationFrame:fn=>{frames.set(++next,fn);return next;},setTimeout:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},clearTimeout:id=>timers.delete(id),
    ResizeObserver:class{observe(){}},};
  vm.createContext(context);vm.runInContext(source+'\nglobalThis.controller=installReaderViewport();',context);
  const drainFrames=()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn();}};
  const settle=()=>{for(const [id,{fn}] of [...timers]){timers.delete(id);fn();}drainFrames();};
  return {model,styles,classes,frames,timers,appended,document,window,diagnostics,refresh,adjust,reset,output,storage,context,drainFrames,settle};
}

test('Home Screen cold startup initializes before app, fills the short window, and installs only once',()=>{
  const h=homeScreen();
  assert.equal(h.styles.get('--reader-height'),'1366px');assert.equal(h.styles.get('--reader-width'),'1024px');
  assert.equal(h.classes.has('home-screen'),true);assert.match(h.diagnostics.textContent,/高度补偿：32 px/);
  assert.equal(h.appended.length,1);assert.equal(h.timers.size,4);
  vm.runInContext('installReaderViewport()',h.context);assert.equal(h.appended.length,1);
  assert.equal(h.window.events.get('resize').length,1);h.settle();assert.equal(h.timers.size,0);assert.equal(h.frames.size,0);
});
test('Home Screen cold startup rechecks when iPad reports standalone late',()=>{
  const h=homeScreen({home:false});assert.equal(h.styles.get('--reader-height'),'1334px');
  h.model.home=true;h.settle();assert.equal(h.styles.get('--reader-height'),'1366px');assert.equal(h.classes.has('home-screen'),true);
});
test('Home Screen foreground return and rotation remeasure the iPad window',()=>{
  const h=homeScreen();h.settle();h.model.hidden=true;h.document.fire('visibilitychange');assert.equal(h.timers.size,0);
  h.model.width=1366;h.model.height=992;h.model.hidden=false;h.document.fire('visibilitychange');
  assert.equal(h.styles.get('--reader-width'),'1366px');assert.equal(h.styles.get('--reader-height'),'1024px');
  h.model.width=1024;h.model.height=1334;h.window.fire('orientationchange');
  assert.equal(h.styles.get('--reader-height'),'1366px');h.settle();
  h.refresh.fire('click');assert.equal(h.timers.size,4);assert.match(h.context.controller.report(),/主屏幕适配 v6/);
});
test('Home Screen bottom adjustment is live, bounded, orientation-specific and reversible',()=>{
  const h=homeScreen();h.settle();
  h.adjust.value='16';h.adjust.fire('input');assert.equal(h.styles.get('--reader-height'),'1382px');assert.match(h.diagnostics.textContent,/手动 16 px/);
  // Even if clientHeight echoes our explicit CSS, repeated measurement is stable.
  Object.defineProperty(h.document.documentElement,'clientHeight',{get:()=>Number.parseFloat(h.styles.get('--reader-height')),configurable:true});
  h.settle();h.refresh.fire('click');h.settle();assert.equal(h.styles.get('--reader-height'),'1382px');
  h.model.width=1366;h.model.height=992;h.window.fire('orientationchange');assert.equal(h.styles.get('--reader-height'),'1024px');assert.equal(h.adjust.value,'0');
  h.adjust.value='-12';h.adjust.fire('input');assert.equal(h.styles.get('--reader-height'),'1012px');
  h.model.width=1024;h.model.height=1334;h.window.fire('orientationchange');assert.equal(h.styles.get('--reader-height'),'1382px');
  h.reset.fire('click');assert.equal(h.styles.get('--reader-height'),'1366px');assert.match([...h.storage.values()][0],/"landscape":-12/);
  h.adjust.value='10000';h.adjust.fire('input');assert.equal(h.styles.get('--reader-height'),'1446px');
});
test('Home Screen runtime stops compensation in a smaller window, during typing and during pinch',()=>{
  const h=homeScreen();h.settle();h.model.width=507;h.model.height=1000;h.window.fire('resize');h.drainFrames();
  assert.equal(h.styles.get('--reader-width'),'507px');assert.equal(h.styles.get('--reader-height'),'1000px');
  h.model.width=1024;h.model.height=790;h.model.editing=true;h.window.fire('resize');h.drainFrames();
  assert.equal(h.styles.get('--reader-height'),'790px');
  h.model.height=1334;h.model.editing=false;h.document.fire('focusout');assert.equal(h.styles.get('--reader-height'),'1366px');h.settle();
  h.window.visualViewport.scale=2;h.model.height=683;h.window.fire('resize');h.drainFrames();assert.equal(h.styles.get('--reader-height'),'1366px');
});
