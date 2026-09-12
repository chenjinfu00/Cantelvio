import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),source=path.join(root,'docs/scores'),archive=path.join(root,'.local-library/retired-public-scores');
// Move the former public release into an ignored archive. Never delete originals
// or rewrite Git history. Refuse to overwrite a pre-existing archive target.
const names=(await fs.readdir(source)).filter(name=>/^[a-f0-9]{64}\.pdf$/.test(name));
await fs.mkdir(archive,{recursive:true});
const moves=names.map(name=>[path.join(source,name),path.join(archive,name)]);
moves.push([path.join(root,'docs/library/catalog.json'),path.join(archive,'catalog.json')]);
for(const [,target] of moves){try{await fs.access(target);throw Error('Archive target exists: '+path.basename(target));}catch(error){if(error.code!=='ENOENT')throw error;}}
for(const [from,to] of moves)await fs.rename(from,to);
console.log(`Moved ${names.length} former public PDFs and their catalogue into the private local archive. No files deleted.`);
