const $=id=>document.getElementById(id);

export async function outlinePage(pdf,destination){
  let resolved=destination;
  if(typeof resolved==='string')resolved=await pdf.getDestination(resolved);
  if(!Array.isArray(resolved)||resolved.length===0)return null;
  const reference=resolved[0];
  if(Number.isInteger(reference))return reference+1;
  if(!reference||typeof reference!=='object')return null;
  try{return (await pdf.getPageIndex(reference))+1;}catch{return null;}
}

export async function flattenOutline(pdf,outline,depth=0,result=[]){
  for(const entry of Array.isArray(outline)?outline:[]){
    const title=String(entry?.title||'').replace(/\s+/g,' ').trim();
    const page=await outlinePage(pdf,entry?.dest).catch(()=>null);
    if(title)result.push({title,page,depth,hasChildren:!!entry?.items?.length});
    await flattenOutline(pdf,entry?.items,depth+1,result);
  }
  return result;
}

export function activeOutlineIndex(items,page){
  let best=-1;
  for(let index=0;index<items.length;index++){
    const item=items[index];
    if(!Number.isFinite(item.page)||item.page>page)continue;
    const previous=items[best];
    if(best<0||item.page>previous.page||(item.page===previous.page&&item.depth>=previous.depth))best=index;
  }
  return best;
}

export function setupPDFOutline({page=()=>1,jump=()=>{},canJump=()=>true,toast=()=>{}}={}){
  const bar=$('pdf-outline'),list=$('pdf-outline-list');
  if(!bar||!list)return null;
  let items=[],token=0,active=-1;
  function revealCurrent(){
    const current=list.querySelector('.current');
    if(!current)return;
    const target=current.offsetTop-list.offsetTop-(list.clientHeight-current.offsetHeight)/2;
    list.scrollTo({top:Math.max(0,target),behavior:'smooth'});
  }
  function render(){
    list.textContent='';
    active=activeOutlineIndex(items,page());
    items.forEach((item,index)=>{
      const row=document.createElement(item.page?'button':'div');
      if(item.page)row.type='button';
      row.className='pdf-outline-item'+(item.hasChildren?' group':'')+(index===active?' current':'');
      row.style.setProperty('--outline-depth',String(Math.min(item.depth,5)));
      row.dataset.depth=String(item.depth);
      const title=document.createElement('span');title.textContent=item.title;
      row.append(title);
      if(item.page){
        const number=document.createElement('small');number.textContent=String(item.page);row.append(number);
        row.title=`${item.title}，第 ${item.page} 页`;
        row.onclick=()=>{if(canJump())jump(item.page);};
      }
      list.append(row);
    });
  }
  bar.addEventListener('toggle',()=>{if(bar.open)requestAnimationFrame(revealCurrent);});
  bar.hidden=true;
  return {
    async setDocument(pdf){
      const request=++token;bar.hidden=true;bar.open=false;items=[];list.textContent='';
      if(!pdf)return;
      try{
        const outline=await pdf.getOutline();
        const next=await flattenOutline(pdf,outline);
        if(request!==token)return;
        items=next.filter(item=>item.page||item.hasChildren);
        bar.hidden=!items.some(item=>item.page);
        if(!bar.hidden)render();
      }catch(error){
        if(request===token){bar.hidden=true;toast('这份 PDF 的内嵌目录无法读取。');}
      }
    },
    refresh(){
      if(bar.hidden||!items.length)return;
      const next=activeOutlineIndex(items,page());
      if(next===active)return;
      active=next;
      list.querySelector('.current')?.classList.remove('current');
      list.children[active]?.classList.add('current');
      if(bar.open)revealCurrent();
    },
    get items(){return items;},
  };
}
