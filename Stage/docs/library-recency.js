export const LIBRARY_RECENCY_KEY='volta:library-recency:v1';

const storageDefault=()=>{
  try{return globalThis.localStorage||null;}catch{return null;}
};
const clean=value=>typeof value==='string'?value:'';

export function readLibraryRecency(storage=storageDefault()){
  try{
    const value=JSON.parse(storage?.getItem(LIBRARY_RECENCY_KEY)||'{}');
    return {composer:clean(value.composer),genre:clean(value.genre),style:clean(value.style),era:clean(value.era),category:clean(value.category)};
  }catch{return {composer:'',genre:'',style:'',era:'',category:''};}
}

export function rememberLibraryRecency(work,storage=storageDefault()){
  const previous=readLibraryRecency(storage),next={
    composer:clean(work?.browseGroup)||previous.composer,
    genre:clean(work?.genre)||previous.genre,
    style:clean(work?.style)||previous.style,
    era:clean(work?.era)||previous.era,
    category:clean(work?.category)||previous.category,
  };
  try{storage?.setItem(LIBRARY_RECENCY_KEY,JSON.stringify(next));}catch{}
  return next;
}

// Move only the remembered entry. The rest of the catalogue keeps its normal order.
export function prioritizeLibraryGroups(groups,key){
  const ordered=[...groups],index=ordered.findIndex(([name])=>name===key);
  if(index>0)ordered.unshift(...ordered.splice(index,1));
  return ordered;
}
