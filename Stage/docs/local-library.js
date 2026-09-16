// A score collection read straight from a folder on this device: no server, no upload.
// Two ways in, because browsers differ: a directory handle that can be remembered (Chromium),
// or a one-shot folder pick that works everywhere else, iPad included.
import {saveLocalLibrary,loadLocalLibrary,forgetLocalLibrary} from './storage.js';
export const LOCAL_DB='volta:local-library:v1';
// Everything the collection says about itself sits in one named drawer, so that opening the
// folder shows shelves and nothing else. An older collection kept it all loose at the top.
export const DATA='曲谱库数据';
export const dataPaths=name=>[DATA+'/'+name,name];

export const canRemember=()=>typeof window!=='undefined'&&typeof window.showDirectoryPicker==='function';

// The picker hands back paths that all start with the folder's own name; the collection's
// manifest does not know about that, so it is stripped once, here.
export function relativePaths(files,{strip=true}={}){
  const list=[...files].map(file=>({file,path:(file.webkitRelativePath||file.name||'').split('\\').join('/')}));
  if(!strip||!list.length)return list;
  const roots=new Set(list.map(entry=>entry.path.split('/')[0]));
  if(roots.size!==1)return list;
  const root=[...roots][0]+'/';
  return list.map(entry=>({...entry,path:entry.path.startsWith(root)?entry.path.slice(root.length):entry.path}));
}
export const readJSON=async file=>JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));

// Which scores of the catalogue this folder actually holds, and where each one is.
export function matchLibrary(catalog,manifest,entries){
  const byPath=new Map(entries.map(entry=>[entry.path,entry.file]));
  const files=new Map(),missing=[];
  for(const item of catalog?.items||[]){
    const relative=manifest?.files?.[item.id];
    const file=relative&&byPath.get(relative);
    if(file)files.set(item.id,{relative,file});else missing.push(item.id);
  }
  const sources=new Map();
  for(const [id,{relative}] of files){
    const folder=relative.slice(0,relative.lastIndexOf('/')+1);
    for(const [path,file] of byPath)
      if(path.startsWith(folder)&&!path.slice(folder.length).includes('/')&&!path.endsWith('.pdf'))
        sources.set(id+'/'+path.slice(folder.length),file);
  }
  return {files,sources,missing};
}

export async function openFolder(){
  if(canRemember()){
    // Asking to write as well is what lets annotations be kept beside the music. A reader who
    // declines still gets everything else; only writing back is lost.
    const handle=await window.showDirectoryPicker({id:'volta-library',mode:'readwrite'});
    return {kind:'handle',handle,entries:await walk(handle)};
  }
  return new Promise((resolve,reject)=>{
    const input=document.createElement('input');
    input.type='file';input.webkitdirectory=true;input.multiple=true;input.style.display='none';
    input.onchange=()=>{document.body.removeChild(input);
      input.files.length?resolve({kind:'files',entries:relativePaths(input.files)}):reject(new Error('没有选择文件夹。'));};
    input.oncancel=()=>{document.body.removeChild(input);reject(new Error('已取消。'));};
    document.body.append(input);input.click();
  });
}
// Creating the folders on the way down is what makes a first save work on a collection that has
// never held annotations.
export async function writeInto(handle,relative,text){
  const parts=relative.split('/'),name=parts.pop();
  let folder=handle;
  for(const part of parts)folder=await folder.getDirectoryHandle(part,{create:true});
  const file=await folder.getFileHandle(name,{create:true}),stream=await file.createWritable();
  await stream.write(text);await stream.close();
  return relative;
}
async function walk(handle,prefix='',out=[]){
  for await(const [name,entry] of handle.entries()){
    if(name.startsWith('.'))continue;
    if(entry.kind==='directory')await walk(entry,prefix+name+'/',out);
    else out.push({path:prefix+name,handle:entry,get file(){return entry.getFile();}});
  }
  return out;
}

// A remembered folder survives a restart; a one-shot pick cannot, so only the catalogue is kept
// and the scores are asked for again.
export const remember=(handle,catalog)=>saveLocalLibrary({handle:handle||null,catalog});
export const recall=()=>loadLocalLibrary();
export const forget=()=>forgetLocalLibrary();

