import test from 'node:test';
import assert from 'node:assert/strict';
import {viewportSize,homeScreenHeight,readerBoundaries,normalizeCalibration,calibratedViewport} from '../docs/reader-viewport.js';
import fs from 'node:fs/promises';
const ipad={frameWidth:1024,frameHeight:1366,innerWidth:1024,innerHeight:1334,clientHeight:1366,visual:{height:1334,scale:1}};
test('iPad fullscreen uses the full window, not a short dynamic/safe-area height',()=>{
  assert.deepEqual(viewportSize({...ipad,immersive:true}),{width:1024,height:1366});
  assert.deepEqual(viewportSize({...ipad,frameHeight:1334,immersive:true}),{width:1024,height:1366});
});
test('ordinary Safari respects visible browser controls and keyboard height',()=>{
  assert.deepEqual(viewportSize(ipad),{width:1024,height:1334});
  assert.deepEqual(viewportSize({...ipad,immersive:true,editing:true,visual:{height:790,scale:1}}),{width:1024,height:790});
});
test('Split View, rotation and desktop windows are never stretched to physical screen size',()=>{
  assert.deepEqual(viewportSize({...ipad,frameWidth:507,frameHeight:1000,innerWidth:507,innerHeight:1000,clientHeight:1000,visual:{height:1000,scale:1},immersive:true}),{width:507,height:1000});
  assert.deepEqual(viewportSize({...ipad,frameWidth:1366,frameHeight:1024,innerWidth:1366,innerHeight:1024,clientHeight:1024,visual:{height:1024,scale:1},immersive:true}),{width:1366,height:1024});
});
test('pinch zoom and transient zero measurements do not resize or blank the score',()=>{
  assert.equal(viewportSize({...ipad,visual:{height:683,scale:2}}),null);
  assert.equal(viewportSize({frameHeight:0,frameWidth:0}),null);
  assert.deepEqual(viewportSize({innerWidth:1280,innerHeight:720}),{width:1280,height:720});
});

test('12.9-inch iPad Home Screen cold launch fills a shared 32px or 54px under-report',()=>{
  for(const missing of [0,20,32,54,64]){
    const height=1366-missing;
    assert.deepEqual(viewportSize({...ipad,frameHeight:height,innerHeight:height,clientHeight:height,visual:{height,scale:1},immersive:true,ipadStandalone:true,screenWidth:1024,screenHeight:1366}),{width:1024,height:1366});
  }
});
test('Home Screen rotation accepts both fixed and orientation-aware screen dimensions',()=>{
  const landscape={frameWidth:1366,frameHeight:992,innerWidth:1366,innerHeight:992,clientHeight:992,visual:{height:992,scale:1},immersive:true,ipadStandalone:true};
  assert.deepEqual(viewportSize({...landscape,screenWidth:1024,screenHeight:1366}),{width:1366,height:1024});
  assert.deepEqual(viewportSize({...landscape,screenWidth:1366,screenHeight:1024}),{width:1366,height:1024});
});
test('Home Screen compensation does not expand smaller windows, editing or a keyboard-sized gap',()=>{
  const device={ipadStandalone:true,screenWidth:1024,screenHeight:1366};
  assert.equal(homeScreenHeight(507,1334,device),1334);
  assert.equal(homeScreenHeight(980,1290,device),1290);
  assert.equal(homeScreenHeight(1024,1100,device),1100);
  assert.equal(homeScreenHeight(1024,790,device),790);
  assert.equal(homeScreenHeight(1024,1334,{...device,editing:true}),1334);
  assert.equal(homeScreenHeight(1024,1334,{...device,ipadStandalone:false}),1334);
});
test('Home Screen shell starts before the PDF app and has matching launch/background colours',async()=>{
  const root=new URL('../docs/',import.meta.url),html=await fs.readFile(new URL('index.html',root),'utf8');
  const css=await fs.readFile(new URL('reader.css',root),'utf8'),manifest=JSON.parse(await fs.readFile(new URL('manifest.webmanifest',root),'utf8'));
  assert.ok(html.indexOf('src="./reader-start.js"')<html.indexOf('src="./app.js"'));
  assert.ok(html.indexOf("classList.toggle('home-screen'")<html.indexOf('rel="stylesheet"'));
  assert.equal(manifest.background_color,'#10151d');assert.match(css,/:root\.home-screen\{--reader-background:#10151d;/);
  assert.match(css,/html\.home-screen body\.focus-reader\{[^}]*height:var\(--reader-height\)/);
  assert.match(html,/屏幕适配诊断 · v6/);
});
test('Home Screen shell and controls are document anchored instead of viewport fixed',async()=>{
  const css=await fs.readFile(new URL('../docs/reader.css',import.meta.url),'utf8');
  assert.match(css,/html\.home-screen\{position:relative;[^}]*height:var\(--reader-height\)/);
  assert.match(css,/html\.home-screen body\.focus-reader\{position:relative;inset:auto;/);
  assert.match(css,/html\.home-screen body\.focus-reader\.performance-mode \.reader\{position:absolute\}/);
  assert.match(css,/html\.home-screen body\.focus-reader \.pencil-dock,[\s\S]*?\.toast\{position:absolute\}/);
});
test('Home Screen diagnostic distinguishes the requested height from clipping at the real bottom',()=>{
  const bounds={'html':1366,'body':1366,'.reader':1366,'#score-stage':1334};
  const doc={querySelector:s=>({getBoundingClientRect:()=>({top:0,bottom:bounds[s]})}),elementFromPoint:()=>null};
  const report=readerBoundaries(doc,{width:1024,height:1366});
  assert.match(report,/文档：0 → 1366/);assert.match(report,/阅谱区：0 → 1334/);assert.match(report,/底边命中：窗口之外/);
});
test('Home Screen calibration accepts only finite bounded offsets and can be disabled while typing',()=>{
  assert.deepEqual(normalizeCalibration({portrait:Infinity,landscape:'40'}),{portrait:0,landscape:0});
  assert.deepEqual(normalizeCalibration({portrait:400,landscape:-100}),{portrait:80,landscape:-80});
  assert.equal(calibratedViewport({width:1024,height:1366},{portrait:32},true).height,1398);
  assert.equal(calibratedViewport({width:1024,height:1366},{portrait:32},false).height,1366);
});
