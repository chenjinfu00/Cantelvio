import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {SessionStore,snapshot,settings,WORK_ID} from '../concerto/session.mjs';
import {encodePreset,decodePreset,loadPublishedPreset,PUBLISHED_ASSETS} from '../concerto/preset.mjs';
const example=()=>({version:1,workId:WORK_ID,midi:{name:'local.mid',blob:new Blob([new Uint8Array([1,2,3])])},soloTrackIds:[13],confirmed:true,settings:{rate:94,volume:45,measure:1},page:13});
test('saved configuration is bounded and contains files rather than remote URLs',()=>{
  const value=example();value.soloTrackIds=[13,13,-1,999,'13'];value.settings={measure:-2,rate:Infinity,volume:999,mode:'javascript:run',deviceId:'x'.repeat(900)};
  const clean=snapshot(value);assert.deepEqual(clean.soloTrackIds,[13]);assert.equal(clean.settings.measure,1);assert.equal(clean.settings.rate,94);assert.equal(clean.settings.volume,100);assert.equal(clean.settings.mode,'fixed');assert.equal(clean.settings.deviceId.length,512);
  assert.throws(()=>snapshot({...value,midi:{name:'remote.mid',blob:'https://example.com/private.mid'}}));assert.throws(()=>snapshot({...value,version:2}));assert.throws(()=>snapshot({...value,workId:'another-work'}));
});
test('zero volume, selected entry, solo tracks and PDF page survive a snapshot',()=>{
  const value=example();value.pdf={name:'local.pdf',blob:new Blob(['%PDF'])};value.settings={measure:65,rate:93.5,volume:0,mode:'follow',speaker:false};
  const clean=snapshot(value);assert.equal(clean.settings.volume,0);assert.equal(clean.settings.measure,65);assert.equal(clean.settings.rate,93.5);assert.equal(clean.settings.mode,'follow');assert.equal(clean.settings.speaker,false);assert.equal(clean.page,13);assert.equal(clean.pdf.name,'local.pdf');
});
class MemoryStore extends SessionStore {
  constructor(){super({factory:null,name:'test'});this.data=new Map();this.pause=null;this.failure=false;}
  async transaction(mode,operation){if(this.pause){const wait=this.pause;this.pause=null;await wait;}if(this.failure){this.failure=false;throw Error('Quota exceeded');}return operation({get:key=>this.data.get(key),put:(value,key)=>this.data.set(key,value),delete:key=>this.data.delete(key)});}
}
test('a slow earlier save cannot resurrect files after Clear',async()=>{
  const store=new MemoryStore();let release;store.pause=new Promise(resolve=>{release=resolve;});
  const save=store.save(example()),clear=store.clear();release();await Promise.all([save,clear]);assert.equal(await store.load(),null);
});
test('save failures are surfaced and a subsequent retry remains usable',async()=>{
  const store=new MemoryStore();store.failure=true;await assert.rejects(store.save(example()),/Quota/);await store.save(example());assert.equal((await store.load()).confirmed,true);
});
test('snapshot arrays and settings are captured before an asynchronous save',async()=>{
  const store=new MemoryStore(),value=example(),save=store.save(value);value.soloTrackIds.push(8);value.settings.volume=100;await save;const clean=await store.load();assert.deepEqual(clean.soloTrackIds,[13]);assert.equal(clean.settings.volume,45);
});
test('missing browser storage fails without claiming persistence',async()=>{await assert.rejects(new SessionStore({factory:null}).load(),/storage unavailable/);});
test('invalid and truncated performance packs are rejected',async()=>{
  for(const bytes of [new Uint8Array(),new TextEncoder().encode('not a concerto pack'),new TextEncoder().encode('CVCONC01xxxx')])await assert.rejects(decodePreset(bytes));
});
const midi=new URL('../concerto/assets/chopin-op21-mvt1.mid',import.meta.url),pdf=new URL('../concerto/assets/chopin-op21-two-pianos.pdf',import.meta.url);
test('configured Chopin pack round-trips all assets, mutes solo and detects corruption',async()=>{
  const m=fs.readFileSync(midi),p=fs.readFileSync(pdf),pack=await encodePreset(m,p),bytes=new Uint8Array(await pack.arrayBuffer()),clean=await decodePreset(bytes);
  assert.equal(clean.workId,WORK_ID);assert.deepEqual(clean.soloTrackIds,[13]);assert.equal(clean.confirmed,true);assert.equal(clean.page,13);assert.deepEqual(new Uint8Array(await clean.midi.blob.arrayBuffer()),new Uint8Array(m));assert.deepEqual(new Uint8Array(await clean.pdf.blob.arrayBuffer()),new Uint8Array(p));
  bytes[bytes.length-1]^=1;await assert.rejects(decodePreset(bytes),/verification failed/);await assert.rejects(decodePreset(bytes.subarray(0,bytes.length-1)),/do not match/);
});
test('published preset loads only the approved project-relative files with complete default setup',async()=>{
  const requests=[];
  const clean=await loadPublishedPreset({fetcher:async(url,options)=>{requests.push({url,options});return new Response(fs.readFileSync(url));}});
  assert.deepEqual(requests.map(r=>r.url.pathname),PUBLISHED_ASSETS.map(a=>new URL('../concerto/'+a.path,import.meta.url).pathname));
  assert.ok(requests.every(r=>r.options.credentials==='omit' && r.options.redirect==='error'));
  assert.deepEqual(clean.soloTrackIds,[13]);assert.equal(clean.confirmed,true);assert.equal(clean.page,13);assert.equal(clean.settings.measure,1);assert.equal(clean.settings.rate,94);assert.equal(clean.settings.volume,45);assert.equal(clean.settings.mode,'fixed');
});
test('published preset rejects download errors, truncation and altered resource bytes',async()=>{
  await assert.rejects(loadPublishedPreset({fetcher:async()=>new Response('',{status:404})}),/Download failed/);
  await assert.rejects(loadPublishedPreset({fetcher:async()=>new Response(new Uint8Array(2))}),/Incomplete download/);
  await assert.rejects(loadPublishedPreset({fetcher:async url=>{const data=fs.readFileSync(url);data[data.length-1]^=1;return new Response(data);}}),/verification failed/);
});
test('published preset forwards cancellation and never accepts a cancelled download',async()=>{
  const abort=new AbortController();abort.abort();
  await assert.rejects(loadPublishedPreset({signal:abort.signal,fetcher:async(url,{signal})=>{assert.equal(signal,abort.signal);signal.throwIfAborted();}}),{name:'AbortError'});
});
