import fs from 'node:fs/promises';
const root=new URL('../docs/',import.meta.url),files=[];
async function walk(url,prefix=''){
  for(const entry of await fs.readdir(url,{withFileTypes:true})){
    const path=prefix+entry.name;
    if(['scores','.git'].includes(entry.name)||['sw.js','cache-manifest.json'].includes(path))continue;
    if(entry.isDirectory())await walk(new URL(entry.name+'/',url),path+'/');
    else files.push('./'+path);
  }
}
await walk(root);await fs.writeFile(new URL('cache-manifest.json',root),JSON.stringify(files.sort(),null,2)+'\n');
console.log(`Offline app: ${files.length} files (PDFs are saved only on request).`);
