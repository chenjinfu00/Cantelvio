// Where the score collection lives. It sits beside the project rather than inside it, so that the
// app and the music can be moved, shared or replaced independently.
import fs from 'node:fs';
import path from 'node:path';

export const PROJECT=path.resolve(import.meta.dirname,'..');
export const CANDIDATES=['../本地曲谱','本地曲谱'];

export function libraryRoot({env=process.env.VOLTA_LIBRARY,project=PROJECT,exists=file=>fs.existsSync(file)}={}){
  const tried=[];
  for(const candidate of env?[env]:CANDIDATES){
    const root=path.resolve(project,candidate);
    if(exists(path.join(root,'catalog.json')))return root;
    tried.push(root);
  }
  throw new Error('找不到本地曲谱（应在项目旁边，或用 VOLTA_LIBRARY 指定）。已查找：\n  '+tried.join('\n  '));
}
