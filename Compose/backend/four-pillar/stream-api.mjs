import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {normalizeFourPillarOptions, previewPrompts, FourPillarInputError, FourPillarBusyError} from './v2-api.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sessions=new Map();
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validateStreamRequest(raw) {
  const options=normalizeFourPillarOptions(raw);
  const index=raw.index??0;
  if(!Number.isSafeInteger(index)||index<0||index>100000000) throw new FourPillarInputError('Invalid segment index');
  if(raw.session!==undefined&&(typeof raw.session!=='string'||!idPattern.test(raw.session))) throw new FourPillarInputError('Invalid session');
  if(!raw.session&&index!==0) throw new FourPillarInputError('New sessions start at segment zero');
  return {options,index};
}
export function stopFourPillarSession(id) {
  if(typeof id!=='string'||!idPattern.test(id)) throw new FourPillarInputError('Invalid session');
  const item=sessions.get(id);
  if(item){clearTimeout(item.timer);sessions.delete(id);item.child.kill('SIGTERM');item.pending?.reject(new Error('Session stopped'));}
}
function createSession(id,scoreId,options) {
  const child=spawn(path.join(root,'.venv-training/bin/python'),['-u',path.join(root,'training/scripts/four_pillar_v2_stream.py')],{cwd:root,stdio:['pipe','pipe','pipe']});
  const item={child,options,next:0,last:null,pending:null,buffer:'',stderr:'',timer:null};
  sessions.set(id,item);
  child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>{
    item.buffer+=chunk;
    if(item.buffer.length>4000000){stopFourPillarSession(id);return;}
    let split;
    while((split=item.buffer.indexOf('\n'))>=0){
      const line=item.buffer.slice(0,split);item.buffer=item.buffer.slice(split+1);
      try{const data=JSON.parse(line);if(!item.pending)throw Error('Unexpected worker output');
        item.pending.resolve(data);item.pending=null;
      }catch(error){item.pending?.reject(error);item.pending=null;stopFourPillarSession(id);}
    }
  });
  child.stderr.on('data',chunk=>{item.stderr=(item.stderr+chunk).slice(-4000);});
  const fail=error=>{item.pending?.reject(error);item.pending=null;clearTimeout(item.timer);sessions.delete(id);};
  child.on('error',fail);
  child.on('close',code=>fail(new Error(`Continuation worker exited ${code}: ${item.stderr}`)));
  child.stdin.write(JSON.stringify({scoreId,seed:options.seed})+'\n');
  return item;
}
export async function continueFourPillar(raw,signal) {
  const {options,index}=validateStreamRequest(raw);
  const prompts=await previewPrompts();
  const id=raw.session??randomUUID();
  let item=sessions.get(id);
  if(!item){
    if(raw.session)throw new FourPillarInputError('Session expired; start a new piece');
    if(sessions.size>=1)throw new FourPillarBusyError('Another continuous session is active; stop it first');
    item=createSession(id,prompts[options.prompt].scoreId,options);
  }
  if(options.seed!==item.options.seed||options.prompt!==item.options.prompt)throw new FourPillarInputError('Prompt or seed changed; start a new piece');
  if(index===item.next-1&&item.last)return item.last;
  if(index!==item.next)throw new FourPillarInputError('Segment requested out of order');
  if(item.pending)throw new FourPillarBusyError('This session is already generating');
  clearTimeout(item.timer);
  const abort=()=>stopFourPillarSession(id);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){abort();throw new Error('Request aborted');}
  item.timer=setTimeout(abort,300000);
  try {
    const data=await new Promise((resolve,reject)=>{
      item.pending={resolve,reject};
      item.child.stdin.write(JSON.stringify(options)+'\n');
    });
    if(data.index!==index||data.sample.bars!==4||data.sample.barEvents.length!==4)throw Error('Invalid continuation result');
    item.last={session:id,index,options,sample:data.sample};item.next++;
    clearTimeout(item.timer);item.timer=setTimeout(abort,600000);item.timer.unref();
    return item.last;
  }catch(error){stopFourPillarSession(id);throw error;}
  finally{signal?.removeEventListener('abort',abort);}
}
process.once('exit',()=>{for(const item of sessions.values())item.child.kill('SIGTERM');});
