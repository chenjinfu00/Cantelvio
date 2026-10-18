import {snapshot,WORK_ID} from './session.mjs?v=20261018-gain-1';
import {parseMidi} from './midi.mjs';
import {SCORE_BASIS} from './alignment.mjs?v=20261018-score-1';
// Only these two resources are approved for publication with this work.
export const CHOPIN_MIDI_SHA='09455ddd373d7bf4826f4ecc31aaa1a9619906d0223b20a2deccc6dcbd4bfb75';
export const CHOPIN_PDF_SHA='88345f8f0f0a7270773ecaeed9fc02cb77b8c989ffd6664609b6051116a3dd72';
export const PUBLISHED_ASSETS=Object.freeze([
  Object.freeze({path:'assets/chopin-op21-mvt1.mid',sha256:CHOPIN_MIDI_SHA,bytes:103593}),
  Object.freeze({path:'assets/chopin-op21-two-pianos.pdf',sha256:CHOPIN_PDF_SHA,bytes:14923525})
]);
const MAGIC='CVCONC01';
export async function digest(data) {return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),n=>n.toString(16).padStart(2,'0')).join('');}
async function verifiedConfiguration(midi,pdf){
  if(await digest(midi)!==CHOPIN_MIDI_SHA || await digest(pdf)!==CHOPIN_PDF_SHA)throw Error('曲目资源校验失败 / Performance resource verification failed');
  const parsed=parseMidi(midi);if(parsed.tracks[13]?.name!=='Pianoforte' || parsed.tracks[13].notes!==5811)throw Error('独奏轨不匹配 / Solo track does not match');
  return snapshot({version:1,workId:WORK_ID,midi:{name:'Chopin_Op21_Mvt1_Maestoso_Finley.mid',blob:new Blob([midi],{type:'audio/midi'})},pdf:{name:'肖邦第二钢琴协奏曲·双钢琴谱.pdf',blob:new Blob([pdf],{type:'application/pdf'})},soloTrackIds:[13],confirmed:true,settings:{positionBasis:SCORE_BASIS,measure:0,rate:94,volume:45,mode:'fixed',speaker:true},page:13});
}
export async function loadPublishedPreset({fetcher=globalThis.fetch,signal}={}){
  const buffers=await Promise.all(PUBLISHED_ASSETS.map(async asset=>{
    const response=await fetcher(new URL(asset.path,import.meta.url),{signal,credentials:'omit',redirect:'error'});
    if(!response.ok)throw Error('曲目下载失败，请点击恢复默认配置重试 / Download failed; restore defaults to retry');
    const buffer=await response.arrayBuffer();
    if(buffer.byteLength!==asset.bytes)throw Error('曲目下载不完整，请重试 / Incomplete download; please retry');
    return buffer;
  }));
  return verifiedConfiguration(...buffers);
}
export async function encodePreset(midi,pdf) {
  if(await digest(midi)!==CHOPIN_MIDI_SHA || await digest(pdf)!==CHOPIN_PDF_SHA)throw Error('Preset source does not match the verified local files');
  const header=new TextEncoder().encode(JSON.stringify({version:1,workId:WORK_ID,midiSize:midi.byteLength,pdfSize:pdf.byteLength}));
  const prefix=new Uint8Array(12);prefix.set(new TextEncoder().encode(MAGIC));new DataView(prefix.buffer).setUint32(8,header.length);
  return new Blob([prefix,header,midi,pdf],{type:'application/octet-stream'});
}
export async function decodePreset(buffer) {
  const bytes=new Uint8Array(buffer);if(bytes.length<12 || bytes.length>121*1024*1024 || new TextDecoder().decode(bytes.subarray(0,8))!==MAGIC)throw Error('请选择有效的 Concerto 演奏包 / Invalid Concerto performance pack');
  const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(8);
  if(length>65536 || 12+length>bytes.length)throw Error('演奏包不完整 / Incomplete performance pack');
  const header=JSON.parse(new TextDecoder().decode(bytes.subarray(12,12+length)));
  if(header.version!==1 || header.workId!==WORK_ID || !Number.isInteger(header.midiSize) || !Number.isInteger(header.pdfSize) || header.midiSize<=0 || header.midiSize>20*1024*1024 || header.pdfSize<=0 || header.pdfSize>100*1024*1024 || 12+length+header.midiSize+header.pdfSize!==bytes.length)throw Error('演奏包内容不匹配 / Performance pack contents do not match');
  const midi=bytes.slice(12+length,12+length+header.midiSize),pdf=bytes.slice(12+length+header.midiSize);
  return verifiedConfiguration(midi,pdf);
}
