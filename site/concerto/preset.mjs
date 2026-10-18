import {snapshot,WORK_ID} from './session.mjs';
import {parseMidi} from './midi.mjs';
// Identity and settings only. The MIDI/PDF themselves are never published.
export const CHOPIN_MIDI_SHA='09455ddd373d7bf4826f4ecc31aaa1a9619906d0223b20a2deccc6dcbd4bfb75';
export const CHOPIN_PDF_SHA='88345f8f0f0a7270773ecaeed9fc02cb77b8c989ffd6664609b6051116a3dd72';
const MAGIC='CVCONC01';
export async function digest(data) {return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),n=>n.toString(16).padStart(2,'0')).join('');}
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
  if(await digest(midi)!==CHOPIN_MIDI_SHA || await digest(pdf)!==CHOPIN_PDF_SHA)throw Error('演奏包校验失败 / Performance pack verification failed');
  const parsed=parseMidi(midi);if(parsed.tracks[13]?.name!=='Pianoforte' || parsed.tracks[13].notes!==5811)throw Error('独奏轨不匹配 / Solo track does not match');
  return snapshot({version:1,workId:WORK_ID,midi:{name:'Chopin_Op21_Mvt1_Maestoso_Finley.mid',blob:new Blob([midi],{type:'audio/midi'})},pdf:{name:'肖邦第二钢琴协奏曲·双钢琴谱.pdf',blob:new Blob([pdf],{type:'application/pdf'})},soloTrackIds:[13],confirmed:true,settings:{measure:1,rate:94,volume:45,mode:'fixed',speaker:true},page:13});
}
