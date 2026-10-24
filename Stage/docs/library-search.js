const compact=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
// Search typed on a tablet need not reproduce a publisher's spaces and punctuation.
export function matchesLibrarySearch(text,query){
  const terms=String(query||'').trim().split(/\s+/).map(compact).filter(Boolean);
  const haystack=compact(text);
  return terms.every(term=>haystack.includes(term));
}
