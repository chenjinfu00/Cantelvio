import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),publish=path.join(root,'dist'),out=path.join(publish,'volta');
// This generated directory must not retain files from an older release.
await fs.rm(publish,{recursive:true,force:true});
await fs.mkdir(out,{recursive:true});
await fs.cp(path.join(root,'docs'),out,{recursive:true,filter:source=>path.basename(source)!=='.DS_Store'&&!['scores','fit','library'].includes(path.relative(path.join(root,'docs'),source).split(path.sep)[0])});
await fs.writeFile(path.join(out,'site-config.js'),"export const PUBLIC_LIBRARY=true;\nexport const CLOUD_LIBRARY=true;\nexport const CLOUD_HOME='';\n");
const files=[];
async function walk(folder){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())await walk(file);else if(!['sw.js','cache-manifest.json'].includes(entry.name))files.push('./'+path.relative(out,file));}}
await walk(out);await fs.writeFile(path.join(out,'cache-manifest.json'),JSON.stringify(files.sort(),null,2));
for(const forbidden of ['scores','library/catalog.json'])try{await fs.access(path.join(out,forbidden));throw Error('Private files found in public deploy folder');}catch(error){if(error.code!=='ENOENT')throw error;}
console.log(`Private cloud shell built: ${files.length} assets; zero public PDFs or private catalogues.`);
