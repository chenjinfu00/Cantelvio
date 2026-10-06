// Where the score collection lives. It sits beside the project rather than inside it, so that the
// app and the music can be moved, shared or replaced independently.
import fs from 'node:fs';
import path from 'node:path';

export const PROJECT=path.resolve(import.meta.dirname,'..');
export const CANDIDATES=['../本地曲谱','本地曲谱'];
// The shelves are the folder. Everything the collection needs in order to describe itself
// lives in one clearly named drawer, so opening the folder shows music and nothing else.
export const DATA='曲谱库数据';

export function libraryRoot({env=process.env.VOLTA_LIBRARY,project=PROJECT,exists=file=>fs.existsSync(file)}={}){
  const tried=[];
  for(const candidate of env?[env]:CANDIDATES){
    const root=path.resolve(project,candidate);
    if(exists(path.join(root,DATA,'catalog.json'))||exists(path.join(root,'catalog.json')))return root;
    tried.push(root);
  }
  throw new Error('找不到本地曲谱（应在项目旁边，或用 VOLTA_LIBRARY 指定）。已查找：\n  '+tried.join('\n  '));
}

// An older collection keeps its catalogue loose at the top; a current one keeps it in the drawer.
export function libraryData(root,{exists=file=>fs.existsSync(file)}={}){
  const drawer=path.join(root,DATA);
  if(exists(drawer))return drawer;
  return exists(path.join(root,'catalog.json'))?root:drawer;
}
