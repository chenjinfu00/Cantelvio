// Version choices are device-local as well. Keeping them beside the reader's other
// preferences means reopening a score never waits for a server or depends on an API.
export function versionPreferences(_fetcher=fetch,{storage}={}){
  return {
    async load(workKey){
      try{return (storage||globalThis.localStorage).getItem('volta:version:'+workKey)||null;}catch{return null;}
    },
    async save(workKey,sourceId){
      (storage||globalThis.localStorage).setItem('volta:version:'+workKey,sourceId);
    },
  };
}
