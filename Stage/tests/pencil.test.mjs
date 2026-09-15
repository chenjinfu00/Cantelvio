import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PencilInput,strokeID} from '../docs/pencil-input.js';
import {Ink} from '../docs/ink.js';
import {pageDimensions} from '../docs/page-cache.js';
const pen=(x=100,y=200)=>({pointerId:1,pointerType:'pen',button:0,clientX:x,clientY:y,pressure:.5,preventDefault(){},stopPropagation(){}});

test('stroke IDs work without the HTTPS-only randomUUID API',()=>{
  let byte=0;const insecure={getRandomValues:array=>{for(let i=0;i<array.length;i++)array[i]=byte++%256;return array;}};
  const a=strokeID(insecure),b=strokeID(insecure);assert.notEqual(a,b);assert.match(a,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(strokeID(null),strokeID(null));
});
test('Pencil hold switches only once, cancels its mark, and requires lifting before drawing again',()=>{
  const events=[],timers=new Map();let next=0;
  const input=new PencilInput({allowed:()=>true,begin:()=>events.push('begin'),move:()=>events.push('move'),commit:()=>events.push('commit'),cancel:()=>events.push('cancel'),toggle:()=>events.push('toggle')},{setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)});
  input.down(pen());timers.get(1)();input.move(pen(180,240));input.end(pen());assert.deepEqual(events,['begin','cancel','toggle']);
  input.down(pen());input.move(pen(180,240));assert.equal(timers.has(2),false);input.end(pen());assert.deepEqual(events.slice(3),['begin','move','commit']);
});
test('movement rearms a full one-second dwell and preserves writing before a hold',()=>{
  let commits=0,toggles=0,cancels=0,timer,clears=0;
  const input=new PencilInput({allowed:()=>true,begin(){},move(){},commit:()=>commits++,cancel:()=>cancels++,toggle:()=>toggles++},{setTimer:(fn,ms)=>{assert.equal(ms,1000);timer=fn;return 1;},clearTimer:()=>clears++});
  assert.equal(input.down({...pen(),pointerType:'touch'}),false);input.down(pen());
  const initial=timer;input.move({...pen(),getCoalescedEvents:()=>[pen(120,220),pen(140,240)]});assert.ok(clears>0);assert.notEqual(initial,timer);
  const stationary=timer;input.move(pen(144,243));assert.equal(timer,stationary,'small tip jitter must not postpone forever');
  timer();assert.equal(commits,1);assert.equal(toggles,1);assert.equal(cancels,0);input.move(pen(300,400));input.end(pen());assert.equal(commits,1);assert.equal(toggles,1);
});

