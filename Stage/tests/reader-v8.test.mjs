import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fitLayout,includeInk,safeBounds} from '../docs/fit-layout.js';
import {pinchTransform,clampZoom} from '../docs/score-zoom.js';
import {verifyPassword,hash,sessionFor,requireSameOrigin,boundedJSON} from '../netlify/lib/security.js';
import {validateInk} from '../netlify/lib/notes.js';
import {syncOnePage} from '../docs/cloud-sync.js';
import {pbkdf2Sync} from 'node:crypto';

test('content fit contains complete marked bounds for both orientations without stretching',()=>{
  for(const natural of [{width:600,height:900},{width:900,height:600}])for(const screen of [{width:1024,height:1366},{width:1366,height:1024}]){
    const bounds=[.05,.06,.93,.97],value=fitLayout(natural,{...screen,fit:'screen',zoom:1,protectFit:true},bounds);
    assert.ok(value.clip.width<=screen.width+1e-8&&value.clip.height<=screen.height+1e-8);
    assert.ok(Math.abs(value.width/value.height-natural.width/natural.height)<1e-9);
    assert.ok(value.clip.x>=0&&value.clip.y>=0);
  }
  assert.deepEqual(safeBounds([NaN,0,1,1]),[0,0,1,1]);
  const box=includeInk([.1,.1,.9,.9],[{width:.002,points:[[.03,.98,.5]]}]);assert.ok(box[0]<.03&&box[3]>.98);
});
test('all private pages have conservative finite bounds and keep originals unchanged',async t=>{
  let summary;try{summary=JSON.parse(await fs.readFile(new URL('../.local-library/fit-summary.json',import.meta.url)));}catch{t.skip('Private collection not present');return;}
  assert.equal(summary.pdfs,701);assert.equal(summary.pages,11259);assert.deepEqual(summary.failed,[]);
  for(const name of await fs.readdir(new URL('../.local-library/fit/',import.meta.url))){const value=JSON.parse(await fs.readFile(new URL('../.local-library/fit/'+name,import.meta.url)));for(const page of value.pages)assert.deepEqual(safeBounds(page.bounds),page.bounds);}
});
test('pinch clamps minimum to fit and uses a score-local transform, not document zoom',()=>{
  const start={zoom:1,distance:100,left:0,top:0,center:{x:200,y:200}};
  const result=pinchTransform(start,[{x:100,y:200},{x:300,y:200}]);assert.equal(result.zoom,2);assert.equal(result.x,-200);assert.equal(result.y,-200);
  assert.equal(clampZoom(.5),1);assert.equal(clampZoom(20),4);assert.equal(clampZoom(NaN),1);
});
test('server password verification requires a salted slow hash, never a frontend password',async()=>{
  const salt='a'.repeat(32),password='test-only-long-password',digest=pbkdf2Sync(password,Buffer.from(salt,'hex'),310000,32,'sha256').toString('hex');
  const verifier=`pbkdf2$310000$${salt}$${digest}`;
  assert.equal(await verifyPassword(password,verifier),true);assert.equal(await verifyPassword('wrong-password-long',verifier),false);assert.equal(await verifyPassword('133',verifier),false);
  assert.equal(await verifyPassword(password,'broken'),false);
});
test('PDF authorization fails closed without a token, with an expired or revoked device',async()=>{
  const token='b'.repeat(64),id=await hash(token),request=new Request('https://test/volta/scores/a.pdf',{headers:{Cookie:'__Host-volta-device='+token}});
  let record={expiresAt:2000,revoked:false};const store={get:async key=>key===id?record:null};
  assert.equal((await sessionFor(request,store,1000)).id,id);record.revoked=true;assert.equal(await sessionFor(request,store,1000),null);record.revoked=false;assert.equal(await sessionFor(request,store,3000),null);assert.equal(await sessionFor(new Request(request.url),store,1000),null);
});
test('mutations reject other origins and oversized/invalid ink',async()=>{
  assert.equal(requireSameOrigin(new Request('https://test/api',{headers:{Origin:'https://evil','Content-Type':'application/json'}})),false);
  assert.equal(requireSameOrigin(new Request('https://test/api',{headers:{Origin:'https://test','Content-Type':'application/json'}})),true);
  const request=new Request('https://test/api',{method:'POST',body:JSON.stringify({a:'12345'})});await assert.rejects(boundedJSON(request,4));
  assert.equal(validateInk({version:1,strokes:[]}),true);assert.equal(validateInk({version:1,strokes:[{id:'x',color:'red',width:1,points:[]}]}),false);
});
test('annotation update retries conflicts and preserves independent additions and deletions',async()=>{
  const s=id=>({id,color:'#123456',width:.002,points:[[.2,.3,.5]]}),base={version:1,strokes:[s('old')]},local={version:1,strokes:[s('local')]};let writes=0;
  const result=await syncOnePage('a/1',{local,base,request:async(_,options={})=>{
    if(!options.method)return new Response(JSON.stringify({version:1,strokes:[s('old'),s('remote'),...(writes?[s('newer')]:[])]}),{headers:{ETag:'revision'}});
    writes++;return new Response('{}',{status:writes===1?409:200});
  }});
  assert.deepEqual(result.strokes.map(s=>s.id).sort(),['local','newer','remote']);assert.equal(writes,2);
});
test('private Netlify build publishes no static PDFs, secrets, catalogue or local paths',async()=>{
  const base=new URL('../dist/volta/',import.meta.url);try{await fs.access(base);}catch{return;}
  for(const name of ['scores','library','fit','.env','.local-library'])await assert.rejects(fs.access(new URL(name,base)));
  const manifest=JSON.parse(await fs.readFile(new URL('cache-manifest.json',base)));assert.ok(manifest.every(x=>!x.includes('catalog.json')&&!x.endsWith('.pdf')));
});
