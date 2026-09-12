export async function streamQueue(items,worker,{workers=6,onResult=()=>{},onError=()=>{},shouldStop=()=>false,onState=()=>{}}={}){
  if(!Number.isInteger(workers)||workers<1||workers>12)throw Error('Invalid worker count');
  let cursor=0,active=0,completed=0;
  const run=async id=>{while(cursor<items.length&&!shouldStop()){
    const item=items[cursor++],start=Date.now();active++;onState({active,ready:items.length-cursor,completed});
    try{const result=await worker(item,id);await onResult(result,item);}catch(error){await onError(error,item);}
    finally{active--;completed++;onState({active,ready:items.length-cursor,completed,duration:Date.now()-start});}
  }};
  // One final drain, not fixed-size rounds: each loop claims its next task as
  // soon as its own publication finishes. No ordered result accumulation.
  await Promise.all(Array.from({length:workers},(_,id)=>run(id)));
  return {claimed:cursor,completed};
}