test('real ink handlers auto-select Pencil, persist strokes, erase, undo and ignore fingers on HTTP-like globals',async()=>{
  const originals=new Map(['document','window','requestAnimationFrame','crypto'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const nodes=new Map(),drafts=new Map(),timers=new Map();let timerId=0,ink;
  class Element {
    constructor(){this.handlers={};this.children=[];this.classList={toggle(){}};this.style={setProperty(){}};this.width=1000;this.height=1400;this.isConnected=true;}
    addEventListener(name,fn){(this.handlers[name]??=[]).push(fn);}
    fire(name,event){for(const fn of this.handlers[name]||[])fn(event);}
    setAttribute(){} setPointerCapture(){} remove(){} append(node){this.children.push(node);}
    getBoundingClientRect(){return {left:0,top:0,width:1000,height:1400};}
    querySelector(){return this.base;}
    getContext(){return {clearRect(){},beginPath(){},arc(){},fill(){},moveTo(){},lineTo(){},stroke(){}};}
  }
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:node,createElement:()=>new Element(),querySelectorAll:()=>[]}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener(){}}});
  Object.defineProperty(globalThis,'requestAnimationFrame',{configurable:true,value:fn=>{fn();return 1;}});
  let byte=0;Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:array=>{array.forEach((_,i)=>array[i]=byte++%256);return array;}}});
  try{
    ink=new Ink(()=>{}, {localOnly:true,draft:async(id,value)=>{if(value!==undefined)drafts.set(id,structuredClone(value));return drafts.get(id);},inputOptions:{setTimer:fn=>{timers.set(++timerId,fn);return timerId;},clearTimer:id=>timers.delete(id)}});
    ink.setScore('test-score');const sheet=new Element();sheet.base=new Element();await ink.attach(sheet,1);const canvas=sheet.children[0],record=await ink.record('test-score',1);
    assert.equal(ink.mode,'read');canvas.fire('pointerdown',pen());assert.equal(ink.mode,'pen');assert.equal(ink.guardingTouch,true);
    canvas.fire('pointermove',pen(200,240));canvas.fire('pointerup',pen(200,240));await ink.flush(record);
    assert.equal(record.data.strokes.length,1);assert.equal(drafts.get('test-score/1').data.strokes.length,1);
    canvas.fire('pointerdown',{...pen(),pointerType:'touch'});canvas.fire('pointerup',{...pen(),pointerType:'touch'});assert.equal(record.data.strokes.length,1);
    canvas.fire('pointerdown',pen(800,900));timers.get(timerId)();assert.equal(ink.mode,'erase');canvas.fire('pointerup',pen(800,900));assert.equal(record.data.strokes.length,1);
    canvas.fire('pointerdown',pen());canvas.fire('pointermove',pen(200,240));canvas.fire('pointerup',pen(200,240));assert.equal(record.data.strokes.length,0);
    ink.history(false);assert.equal(record.data.strokes.length,1);ink.history(true);assert.equal(record.data.strokes.length,0);
    ink.setMode('pen');canvas.fire('pointerdown',pen());canvas.fire('pointercancel',pen());assert.equal(record.data.strokes.length,0);assert.equal(ink.penDown,false);
    await ink.flush(record);assert.equal(drafts.get('test-score/1').data.strokes.length,0);
    ink.setScore('pause-after-writing');const secondSheet=new Element();secondSheet.base=new Element();await ink.attach(secondSheet,1);
    const secondCanvas=secondSheet.children[0],secondRecord=await ink.record('pause-after-writing',1);
    secondCanvas.fire('pointerdown',pen());secondCanvas.fire('pointermove',pen(250,280));timers.get(timerId)();
    assert.equal(ink.mode,'erase');assert.equal(secondRecord.data.strokes.length,1,'pausing must keep the completed writing');
    secondCanvas.fire('pointerup',pen(250,280));await ink.flush(secondRecord);assert.equal(drafts.get('pause-after-writing/1').data.strokes.length,1);
  }finally{
    if(ink){ink.clearViews();clearTimeout(ink.feedbackTimer);for(const record of ink.records.values())clearTimeout(record.timer);}
    for(const [key,descriptor] of originals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
  }
});

test('fit screen covers both axes proportionally; full-page mode contains all edges',()=>{
  const a4={width:210,height:297},viewport={width:1024,height:1366,zoom:1};
  const fill=pageDimensions(a4,{...viewport,fit:'screen'});assert.equal(fill.width,1024);assert.ok(fill.height>1366);assert.equal(fill.width/fill.height,210/297);
  const contain=pageDimensions(a4,{...viewport,fit:'page'});assert.equal(contain.height,1366);assert.ok(contain.width<1024);
  const short=pageDimensions({width:800,height:1000},{...viewport,fit:'screen'});assert.ok(short.width>1024);assert.equal(short.height,1366);assert.ok(Math.abs(short.width/short.height-.8)<1e-12);
  // The reported iPad case: paper wider than the screen must overflow equally
  // at the sides, not leave an 86px gap above or below the page.
  assert.ok(Math.abs((short.width-viewport.width)/2-34.4)<1e-9);
  for(const paper of [a4,{width:800,height:1000},{width:4,height:3}])for(const area of [{width:1024,height:1366},{width:1366,height:1024},{width:768,height:1180}]){
    const covered=pageDimensions(paper,{...area,zoom:1,fit:'screen'});
    assert.ok(covered.width>=area.width-1e-9);assert.ok(covered.height>=area.height-1e-9);
    assert.ok(Math.abs(covered.width/covered.height-paper.width/paper.height)<1e-12);
  }
});
test('drawer roles stay separate and the paper has pen/eraser without a peer reading toggle',async()=>{
  const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="ink-read"/);assert.match(html,/class="pencil-dock"/);assert.match(html,/id="practice-drawer"/);assert.match(html,/<option value="screen">适配屏幕<\/option>/);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,new Set(ids).size);
});
