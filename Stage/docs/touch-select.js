// A select-only combobox for touch, mouse and keyboard. The original select
// still owns the value, options, disabled state and input/change handlers.
const installations=new WeakMap();
let nextId=0;

export function installTouchSelects(root=document){
  if(installations.has(root))return installations.get(root);
  const doc=root.ownerDocument||root,win=doc.defaultView;
  const controls=new Map();
  let current=null,gesture=null,scrollFrame=0,typeText='',typeTime=0;

  function labelFor(select){
    if(select.getAttribute('aria-label'))return select.getAttribute('aria-label');
    const labelled=select.getAttribute('aria-labelledby');
    if(labelled)return labelled.split(/\s+/).map(id=>doc.getElementById(id)?.textContent||'').join(' ').trim();
    return Array.from(select.labels||[]).map(label=>{
      const copy=label.cloneNode(true);
      copy.querySelectorAll('select,.touch-select-control').forEach(node=>node.remove());
      return copy.textContent.trim();
    }).join(' ')||select.title||'';
  }

  function optionsFor(select){
    return Array.from(select.options).map((option,index)=>({
      index,text:option.label||option.textContent,
      hidden:option.hidden||!!option.closest('optgroup[hidden]'),
      disabled:option.disabled||!!option.closest('optgroup[disabled]'),
    })).filter(option=>!option.hidden);
  }

  function enabled(control){return optionsFor(control.select).filter(option=>!option.disabled);}
  function isVisible(control){
    return !control.button.hidden&&!control.button.closest('[inert]')&&control.button.getClientRects().length>0&&win.getComputedStyle(control.button).visibility!=='hidden';
  }
  function setActive(control,index,{reveal=false}={}){
    control.active=index;
    for(const row of control.panel.querySelectorAll('[role="option"]')){
      const active=Number(row.dataset.index)===index;
      row.classList.toggle('active',active);
      if(active){
        control.button.setAttribute('aria-activedescendant',row.id);
        if(reveal)row.scrollIntoView({block:'nearest'});
      }
    }
    if(index===null)control.button.removeAttribute('aria-activedescendant');
  }

  function position(control){
    if(!isVisible(control)){close(false);return;}
    const rect=control.button.getBoundingClientRect(),viewport=win.visualViewport;
    const left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0;
    const width=viewport?.width||win.innerWidth,height=viewport?.height||win.innerHeight;
    const margin=8,gap=6,below=top+height-rect.bottom-gap-margin,above=rect.top-top-gap-margin;
    const down=below>=Math.min(240,control.panel.scrollHeight)||below>=above;
    const available=Math.max(44,down?below:above);
    control.panel.style.maxHeight=`${Math.min(384,available)}px`;
    control.panel.style.width=`${Math.min(Math.max(rect.width,200),width-margin*2)}px`;
    // Without Popover support, a glass dialog establishes a containing block
    // for fixed descendants. Measure that origin instead of assuming (0,0).
    control.panel.style.left='0px';control.panel.style.top='0px';
    const menu=control.panel.getBoundingClientRect();
    control.panel.style.left=`${Math.max(left+margin,Math.min(rect.left,left+width-menu.width-margin))-menu.left}px`;
    control.panel.style.top=`${Math.max(top+margin,Math.min(down?rect.bottom+gap:rect.top-gap-menu.height,top+height-menu.height-margin))-menu.top}px`;
  }

  function render(control){
    const previous=control.panel.scrollTop;
    control.panel.replaceChildren();
    for(const option of optionsFor(control.select)){
      const row=doc.createElement('div');
      row.id=`${control.id}-option-${option.index}`;
      row.className='touch-select-option';row.dataset.index=String(option.index);
      row.setAttribute('role','option');row.setAttribute('aria-selected',String(control.select.selectedIndex===option.index));
      if(option.disabled)row.setAttribute('aria-disabled','true');
      const text=doc.createElement('span');text.textContent=option.text;
      const check=doc.createElement('span');check.className='touch-select-check';check.setAttribute('aria-hidden','true');check.textContent='✓';
      row.append(text,check);control.panel.append(row);
    }
    control.panel.scrollTop=previous;
    if(!enabled(control).some(option=>option.index===control.active))control.active=enabled(control)[0]?.index??null;
    setActive(control,control.active);
    if(current===control)position(control);
  }

  function sync(control){
    const {select,button,value}=control;
    if(select.nextElementSibling!==button)select.after(button);
    const selected=select.options[select.selectedIndex];
    const text=selected?.label||selected?.textContent||'选择';
    if(value.textContent!==text)value.textContent=text;
    button.disabled=select.matches(':disabled');
    button.hidden=select.hidden||select.style.display==='none';
    button.title=select.title||text;
    button.setAttribute('aria-label',[labelFor(select),text].filter(Boolean).join('：'));
    button.tabIndex=select.tabIndex;
    if(current===control){
      if(button.disabled||!isVisible(control))close(false);
      else render(control);
    }
  }

  function finishGesture(){
    if(!gesture)return;
    const old=gesture;gesture=null;
    // Also consume a pending click if focus, visibility or an outside action
    // ends a long gesture before pointerup arrives.
    if(old.origin==='trigger')old.control.suppressClick=win.performance.now()+700;
    win.cancelAnimationFrame(scrollFrame);scrollFrame=0;
    try{if(old.capture?.hasPointerCapture(old.id))old.capture.releasePointerCapture(old.id);}catch{}
  }

  function close(restoreFocus=true){
    finishGesture();typeText='';
    const control=current;if(!control)return;
    current=null;
    control.button.setAttribute('aria-expanded','false');
    control.button.removeAttribute('data-touch-select-open');
    control.button.removeAttribute('aria-activedescendant');
    if(control.panel.hidePopover)try{control.panel.hidePopover();}catch{}
    control.panel.hidden=true;
    if(restoreFocus&&control.button.isConnected&&!control.button.disabled&&isVisible(control))control.button.focus({preventScroll:true});
  }

  function open(control){
    sync(control);
    if(control.button.disabled||!isVisible(control)||!enabled(control).length)return false;
    close(false);current=control;
    const parent=control.select.closest('dialog')||doc.body;
    parent.append(control.panel);
    control.active=enabled(control).find(option=>option.index===control.select.selectedIndex)?.index??enabled(control)[0]?.index??null;
    control.panel.hidden=false;render(control);
    if(control.panel.showPopover)try{control.panel.showPopover();}catch{}
    control.button.setAttribute('aria-expanded','true');
    control.button.setAttribute('data-touch-select-open','');
    position(control);setActive(control,control.active,{reveal:true});
    return true;
  }

  function choose(control,index){
    const option=optionsFor(control.select).find(item=>item.index===index);
    if(!option||option.disabled||control.select.matches(':disabled'))return close();
    const changed=control.select.selectedIndex!==index;
    close();control.select.selectedIndex=index;sync(control);
    if(changed){
      control.select.dispatchEvent(new win.Event('input',{bubbles:true}));
      control.select.dispatchEvent(new win.Event('change',{bubbles:true}));
      sync(control);
    }
  }

  function indexAt(control,x,y){
    const hit=doc.elementFromPoint(x,y)?.closest('.touch-select-option');
    return hit&&control.panel.contains(hit)&&hit.getAttribute('aria-disabled')!=='true'?Number(hit.dataset.index):null;
  }

  function autoScroll(){
    scrollFrame=0;
    if(!gesture||gesture.origin!=='trigger'||!current)return;
    const {x,y}=gesture,rect=current.panel.getBoundingClientRect();
    if(x>=rect.left&&x<=rect.right&&y>=rect.top-24&&y<=rect.bottom+24){
      const speed=y<rect.top+30?-Math.min(14,(rect.top+30-y)/3):y>rect.bottom-30?Math.min(14,(y-rect.bottom+30)/3):0;
      if(speed){
        current.panel.scrollTop+=speed;
        setActive(current,indexAt(current,x,y));
        scrollFrame=win.requestAnimationFrame(autoScroll);
      }
    }
  }

  function pointerStart(control,event,origin){
    if(event.button!==0||event.isPrimary===false)return;
    if(origin==='trigger'){
      event.preventDefault();event.stopPropagation();
      control.suppressClick=win.performance.now()+700;
      control.button.focus({preventScroll:true});
      if(current===control){close();return;}
      if(!open(control))return;
    }
    finishGesture();
    gesture={id:event.pointerId,origin,control,touch:event.pointerType==='touch',x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false,started:win.performance.now(),capture:origin==='trigger'?control.button:null};
    if(gesture.capture)try{gesture.capture.setPointerCapture(event.pointerId);}catch{}
  }

  function onPointerMove(event){
    if(!gesture||gesture.id!==event.pointerId)return;
    const point=gesture;
    point.x=event.clientX;point.y=event.clientY;
    point.moved||=Math.hypot(point.x-point.startX,point.y-point.startY)>8;
    if(point.origin==='trigger'){
      if(event.cancelable)event.preventDefault();event.stopPropagation();
      setActive(point.control,indexAt(point.control,point.x,point.y));
      if(!scrollFrame)autoScroll();
    }else if(!point.touch)setActive(point.control,indexAt(point.control,point.x,point.y));
  }

  function onPointerUp(event){
    if(!gesture||gesture.id!==event.pointerId)return;
    const point=gesture,index=indexAt(point.control,event.clientX,event.clientY);
    finishGesture();
    if(point.origin==='trigger'){
      event.preventDefault();event.stopPropagation();
      if(index!==null&&(point.moved||win.performance.now()-point.started>=180))choose(point.control,index);
      else if(point.moved)close();
    }else if(!(point.touch&&point.moved)&&index!==null)choose(point.control,index);
  }

  function onPointerCancel(event){
    if(!gesture||gesture.id!==event.pointerId)return;
    const fromTrigger=gesture.origin==='trigger';
    finishGesture();
    // A touch scroll cancels the pointer. Keep its list available to scroll.
    if(fromTrigger)close();
  }

  function onKey(control,event){
    const key=event.key;
    if(key==='Tab'){if(current===control)close(false);return;}
    if(key==='Escape'&&current===control){event.preventDefault();event.stopPropagation();close();return;}
    const navigation=['ArrowDown','ArrowUp','Home','End','PageDown','PageUp'];
    const typing=key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&key!==' ';
    if(!navigation.includes(key)&&!typing&&key!=='Enter'&&key!==' '){
      // Preserve the reader's native-select keyboard exemption: left/right
      // arrows on this control must never turn the score behind the menu.
      if(key!=='Escape')event.stopPropagation();
      return;
    }
    event.preventDefault();event.stopPropagation();
    const wasOpen=current===control;
    if(!wasOpen&&!open(control))return;
    if(key==='Enter'||key===' '){if(wasOpen&&control.active!==null)choose(control,control.active);return;}
    const choices=enabled(control),at=Math.max(0,choices.findIndex(option=>option.index===control.active));
    let next=at;
    if(key==='Home')next=0;
    else if(key==='End')next=choices.length-1;
    else if(key==='ArrowDown')next=wasOpen?(at+1)%choices.length:at;
    else if(key==='ArrowUp')next=wasOpen?(at-1+choices.length)%choices.length:at;
    else if(key==='PageDown')next=Math.min(choices.length-1,at+Math.max(1,Math.floor(control.panel.clientHeight/44)-1));
    else if(key==='PageUp')next=Math.max(0,at-Math.max(1,Math.floor(control.panel.clientHeight/44)-1));
    else if(typing){
      const now=win.performance.now();
      typeText=now-typeTime<700?typeText+key:key;typeTime=now;
      const query=Array.from(typeText).every(char=>char===typeText[0])?typeText[0]:typeText;
      const ordered=[...choices.slice(at+1),...choices.slice(0,at+1)];
      const match=ordered.find(option=>option.text.trim().toLocaleLowerCase().startsWith(query.toLocaleLowerCase()));
      if(match)setActive(control,match.index,{reveal:true});
      return;
    }
    setActive(control,choices[next].index,{reveal:true});
  }

  function enhance(select){
    if(controls.has(select)||select.multiple||select.size>1)return;
    const id=`touch-select-${++nextId}`,button=doc.createElement('button'),value=doc.createElement('span'),chevron=doc.createElement('span'),panel=doc.createElement('div');
    button.type='button';button.className='touch-select-control';button.dataset.selectId=select.id;
    button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls',id);
    value.className='touch-select-value';chevron.className='touch-select-chevron';chevron.textContent='⌄';chevron.setAttribute('aria-hidden','true');button.append(value,chevron);
    panel.id=id;panel.className='touch-select-menu';panel.dataset.touchSelectMenu='';panel.hidden=true;panel.setAttribute('role','listbox');panel.setAttribute('aria-label',labelFor(select)||'选项');
    if('popover' in panel)panel.setAttribute('popover','manual');
    const control={id,select,button,value,panel,active:null,suppressClick:0,restoreProperties:[]};
    controls.set(select,control);select.after(button);select.classList.add('touch-select-source');
    (select.closest('dialog')||doc.body).append(panel);
    // Select.value / selectedIndex writes do not produce DOM mutations or
    // events. Delegate instance accessors to the browser's native properties.
    for(const property of ['value','selectedIndex']){
      const own=Object.getOwnPropertyDescriptor(select,property);
      let owner=select,descriptor=own;
      while(!descriptor&&(owner=Object.getPrototypeOf(owner)))descriptor=Object.getOwnPropertyDescriptor(owner,property);
      if(descriptor?.get&&descriptor?.set&&own?.configurable!==false){
        try{
          Object.defineProperty(select,property,{configurable:true,enumerable:descriptor.enumerable,get(){return descriptor.get.call(this);},set(value){descriptor.set.call(this,value);sync(control);}});
          control.restoreProperties.push(()=>{if(own)Object.defineProperty(select,property,own);else delete select[property];});
        }catch{}
      }
    }
    button.addEventListener('pointerdown',event=>pointerStart(control,event,'trigger'));
    button.addEventListener('lostpointercapture',onPointerCancel);
    button.addEventListener('contextmenu',event=>event.preventDefault());
    button.addEventListener('keydown',event=>onKey(control,event));
    button.addEventListener('click',event=>{
      event.preventDefault();event.stopPropagation();
      if(event.detail>0&&win.performance.now()<control.suppressClick)return;
      if(current===control)close();else open(control);
    });
    panel.addEventListener('pointerdown',event=>pointerStart(control,event,'panel'));
    panel.addEventListener('pointermove',event=>{
      if(!gesture&&event.pointerType==='mouse')setActive(control,indexAt(control,event.clientX,event.clientY));
    });
    // Click also supports assistive technology activating an option directly.
    panel.addEventListener('click',event=>{
      const row=event.target.closest('[role="option"]');
      event.stopPropagation();
      if(event.detail===0&&row)choose(control,Number(row.dataset.index));
    });
    control.nativeChange=()=>sync(control);
    select.addEventListener('input',control.nativeChange);select.addEventListener('change',control.nativeChange);
    sync(control);
  }

  function destroy(control){
    if(current===control)close(false);
    control.select.classList.remove('touch-select-source');control.button.remove();control.panel.remove();
    control.select.removeEventListener('input',control.nativeChange);control.select.removeEventListener('change',control.nativeChange);
    for(const restore of control.restoreProperties)restore();
    controls.delete(control.select);
  }

  function scan(node){
    if(node.nodeType!==1&&node.nodeType!==9)return;
    const visit=select=>{if(controls.has(select))sync(controls.get(select));else enhance(select);};
    if(node.matches?.('select'))visit(node);
    node.querySelectorAll('select').forEach(visit);
  }
  scan(root);
  const observer=new win.MutationObserver(records=>{
    const changed=new Set();
    for(const record of records){
      const select=(record.target.nodeType===1?record.target:record.target.parentElement)?.closest('select');
      if(select&&controls.has(select))changed.add(controls.get(select));
      else if(select&&record.type==='attributes')enhance(select);
      if(record.type==='attributes'&&record.attributeName==='disabled'&&record.target.tagName==='FIELDSET'){
        for(const control of controls.values())if(record.target.contains(control.select))changed.add(control);
      }
      if(record.type==='childList')for(const node of record.addedNodes)scan(node);
    }
    for(const control of controls.values()){
      if(!root.contains(control.select)||control.select.multiple||control.select.size>1)destroy(control);
      else if(changed.has(control))sync(control);
    }
    if(current&&!isVisible(current))close(false);
  });
  observer.observe(root.nodeType===9?root.documentElement:root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','inert','disabled','label','selected','value','aria-label','aria-labelledby','title','tabindex','style','class','open','multiple','size']});
  doc.addEventListener('pointerdown',event=>{
    if(current&&!current.button.contains(event.target)&&!current.panel.contains(event.target))close(false);
  },true);
  doc.addEventListener('pointermove',onPointerMove,{capture:true,passive:false});
  doc.addEventListener('pointerup',onPointerUp,true);doc.addEventListener('pointercancel',onPointerCancel,true);
  doc.addEventListener('keydown',event=>{
    if(current&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();}
  },true);
  doc.addEventListener('focusin',event=>{
    if(current&&!current.button.contains(event.target)&&!current.panel.contains(event.target))close(false);
  });
  doc.addEventListener('scroll',event=>{if(current&&!current.panel.contains(event.target))close(false);},true);
  doc.addEventListener('visibilitychange',()=>{if(doc.hidden)close(false);});
  win.addEventListener('blur',()=>close(false));
  win.addEventListener('resize',()=>{if(current)position(current);});
  win.visualViewport?.addEventListener('resize',()=>{if(current)position(current);});
  win.visualViewport?.addEventListener('scroll',()=>{if(current)position(current);});
  const api={refresh(){scan(root);for(const control of controls.values())sync(control);},close:()=>close(false)};
  installations.set(root,api);return api;
}
