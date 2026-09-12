import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {downloadVerifiedPDF} from '../docs/verified-download.js';
import {streamQueue} from '../scripts/stream-queue.mjs';
import {installScoreZoom} from '../docs/score-zoom.js';
import {parseBackup,mergeBackup} from '../docs/annotation-backup.js';
import {Ink} from '../docs/ink.js';
const digest=data=>createHash('sha256').update(data).digest('hex');
function memoryCache(){const data=new Map();return {data,async put(key,response){const reader=response.body.getReader(),chunks=[];while(true){const {value,done}=await reader.read();if(done)break;chunks.push(value);}data.set(key,Buffer.concat(chunks));},async match(key){return data.has(key)?new Response(data.get(key)):undefined;},async delete(key){return data.delete(key);}};}
function source(bytes,{length=bytes.length,interrupt=false}={}){let offset=0;return new Response(new ReadableStream({pull(controller){if(interrupt&&offset>3){controller.error(Error('Connection lost'));return;}if(offset===bytes.length){controller.close();return;}controller.enqueue(bytes.subarray(offset,offset+3));offset=Math.min(bytes.length,offset+3);}}),{headers:{'Content-Length':String(length)}});}
test('offline download incrementally verifies bytes before promoting to usable cache',async()=>{
  const bytes=Buffer.from('%PDF-test-complete'),cache=memoryCache(),status=[];
  const size=await downloadVerifiedPDF(cache,'pending','pdf',{id:digest(bytes),progress:x=>status.push(x),fetcher:async()=>source(bytes)});
  assert.equal(size,bytes.length);assert.deepEqual(cache.data.get('pdf'),bytes);assert.equal(cache.data.has('pending'),false);assert.ok(status.some(x=>x.includes('校验通过')));
});
test('wrong hash, truncation, interruption and partial HTTP responses cannot overwrite an offline PDF',async()=>{
  const bytes=Buffer.from('partial PDF');
  for(const kind of ['hash','truncated','interrupt','range']){
    const cache=memoryCache();cache.data.set('pdf',Buffer.from('old verified'));
    await assert.rejects(downloadVerifiedPDF(cache,'pending','pdf',{id:kind==='hash'?'0'.repeat(64):digest(bytes),fetcher:async()=>kind==='range'?new Response(bytes,{status:206}):source(bytes,{length:bytes.length+(kind==='truncated'?1:0),interrupt:kind==='interrupt'})}));
    assert.equal(cache.data.get('pdf').toString(),'old verified');assert.equal(cache.data.has('pending'),false);
  }
});
test('streaming upload queue refills during a deliberately slow task, matches serial results and stays bounded',async()=>{
  const items=Array.from({length:12},(_,i)=>i),results=[],states=[],order=[];let release,started;
  const slow=new Promise(r=>release=r),full=new Promise(r=>started=r);
  const running=streamQueue(items,async item=>{order.push(item);if(item===0)await slow;return item*item;},{workers:3,onState:s=>states.push(s),onResult:(value,item)=>{results.push(value);if(item===11)started();}});
  await full;assert.equal(results.length,11);assert.equal(results.includes(0),false);release();await running;
  assert.equal(Math.max(...states.map(s=>s.active)),3);assert.deepEqual(order,items);
  const serial=[];await streamQueue(items,async i=>i*i,{workers:1,onResult:x=>serial.push(x)});
  assert.deepEqual(results.sort((a,b)=>a-b),serial);assert.equal(states.at(-1).active,0);assert.equal(states.at(-1).ready,0);
});
test('upload task failures publish other results and cancellation drains admitted work',async()=>{
  const complete=[],errors=[];let stop=false;
  const outcome=await streamQueue([0,1,2,3,4,5],async x=>{if(x===1)throw Error('fail');return x;},{workers:2,shouldStop:()=>stop,onError:(_,x)=>{errors.push(x);stop=true;},onResult:x=>complete.push(x)});
  assert.deepEqual(errors,[1]);assert.deepEqual(complete,[0]);assert.equal(outcome.claimed,2);
});
test('two-finger zoom touches only paper and commits once; cancelling either finger discards it',async()=>{
  const previous=globalThis.document,paper={style:{},getBoundingClientRect:()=>({left:0,top:0,width:1000,height:1400})};globalThis.document={getElementById:id=>{assert.equal(id,'pages');return paper;}};
  try{
    const stage=new EventTarget();stage.setPointerCapture=()=>{};let commits=0;
    const pinch=installScoreZoom(stage,{getZoom:()=>1,canZoom:()=>true,commit:async()=>{commits++;}});
    const fire=(type,id,x)=>{const event=new Event(type,{cancelable:true});Object.assign(event,{pointerId:id,pointerType:'touch',clientX:x,clientY:200});stage.dispatchEvent(event);};
    fire('pointerdown',1,100);fire('pointerdown',2,200);fire('pointermove',2,300);assert.match(paper.style.transform,/scale\(2\)/);fire('pointerup',1,100);assert.equal(commits,0);fire('pointerup',2,300);await new Promise(r=>setTimeout(r,0));assert.equal(commits,1);assert.equal(pinch.active,false);assert.equal(paper.style.transform,'');
    fire('pointerdown',3,100);fire('pointerdown',4,200);fire('pointermove',4,300);fire('pointercancel',3,100);fire('pointerup',4,300);assert.equal(commits,1);assert.equal(paper.style.transform,'');
  }finally{if(previous)globalThis.document=previous;else delete globalThis.document;}
});
test('annotation backup accepts old and full formats; merges idempotently without losing current ink',()=>{
  const id='a'.repeat(64),stroke=key=>({id:key,color:'#123456',width:.002,points:[[.2,.3,.5]]}),data={version:1,strokes:[stroke('imported')]};
  const parsed=parseBackup({version:1,scoreId:id,pages:{1:data}});assert.equal(parsed[0].id,id+'/1');
  assert.deepEqual(parseBackup({format:'volta-annotations',version:1,pages:parsed}),parsed);
  const merged=mergeBackup([{id:id+'/1',data:{version:1,strokes:[stroke('existing')]}}],parsed);
  assert.deepEqual(merged[0].data.strokes.map(x=>x.id),['existing','imported']);assert.deepEqual(mergeBackup(merged,parsed),merged);
  assert.throws(()=>parseBackup({format:'volta-annotations',version:1,pages:[{id:'bad',data}]}));
  assert.throws(()=>mergeBackup(merged,[{id:id+'/1',data:{version:1,strokes:[{...stroke('existing'),color:'#ffffff'}]}}]));
});
test('manual cloud sync can await an already-running local ink write',async()=>{
  let release;const ink=Object.create(Ink.prototype),record={dirty:true,revision:1,key:'page',data:{version:1,strokes:[]}};
  ink.localOnly=true;ink.status=()=>{};ink.toast=()=>{};ink.draft=()=>new Promise(r=>release=r);
  const first=ink.flush(record),second=ink.flush(record);assert.equal(first,second);assert.equal(record.saving,true);release();await second;assert.equal(record.dirty,false);assert.equal(record.saving,false);
});
