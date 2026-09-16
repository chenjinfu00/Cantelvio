import http from 'node:http';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {parseRange} from '../docs/offline-range.js';
const root=path.resolve(fileURLToPath(new URL('../docs/',import.meta.url)));
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.pdf':'application/pdf','.svg':'image/svg+xml','.wasm':'application/wasm'};
export async function createPreviewServer({library=null}={}){
  const localRoot=library?await fs.realpath(library):null;
  const manifest=localRoot?JSON.parse(await fs.readFile(path.join(localRoot,'manifest.json'))):null;
  return http.createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
    if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host){res.writeHead(403).end();return;}
    const url=new URL(req.url,'http://localhost'),relative=decodeURIComponent(url.pathname).replace(/^\/volta\/?/,'');
    if(!url.pathname.startsWith('/volta/')){res.writeHead(302,{Location:'/volta/'}).end();return;}
    if(relative.split('/').some(segment=>segment.startsWith('.'))){res.writeHead(403).end();return;}
    let file=path.resolve(root,relative||'index.html'),allowedRoot=root;
    if(localRoot&&relative==='library/catalog.json'){file=path.join(localRoot,'catalog.json');allowedRoot=localRoot;}
    if(localRoot&&/^fit\/[a-f0-9]{64}\.json$/.test(relative)){file=path.join(localRoot,relative);allowedRoot=localRoot;}
    if(localRoot&&relative.startsWith('scores/')){
      const match=/^scores\/([a-f0-9]{64})\.pdf$/.exec(relative),registered=match&&manifest.files[match[1]];
      if(!registered){res.writeHead(404).end();return;}
      file=path.resolve(localRoot,registered);allowedRoot=localRoot;
    }
    file=await fs.realpath(file);if(!file.startsWith(allowedRoot+path.sep)){res.writeHead(403).end();return;}
    const stat=await fs.stat(file);if(!stat.isFile())throw new Error('Not a file');
    const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':localRoot?'private, no-store':'no-cache','Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'};
    let range;if(req.headers.range){range=parseRange(req.headers.range,stat.size);if(!range){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end();return;}headers['Content-Range']=`bytes ${range.start}-${range.end}/${stat.size}`;}
    headers['Content-Length']=range?range.end-range.start+1:stat.size;res.writeHead(range?206:200,headers);
    if(req.method==='HEAD')res.end();else{const stream=createReadStream(file,range||{});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}
  }catch{res.writeHead(404).end('Not found');}
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
const library=process.argv.includes('--library')?path.resolve(import.meta.dirname,'../本地曲谱'):null;
const server=await createPreviewServer({library});
server.listen(Number(process.argv[2]||4318),process.argv.includes('--lan')?'0.0.0.0':'127.0.0.1',()=>{
  const port=process.argv[2]||4318;console.log(`Volta preview: http://localhost:${port}/volta/`);
  if(library)console.log('Local collection enabled. PDFs stay on this Mac; accessible to devices on this LAN.');
  if(process.argv.includes('--lan'))for(const [name,addresses] of Object.entries(os.networkInterfaces()))for(const address of addresses||[])if(address.family==='IPv4'&&!address.internal)console.log(`${name}: http://${address.address}:${port}/volta/`);
});
}
