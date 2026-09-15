import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {strokeWidth,eraserRadius} from '../docs/ink.js';
import {validateInk} from '../docs/ink-validation.js';

const html=await fs.readFile(new URL('../docs/index.html',import.meta.url),'utf8');
const shell=await fs.readFile(new URL('../docs/reader-shell.js',import.meta.url),'utf8');

test('the shelf is for changing score, the top drawer is about the score you have open',()=>{
  for(const moved of ['#score-card','#edition-toolbar','.reader-toolbar','.page-navigation','#practice-drawer'])
    assert.ok(shell.includes("'"+moved+"'"),moved+' moved into the top drawer');
  const sidebar=html.slice(html.indexOf('<aside class="sidebar"'),html.indexOf('<main'));
  for(const keep of ['library-button','import-button','recent-scores','imslp-button'])assert.ok(sidebar.includes(keep),keep+' stays on the shelf');
});

test('the top drawer turns pages with a slider instead of buttons that repeat a tap',()=>{
  assert.match(html,/id="page-range" type="range"/);
  const css=/** the buttons stay for performance mode */ null;
  assert.match(html,/id="prev-button"/,'performance mode still has its big buttons');
  return css;
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

test('the pencil dock carries undo and redo, and the backup export moved into settings',()=>{
  const dock=html.slice(html.indexOf('id="ink-toolbar"'),html.indexOf('id="score-stage"'));
  for(const id of ['ink-undo','ink-redo','ink-width','eraser-width'])assert.ok(dock.includes('id="'+id+'"'),id+' is in the dock');
  assert.ok(dock.includes('data-ink-color'),'colours are swatches, not a dropdown');
  assert.ok(!dock.includes('id="ink-color"'),'the old colour dropdown is gone');
  assert.ok(!dock.includes('id="ink-export"'),'exporting is not a writing tool');
  const settings=html.slice(html.indexOf('id="settings-dialog"'));
  assert.ok(settings.includes('id="ink-export"'),'it lives in settings now');
});