// Turn a picked folder into a source the shelf can read: its catalogue, its scores, its MIDI.
export async function readLibrary(picked){
  const entries=picked.entries;
  const find=async name=>{
    const entry=entries.find(item=>item.path===name);
    if(!entry)return null;
    return readJSON(await (entry.file instanceof Promise?entry.file:Promise.resolve(entry.file)));
  };
  const first=async names=>{for(const name of names){const found=await find(name);if(found)return found;}return null;};
  const catalog=await first(dataPaths('catalog.json')),manifest=await first(dataPaths('manifest.json'));
  if(!catalog||!manifest)throw new Error('这个文件夹不像曲谱库：缺少 catalog.json 或 manifest.json。');
  const resolved=await Promise.all(entries.map(async entry=>({path:entry.path,file:await (entry.file instanceof Promise?entry.file:Promise.resolve(entry.file))})));
  const {files,sources,missing}=matchLibrary(catalog,manifest,resolved);
  // Page bounds are what lets a score fill the screen without losing a stave; they belong to the
  // collection, so a chosen folder answers for them too instead of asking the network.
  const byPath=new Map(resolved.map(entry=>[entry.path,entry.file]));
  const fitFile=id=>dataPaths('fit/'+id+'.json').map(path=>byPath.get(path)).find(Boolean)||null;
  const inkPrefix=DATA+'/批注/';
  const writable=picked.kind==='handle'&&!!picked.handle
    &&await picked.handle.queryPermission?.({mode:'readwrite'}).then(state=>state==='granted').catch(()=>false);
  const urls=new Map();
  const address=file=>{const known=urls.get(file);if(known)return known;const made=URL.createObjectURL(file);urls.set(file,made);return made;};
  return {
    kind:picked.kind,handle:picked.handle||null,catalog,missing,
    async fit(id){const file=fitFile(id);return file?readJSON(file):null;},
    // Annotations kept beside the music, when the folder holds any.
    writable,
    async inkFiles(){
      return resolved.filter(entry=>entry.path.startsWith(inkPrefix)&&entry.path.endsWith('.json'))
        .map(entry=>({id:entry.path.slice(inkPrefix.length,-5),read:()=>readJSON(entry.file)}));
    },
    writeJSON:writable?(relative,value)=>writeInto(picked.handle,relative,JSON.stringify(value)):null,
    get size(){return files.size;},
    url:id=>{const found=files.get(id);return found?address(found.file):null;},
    sourceURL:(id,name)=>{const found=sources.get(id+'/'+name);return found?address(found):null;},
    release(){for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();},
  };
}

// A catalogue kept from the last visit: enough to draw the shelf with no network at all,
// while every file still has to come from a folder the player picks again.
export const rememberedLibrary=(catalog,reopen)=>({
  kind:'remembered',catalog,missing:[],needsFolder:true,size:0,handle:null,
  url:()=>null,sourceURL:()=>null,fit:async()=>null,writable:false,inkFiles:async()=>[],writeJSON:null,reopen,release(){},
});

export function setupLocalFolder({onLibrary=()=>{},toast=()=>{}}={}){
  const button=document.getElementById('local-folder'),status=document.getElementById('local-folder-status');
  const intro=document.getElementById('local-folder-intro');
  if(!button)return null;
  // The how-to earns its space only until a folder is open.
  const settled=()=>{if(intro)intro.hidden=true;};
  let current=null;
  const say=text=>{if(status)status.textContent=text;};
  async function use(picked,{save=true}={}){
    const library=await readLibrary(picked);
    current?.release();current=library;
    await onLibrary(library);
    if(save)await remember(library.handle,library.catalog).catch(()=>{});
    const missing=library.missing.length?` · ${library.missing.length} 份在目录里但文件夹里没有`:'';
    say(`已连接本地曲谱：${library.size} 份${missing}${library.kind==='files'?' · 重开应用需要再选一次':''}`);
    button.textContent='更换本地曲谱文件夹';settled();
    return library;
  }
  button.onclick=async()=>{
    button.disabled=true;
    try{say('正在读取文件夹…');await use(await openFolder());}
    catch(error){say(error.message);if(!/取消/.test(error.message))toast(error.message);}
    finally{button.disabled=false;}
  };
  return {
    use,
    get library(){return current;},
    // A remembered folder needs one click to be readable again; a remembered catalogue is enough
    // to show the shelf, and the files are asked for when a score is opened.
    async restore(){
      const saved=await recall().catch(()=>null);
      if(!saved)return null;
      if(saved.handle?.queryPermission){
        const state=await saved.handle.queryPermission({mode:'read'}).catch(()=>'denied');
        if(state==='granted'){
          try{return await use({kind:'handle',handle:saved.handle,entries:await walk(saved.handle)},{save:false});}catch{}
        }
      }
      if(!saved.catalog)return null;
      // Draw the shelf from what was kept, and ask for the folder only when a score is opened.
      const reopen=async()=>{try{return await use(await openFolder());}catch(error){say(error.message);return null;}};
      const remembered=rememberedLibrary(saved.catalog,reopen);
      current?.release();current=remembered;
      await onLibrary(remembered);
      say(saved.handle?'上次的本地曲谱文件夹需要再授权一次；打开曲谱时会请你选择。':'已恢复上次的曲谱目录；打开曲谱时需要再选一次文件夹。');
      button.textContent='重新连接本地曲谱文件夹';settled();
      return remembered;
    },
  };
}
