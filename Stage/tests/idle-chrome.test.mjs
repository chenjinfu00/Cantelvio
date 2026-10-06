import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {IdleChrome,WAKE_THROTTLE} from '../docs/idle-chrome.js';

function harness(options={}){
  const log=[];let fire=null,id=0,time=0,clears=0;
  const chrome=new IdleChrome({
    show:()=>log.push('show'),hide:()=>log.push('hide'),now:()=>time,
    setTimer:fn=>{fire=fn;return ++id;},clearTimer:()=>{clears++;},...options});
  return {chrome,log,idle:()=>fire(),wait:ms=>{time+=ms;},clears:()=>clears};
}

test('unused controls fade to fully transparent and come back when woken',()=>{
  const h=harness();
  assert.deepEqual(h.log,[]);
  h.idle();assert.deepEqual(h.log,['hide']);assert.equal(h.chrome.faded,true);
  h.chrome.wake();assert.deepEqual(h.log,['hide','show']);
  h.wait(WAKE_THROTTLE);h.idle();assert.deepEqual(h.log,['hide','show','hide']);
});

test('a tap on a faded control only reveals it; the button waits for the next tap',()=>{
  const h=harness();
  h.idle();
  assert.equal(h.chrome.press(true),true,'first tap is swallowed');
  assert.deepEqual(h.log,['hide','show']);
  assert.equal(h.chrome.press(true),false,'the control now works normally');
});

test('taps on the score never bring the controls back',()=>{
  const h=harness();
  h.idle();
  assert.equal(h.chrome.press(false),false);
  assert.deepEqual(h.log,['hide']);
  assert.equal(h.chrome.faded,true);
});

test('the explicit hide action immediately tucks every floating control away',()=>{
  const h=harness();h.chrome.hideNow();
  assert.deepEqual(h.log,['hide']);assert.equal(h.chrome.faded,true);
  h.chrome.hideNow();assert.deepEqual(h.log,['hide'],'repeated hides are harmless');
  h.chrome.wake();assert.deepEqual(h.log,['hide','show']);
});

test('open drawers, dialogs and an active pen keep the controls on screen',()=>{
  let held=true;const h=harness({held:()=>held});
  h.idle();assert.deepEqual(h.log,[]);
  h.idle();assert.deepEqual(h.log,[],'still held, still waiting');
  held=false;h.idle();assert.deepEqual(h.log,['hide']);
  held=true;h.chrome.wake();h.wait(WAKE_THROTTLE);h.idle();
  assert.deepEqual(h.log,['hide','show'],'a held control returns to view instead of fading');
});

test('continuous mouse movement does not restart the timer on every frame',()=>{
  const h=harness();
  h.chrome.wake();h.chrome.wake();h.chrome.wake();
  assert.equal(h.clears(),0,'throttled wakes reuse the armed timer');
  h.wait(WAKE_THROTTLE);h.chrome.wake();
  assert.equal(h.clears(),1);
  h.idle();h.chrome.wake();
  assert.equal(h.chrome.faded,false);
  h.wait(WAKE_THROTTLE);h.idle();assert.equal(h.chrome.faded,true);
});

test('the reader installs the idle chrome and styles both the edge handles and the pencil dock',async()=>{
  const shell=await fs.readFile(new URL('../docs/reader-shell.js',import.meta.url),'utf8');
  assert.match(shell,/installIdleChrome\(\{isWriting:writing\}\)/);
  assert.match(shell,/getElementById\('chrome-hide'\)/);
  const css=await fs.readFile(new URL('../docs/reader.css',import.meta.url),'utf8');
  assert.match(css,/body\.chrome-idle \.edge-reveal,body\.chrome-idle \.pencil-dock\{opacity:0/);
  assert.doesNotMatch(css,/body\.chrome-idle \.pencil-dock:has\(\.pencil-tool\.selected\)/,'a selected pen must still fade after inactivity');
  assert.match(css,/body\.chrome-idle \.shelf-reveal\{transform:translateX\(calc\(-100% - 8px\)\)\}/,'the handle tucks behind its edge');
  assert.match(css,/body\.chrome-idle \.shelf-reveal::after\{left:100%/,'and keeps a hit area on that edge');
  assert.match(css,/body\.chrome-idle \.pencil-dock\[data-side=right\]::after\{right:100%/);
  const manifest=JSON.parse(await fs.readFile(new URL('../docs/cache-manifest.json',import.meta.url),'utf8'));
  assert.ok(manifest.includes('./idle-chrome.js'),'offline caches the new module');
});

test('installed handlers swallow the revealing tap, ignore score taps and follow a mouse',async()=>{
  const {installIdleChrome}=await import('../docs/idle-chrome.js');
  const listeners=new Map();const classes=new Set();let fire=null;
  const fakeDocument={
    body:{classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},matches:()=>false},
    querySelector:()=>null,activeElement:null,
    addEventListener:(type,handler)=>{listeners.set(type,handler);},
  };
  const original=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{value:fakeDocument,configurable:true});
  try{
    installIdleChrome({setTimer:fn=>{fire=fn;return 1;},clearTimer(){},now:()=>0});
    fire();assert.ok(classes.has('chrome-idle'),'controls fade while nothing happens');
    const tap=inside=>{let stopped=0;const event={target:{closest:()=>inside?{}:null},preventDefault:()=>stopped++,stopPropagation:()=>stopped++};listeners.get('pointerdown')(event);return stopped;};
    assert.equal(tap(false),0,'a tap on the score passes straight through');
    assert.ok(classes.has('chrome-idle'));
    assert.equal(tap(true),2,'the first tap on a faded control is swallowed');
    assert.equal(classes.has('chrome-idle'),false);
    assert.equal(tap(true),0,'the control then behaves normally');
    fire();assert.ok(classes.has('chrome-idle'));
    listeners.get('pointermove')({pointerType:'touch'});assert.ok(classes.has('chrome-idle'),'a finger on the page keeps them hidden');
    listeners.get('pointermove')({pointerType:'mouse'});assert.equal(classes.has('chrome-idle'),false);
    listeners.get('pointerup')({pointerType:'pen'});assert.equal(classes.has('chrome-idle'),false,'lifting the Pencil only rearms the timeout');
  }finally{if(original)Object.defineProperty(globalThis,'document',original);else delete globalThis.document;}
});
