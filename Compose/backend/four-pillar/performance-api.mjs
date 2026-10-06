import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {FourPillarInputError, FourPillarBusyError} from './v2-api.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sessions=new Map();
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function normalizePerformanceOptions(raw) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new FourPillarInputError('Invalid request');
  const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
  const finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  const chord=c=>c&&integer(c.root,0,11)&&integer(c.q,0,39)&&(c.bassPc==null||integer(c.bassPc,0,11));
  if(!integer(raw.index,0,100000000)||!integer(raw.seed,0,999999999)||!chord(raw.chord)||
    !raw.key||!integer(raw.key.tonic,0,11)||!['major','minor'].includes(raw.key.mode)||
    !finite(raw.tempo,40,200)||!finite(raw.harmonyT,.25,2)||!finite(raw.melodyT,.25,1.5)||!finite(raw.density,0,1)||
    !['hold','auto'].includes(raw.mode)||!['bar','free'].includes(raw.changeMode)||
    !Array.isArray(raw.meter)||raw.meter.length!==2||!integer(raw.meter[0],2,12)||![4,8].includes(raw.meter[1])||
    !finite(raw.beats,2,6)||raw.beats!==raw.meter[0]*4/raw.meter[1]||
    !finite(raw.cut??0,0,raw.beats)||!Array.isArray(raw.fixed)||raw.fixed.length>32||
    raw.fixed.some(s=>!chord(s)||!finite(Number(s.offset),0,raw.beats)))throw new FourPillarInputError('Invalid performance controls');
  if(raw.session!==undefined&&(typeof raw.session!=='string'||!idPattern.test(raw.session)))throw new FourPillarInputError('Invalid session');
  if(!raw.session&&raw.index!==0)throw new FourPillarInputError('New sessions start at bar zero');
  return {...raw,cut:raw.cut??0};
}
export function stopPerformanceSession(id) {
  if(typeof id!=='string'||!idPattern.test(id)) throw new FourPillarInputError('Invalid session');
  const item=sessions.get(id);
  if(item){clearTimeout(item.timer);sessions.delete(id);item.child.kill('SIGTERM');item.pending?.reject(new Error('Session stopped'));}
}
function createSession(id,scoreId,options) {
  const child=spawn(path.join(root,'.venv-training/bin/python'),['-u',path.join(root,'training/scripts/four_pillar_v2_performance.py')],{cwd:root,stdio:['pipe','pipe','pipe']});
  const item={child,options,next:0,last:null,pending:null,buffer:'',stderr:'',timer:null};
  sessions.set(id,item);
  child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>{
    item.buffer+=chunk;
    if(item.buffer.length>4000000){stopPerformanceSession(id);return;}
    let split;
    while((split=item.buffer.indexOf('\n'))>=0){
      const line=item.buffer.slice(0,split);item.buffer=item.buffer.slice(split+1);
      try{const data=JSON.parse(line);if(!item.pending)throw Error('Unexpected worker output');
        item.pending.resolve(data);item.pending=null;
      }catch(error){item.pending?.reject(error);item.pending=null;stopPerformanceSession(id);}
    }
  });
  child.stderr.on('data',chunk=>{item.stderr=(item.stderr+chunk).slice(-4000);});
  const fail=error=>{item.pending?.reject(error);item.pending=null;clearTimeout(item.timer);sessions.delete(id);};
  child.on('error',fail);
  child.on('close',code=>fail(new Error(`Continuation worker exited ${code}: ${item.stderr}`)));
  child.stdin.write(JSON.stringify(options)+'\n');
  return item;
}
export async function continuePerformance(raw,signal) {
  const options=normalizePerformanceOptions(raw), index=options.index;
  const id=raw.session??randomUUID();
  let item=sessions.get(id);
  if(!item){
    if(raw.session)throw new FourPillarInputError('Session expired; start a new piece');
    if(sessions.size>=1)throw new FourPillarBusyError('Another continuous session is active; stop it first');
    item=createSession(id,null,options);
  }
  if(options.seed!==item.options.seed)throw new FourPillarInputError('Seed changed; start a new piece');
  if(index>item.next||index<Math.max(0,item.next-17))throw new FourPillarInputError('Bar requested outside retained context');
  if(item.pending)throw new FourPillarBusyError('This session is already generating');
  clearTimeout(item.timer);
  const abort=()=>stopPerformanceSession(id);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){abort();throw new Error('Request aborted');}
  item.timer=setTimeout(abort,300000);
  try {
    const data=await new Promise((resolve,reject)=>{
      item.pending={resolve,reject};
      item.child.stdin.write(JSON.stringify(options)+'\n');
    });
    if(data.index!==index||!Array.isArray(data.notes)||!Array.isArray(data.spans))throw Error('Invalid continuation result');
    item.last={session:id,index,options,...data};item.next=index+1;
    clearTimeout(item.timer);item.timer=setTimeout(abort,600000);item.timer.unref();
    return item.last;
  }catch(error){stopPerformanceSession(id);throw error;}
  finally{signal?.removeEventListener('abort',abort);}
}
process.once('exit',()=>{for(const item of sessions.values())item.child.kill('SIGTERM');});
