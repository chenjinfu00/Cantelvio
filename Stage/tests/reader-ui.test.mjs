import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {strokeWidth,eraserRadius} from '../docs/ink.js';
import {validateInk} from '../docs/ink-validation.js';

const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
const shell=await fs.readFile(new URL('../docs/reader-shell.js',import.meta.url),'utf8');

test('the shelf is for changing score, the top drawer is about the score you have open',()=>{
  for(const moved of ['#edition-toolbar','.reader-toolbar','.page-navigation','#practice-drawer'])
    assert.ok(shell.includes("'"+moved+"'"),moved+' moved into the top drawer');
  assert.ok(!shell.includes("'#score-card'"),'the current-score card stays on the shelf instead of repeating in the top drawer');
  assert.doesNotMatch(html,/drawer-eyebrow[^>]*>阅谱/,'the open score title needs no extra heading');
  assert.match(html,/id="reader-title">尚未打开曲谱<\/strong><span id="reader-meta">/,'the drawer presents score title and compact metadata directly');
  const sidebar=html.slice(html.indexOf('<aside class="sidebar"'),html.indexOf('<main'));
  for(const keep of ['library-button','import-button','recent-scores'])assert.ok(sidebar.includes(keep),keep+' stays on the shelf');
});

test('bookmarks and automatic turning are compact disclosure rows',()=>{
  assert.match(html,/<details id="bookmark-bar"[^>]*>[\s\S]*?<summary><span>☆ 书签<\/span>/);
  assert.match(html,/<details id="practice-drawer"[^>]*><summary><span>自动翻页<\/span>/);
  assert.doesNotMatch(html,/学习演奏，然后跟随你|先选一种方式，边听边标记翻页点/);
});

test('the top drawer turns pages with a slider instead of buttons that repeat a tap',async()=>{
  assert.match(html,/id="page-range" type="range"/);
  const toolbar=html.slice(html.indexOf('<div class="reader-toolbar">'),html.indexOf('<section id="edition-toolbar"'));
  assert.ok(toolbar.includes('id="page-range"'),'the page slider lives in the same row as the score controls');
  assert.match(html,/id="page-range"[^>]*aria-label="拖动快速翻页"/,'the icon-first toolbar remains accessible');
  const css=await fs.readFile(new URL('../docs/reader.css',import.meta.url),'utf8');
  assert.match(css,/\.top-drawer \.reader-toolbar\{display:flex;flex-wrap:nowrap/,'the controls stay on one line');
  assert.match(css,/\.top-drawer \.reader-mode-actions\{width:auto/,'the mobile 100% action width is neutralized');
  assert.match(css,/\.top-drawer #page-range::-webkit-slider-thumb/,'the slider has a custom touch thumb');
  assert.match(css,/\.top-drawer \.page-navigation\{display:none\}/,'the spare navigation row is hidden outside performance mode');
  assert.match(html,/id="prev-button"/,'performance mode still has its big buttons');
});

test('temporary PDF entry points share a session-only import flow',async()=>{
  const app=await fs.readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  assert.match(html,/id="import-button"[^>]*>.*?临时打开 PDF/);
  assert.match(html,/id="imslp-upload"/);
  assert.match(html,/id="url-import"/);
  assert.ok(app.includes("openPDF(await file.arrayBuffer(),file.name,null,undefined,{temporary:true})"));
  assert.ok(app.includes("openPDF(data,decodeURIComponent(url.pathname.split('/').pop())||'IMSLP 曲谱',null,undefined,{temporary:true})"));
  assert.match(app,/if\(!state\.score\|\|state\.score\.temporary\)return/,'temporary PDFs never enter the score database');
  assert.match(app,/if\(!temporary&&!state\.score\.system\)recent\?\.remember/,'temporary PDFs do not enter recent history');
  const offline=await fs.readFile(new URL('../docs/offline.js',import.meta.url),'utf8');
  assert.match(offline,/score\.temporary\|\|local/,'temporary PDFs are excluded from offline copies');
  assert.doesNotMatch(offline,/autoOffline/,'no background import copy is made');
});

test('dialog close buttons stay available while dialog content scrolls',async()=>{
  const css=await fs.readFile(new URL('../docs/reader.css',import.meta.url),'utf8');
  assert.match(css,/dialog \.dialog-close\{position:sticky!important/);
  assert.match(css,/dialog \.dialog-close\{[^}]*top:8px[^}]*width:40px[^}]*border-radius:50%/,'the close control stays pinned as a compact top-right button');
  assert.doesNotMatch(css,/dialog \.dialog-close\{[^}]*width:100%/,'the close control does not cover the dialog header');
});

test('a stroke width from the slider is always one the validator accepts',()=>{
  for(const step of [1,2,5,10]){
    const width=strokeWidth(step);
    assert.ok(width>0&&width<=.1,'step '+step+' is in range');
    assert.equal(validateInk({version:1,strokes:[{id:'s'+step,color:'#2858aa',width,points:[[0,0,.5],[1,1,.5]]}]}),true);
  }
  assert.ok(strokeWidth(10)>strokeWidth(1),'the slider gets thicker to the right');
  assert.equal(strokeWidth(2),.0024,'the middle of the scale keeps the old default');
  assert.equal(strokeWidth(0),strokeWidth(1),'out-of-range values clamp');
  assert.equal(strokeWidth('nonsense'),strokeWidth(1));
  assert.ok(eraserRadius(10)>eraserRadius(1)&&eraserRadius(1)>0);
});

test('the pencil dock carries annotation actions and an icon-only hide-all action',()=>{
  const dock=html.slice(html.indexOf('id="ink-toolbar"'),html.indexOf('id="score-stage"'));
  for(const id of ['ink-undo','ink-redo','ink-width','eraser-width'])assert.ok(dock.includes('id="'+id+'"'),id+' is in the dock');
  assert.ok(dock.includes('data-ink-color'),'colours are swatches, not a dropdown');
  assert.ok(!dock.includes('id="ink-color"'),'the old colour dropdown is gone');
  assert.ok(!dock.includes('id="ink-export"'),'exporting is not a writing tool');
  assert.ok(dock.indexOf('id="ink-save"')>dock.indexOf('id="erase-options"'),'export stays below the writing controls');
  assert.ok(dock.indexOf('id="chrome-hide"')>dock.indexOf('id="ink-save"'),'hide all is the final dock action');
  for(const [,text] of dock.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g))assert.doesNotMatch(text,/[\u3400-\u9fff]/,'the dock uses icons, not visible text labels');
  const settings=html.slice(html.indexOf('id="settings-dialog"'));
  assert.ok(settings.includes('id="ink-folder-status"'),'settings reports annotation sync status');
  for(const id of ['ink-folder-save','ink-export','backup-export','backup-import'])assert.ok(!settings.includes('id="'+id+'"'),id+' is removed');
});
