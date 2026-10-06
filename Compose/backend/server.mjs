import http from 'node:http';
import { demoStatus } from './demo/status.mjs';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {generatePreview, models, PreviewBusyError, PreviewInputError} from './orchestra/api.mjs';
import {continuePreview} from './orchestra/stream-api.mjs';
import {generateFourPillarPreview, previewPrompts, FourPillarInputError, FourPillarBusyError} from './four-pillar/v2-api.mjs';
import {continueFourPillar, stopFourPillarSession} from './four-pillar/stream-api.mjs';
import {continuePerformance, stopPerformanceSession} from './four-pillar/performance-api.mjs';
const projectRoot=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const frontendRoot=path.join(projectRoot,'frontend');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.mp3':'audio/mpeg','.mid':'audio/midi','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml'};
function sendJson(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function readJson(req,limit=4096){let size=0,text='';for await(const chunk of req){size+=chunk.length;if(size>limit)throw new PreviewInputError('Request too large');text+=chunk;}try{return JSON.parse(text);}catch{throw new PreviewInputError('Invalid JSON');}}
const localAddress=address=>address==='127.0.0.1'||address==='::1'||address==='::ffff:127.0.0.1';
http.createServer(async(req,res)=>{
  let name;
  try{name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(404);res.end('Not found');return;}
  if(name==='/api/demo/status'&&req.method==='GET'){sendJson(res,200,await demoStatus());return;}
  if(name==='/api/orchestra/models'&&req.method==='GET'){sendJson(res,200,{models});return;}
  if(name==='/api/four-pillar/prompts'&&req.method==='GET'){
    try{sendJson(res,200,{prompts:await previewPrompts()});}
    catch(error){console.error('Four-pillar prompts failed:',error);sendJson(res,500,{error:'Prompts unavailable'});}
    return;
  }
  if((name==='/api/four-pillar/continue'||name==='/api/four-pillar/stop')&&req.method==='POST'){
    if(!localAddress(req.socket.remoteAddress)){sendJson(res,403,{error:'Generation is local-only'});return;}
    const controller=new AbortController();
    const disconnected=()=>{if(!res.writableEnded)controller.abort();};
    res.on('close',disconnected);
    try{
      const raw=await readJson(req);
      if(name.endsWith('stop')){stopFourPillarSession(raw.session);sendJson(res,200,{stopped:true});}
      else sendJson(res,200,await continueFourPillar(raw,controller.signal));
    }catch(error){
      if(controller.signal.aborted)return;
      if(error instanceof PreviewInputError||error instanceof FourPillarInputError)sendJson(res,400,{error:error.message});
      else if(error instanceof FourPillarBusyError)sendJson(res,409,{error:error.message});
      else{console.error('Four-pillar continuation failed:',error);sendJson(res,500,{error:'Continuation failed; check the local server log'});}
    }finally{res.off('close',disconnected);}
    return;
  }
  if((name==='/api/four-pillar/perform'||name==='/api/four-pillar/perform-stop')&&req.method==='POST'){
    if(!localAddress(req.socket.remoteAddress)){sendJson(res,403,{error:'Generation is local-only'});return;}
    const controller=new AbortController();
    const disconnected=()=>{if(!res.writableEnded)controller.abort();};
    res.on('close',disconnected);
    try{
      const raw=await readJson(req,65536);
      if(name.endsWith('stop')){stopPerformanceSession(raw.session);sendJson(res,200,{stopped:true});}
      else sendJson(res,200,await continuePerformance(raw,controller.signal));
    }catch(error){
      if(controller.signal.aborted)return;
      if(error instanceof PreviewInputError||error instanceof FourPillarInputError)sendJson(res,400,{error:error.message});
      else if(error instanceof FourPillarBusyError)sendJson(res,409,{error:error.message});
      else{console.error('Four-pillar continuation failed:',error);sendJson(res,500,{error:'Continuation failed; check the local server log'});}
    }finally{res.off('close',disconnected);}
    return;
  }
  if(name==='/api/four-pillar/generate'&&req.method==='POST'){
    if(!localAddress(req.socket.remoteAddress)){sendJson(res,403,{error:'Generation is local-only'});return;}
    try{sendJson(res,200,await generateFourPillarPreview(await readJson(req)));}
    catch(error){if(error instanceof PreviewInputError||error instanceof FourPillarInputError)sendJson(res,400,{error:error.message});
      else if(error instanceof FourPillarBusyError)sendJson(res,409,{error:error.message});
      else{console.error('Four-pillar preview failed:',error);sendJson(res,500,{error:'Preview failed; check the local server log'});}}
    return;
  }
  if((name==='/api/orchestra/generate'||name==='/api/orchestra/continue')&&req.method==='POST'){
    if(!localAddress(req.socket.remoteAddress)){sendJson(res,403,{error:'Generation is local-only'});return;}
    try{const input=await readJson(req);sendJson(res,200,await (name.endsWith('/continue')?continuePreview(input):generatePreview(input)));}
    catch(error){if(error instanceof PreviewInputError)sendJson(res,400,{error:error.message});
      else if(error instanceof PreviewBusyError)sendJson(res,409,{error:error.message});
      else{console.error('Orchestra preview failed:',error);sendJson(res,500,{error:'Generation failed; check the local server log'});}}
    return;
  }
  try{
    if(req.method!=='GET'&&req.method!=='HEAD')throw Error();
    const sample=/^\/training\/orchestra\/work\/samples\/[a-z0-9-]+\.mid$/.test(name);
    const doc=name==='/README.md'||name==='/training/orchestra/README.md';
    if(name.includes('/.'))throw Error();
    const file=sample||doc?path.resolve(projectRoot,'.'+name):path.resolve(frontendRoot,'.'+(name.endsWith('/')?name+'index.html':name));
    const allowed=sample||doc?file.startsWith(projectRoot+path.sep):file.startsWith(frontendRoot+path.sep);
    if(!allowed)throw Error();
    if(!(await stat(file)).isFile())throw Error();
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:await readFile(file));
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(Number(process.env.PORT||4187),process.env.HOST||'127.0.0.1',()=>console.log(`AIlegro local: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||4187}`));
