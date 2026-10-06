import { CHORDS, PROGRESSIONS } from "./shared/music-data.js";
import { appLayoutSnapshot, chordSVG, keyboardSVG, latticeSceneSVG, point } from "./shared/lattice.js";
import { DeckAudio } from "./deck-audio.js";

const slides = [...document.querySelectorAll(".slide")];
const deck = document.querySelector("#deck");
const stage = document.querySelector("#stage");
const lattice = document.querySelector("#persistentLattice");
const prev = document.querySelector("#prevButton");
const next = document.querySelector("#nextButton");
const fullscreen = document.querySelector("#fullscreenButton");
const pageCount = document.querySelector("#pageCount");
const progress = document.querySelector("#progressBar");
const audio = new DeckAudio(document.querySelector("#audioEngine"), document.querySelector("#soundStatus"));
let index = 0;
let build = 0;

const flows = PROGRESSIONS;

const chordShapes = {
  C:{coords:[[0,0],[0,1],[1,0]],pcs:[0,4,7],quality:"major"},
  F:{coords:[[-1,0],[-1,1],[0,0]],pcs:[5,9,0],quality:"major"},
  G:{coords:[[1,0],[1,1],[2,0]],pcs:[7,11,2],quality:"major"},
  Am:{coords:[[-1,1],[0,0],[0,1]],pcs:[9,0,4],quality:"minor"},
  Dm:{coords:[[2,0],[3,0],[3,-1]],pcs:[2,9,5],quality:"minor"},
  Dm7:{coords:[[2,0],[3,0],[3,-1],[4,-1]],pcs:[2,9,5,0],quality:"minor"},
  G7:{coords:[[1,0],[1,1],[2,0],[3,-1]],pcs:[7,11,2,5],quality:"tension"},
  Cmaj7:{coords:[[0,0],[0,1],[1,0],[1,1]],pcs:[0,4,7,11],quality:"major"},
  Cm:{coords:[[0,0],[1,0],[1,-1]],pcs:[0,7,3],quality:"minor"},
  "A♭":{coords:[[0,-1],[1,-1],[0,0]],pcs:[8,3,0],quality:"major"}
};
const chordMidis = {
  C:[60,64,67],F:[65,69,72],G:[67,71,74],Am:[57,60,64],Dm:[62,65,69],
  Dm7:[62,65,69,72],G7:[55,59,62,65],Cmaj7:[60,64,67,71],Cm:[60,63,67],"A♭":[56,60,63]
};
function filmSVG(name){
  const shape=chordShapes[name];
  const offsets=[[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
  const coords=[...new Map(shape.coords.flatMap(([i,j])=>offsets.map(([di,dj])=>[i+di,j+dj])).map((coord)=>[coord.join(","),coord])).values()];
  const width=240,height=118;
  const unit=shape.coords.map((coord)=>point(coord,1));
  const minX=Math.min(...unit.map((p)=>p.x)),maxX=Math.max(...unit.map((p)=>p.x));
  const minY=Math.min(...unit.map((p)=>p.y)),maxY=Math.max(...unit.map((p)=>p.y));
  const hexPadding=1.18;
  const scale=Math.min((width-8)/(maxX-minX+hexPadding),(height-8)/(maxY-minY+hexPadding));
  const origin={x:width/2-(minX+maxX)*scale/2,y:height/2-(minY+maxY)*scale/2};
  return keyboardSVG({coords,width,height,scale,origin,highlight:shape.coords,quality:shape.quality,labels:true});
}

function flowHTML(flow, flowIndex) {
  const cells=[];
  flow.chords.forEach((chord,i)=>{
    cells.push(`<span class="chord-col"><small>${flow.romans[i]}</small><b>${chord}</b></span>`);
    if(i<flow.chords.length-1) cells.push('<span class="simple-arrow">→</span>');
  });
  return `<button type="button" class="progression" data-flow="${flowIndex}" aria-label="Play ${flow.chords.join(" to ")}"><span class="play-icon" aria-hidden="true">▶</span><span class="formula-flow" style="grid-template-columns:${flow.chords.map((_,i)=>i<flow.chords.length-1?"1fr auto":"1fr").join(" ")}">${cells.join("")}</span></button>`;
}

document.querySelector("#chordGrid").innerHTML=CHORDS.map((chord)=>`<button type="button" class="chord-card" data-chord="${chord.id}" aria-label="Play ${chord.id}">${chordSVG(chord,{width:330,height:220,scale:43,labels:true})}<h3>${chord.id}</h3></button>`).join("");
document.querySelector("#progressionGrid").innerHTML=flows.map(flowHTML).join("");
document.querySelector("#classicSnapshot").innerHTML=appLayoutSnapshot({layout:"classic"});
document.querySelector("#harmonicSnapshot").innerHTML=appLayoutSnapshot({layout:"harmonic"});
document.querySelector("#lumatoneVisual").insertAdjacentHTML("afterbegin",keyboardSVG({width:650,height:390,scale:48,origin:{x:325,y:215},labels:true,className:"lumatone-grid"}));

function renderFilm(flowIndex=0,active=-1){
  const flow=flows[flowIndex];
  const strip=document.querySelector("#filmstrip");
  strip.style.gridTemplateColumns=flow.chords.map((_,i)=>i<flow.chords.length-1?"1fr auto":"1fr").join(" ");
  strip.innerHTML=flow.chords.map((name,i)=>`<button type="button" class="film-cell ${i===active?"is-current":""}" data-film-step="${i}" aria-label="Play ${name}"><b>${name}</b>${filmSVG(name)}</button>${i<flow.chords.length-1?'<span class="film-arrow">→</span>':""}`).join("");
  if(active>0){
    const common=new Set(chordShapes[flow.chords[active-1]].pcs.filter((pc)=>chordShapes[flow.chords[active]].pcs.includes(pc)));
    strip.querySelectorAll(`.film-cell[data-film-step="${active}"] .lattice-key.is-highlight`).forEach((key)=>key.classList.add(common.has(Number(key.dataset.pc))?"is-common":"is-moving"));
  }
  strip.querySelectorAll(".film-cell").forEach((cell)=>cell.addEventListener("click",()=>{
    const step=Number(cell.dataset.filmStep);
    renderFilm(flowIndex,step);
    audio.chord(chordMidis[flow.chords[step]],strip.querySelector(`.film-cell[data-film-step="${step}"]`),900,flow.chords[step]);
  }));
}
renderFilm();

document.querySelectorAll(".chord-card").forEach((card)=>card.addEventListener("click",()=>{
  const chord=CHORDS.find((item)=>item.id===card.dataset.chord);
  if(chord) audio.chord(audio.midiForPcs(chord.pcs),card,1100,chord.id);
}));
document.querySelectorAll(".progression").forEach((card)=>card.addEventListener("click",()=>{
  const flowIndex=Number(card.dataset.flow);
  const columns=[...card.querySelectorAll(".chord-col")];
  audio.sequence(flows[flowIndex].chords.map((name)=>chordMidis[name]),card,(step)=>{
    columns.forEach((column,i)=>column.classList.toggle("is-current",i===step));
    renderFilm(flowIndex,step);
  });
}));

const lumatone=document.querySelector("#lumatoneVisual");
const cycleButton=document.createElement("button");
cycleButton.className="cycle-fifths";cycleButton.type="button";cycleButton.textContent="Play circle of fifths";cycleButton.dataset.resetLabel=cycleButton.textContent;lumatone.append(cycleButton);
lumatone.querySelectorAll(".lattice-key").forEach((key)=>{key.tabIndex=0;key.setAttribute("role","button");key.setAttribute("aria-label",`Play ${key.querySelector("text")?.textContent||"key"}`);});
lumatone.addEventListener("click",(event)=>{const key=event.target.closest(".lattice-key");if(key)audio.chord([60+Number(key.dataset.pc)],key,650);});
lumatone.addEventListener("keydown",(event)=>{if((event.key==="Enter"||event.key===" ")&&event.target.matches(".lattice-key")){event.preventDefault();event.target.dispatchEvent(new MouseEvent("click",{bubbles:true}));}});
cycleButton.addEventListener("click",(event)=>{
  event.stopPropagation();
  const pcs=[0,7,2,9,4,11,6,1,8,3,10,5,0];
  const keys=[...lumatone.querySelectorAll(".lattice-key")].sort((a,b)=>(Math.abs(Number(a.dataset.i))+Math.abs(Number(a.dataset.j)))-(Math.abs(Number(b.dataset.i))+Math.abs(Number(b.dataset.j))));
  audio.sequence(pcs.map((pc)=>[60+pc]),cycleButton,(step)=>{keys.forEach((key)=>key.classList.remove("is-cycle-current"));if(step>=0)keys.find((key)=>Number(key.dataset.pc)===pcs[step])?.classList.add("is-cycle-current");cycleButton.textContent=step<0?cycleButton.dataset.resetLabel:`Fifth ${step+1} / 13`;},420);
});

const periodTabs=[...document.querySelectorAll("[data-period-step]")];
const periodPanels=[...document.querySelectorAll("[data-period-panel]")];
function updatePeriodicity(){
  const step=activePage()==="lumatone"?Math.min(build,periodTabs.length-1):0;
  periodTabs.forEach((tab,i)=>{const selected=i===step;tab.classList.toggle("is-active",selected);tab.setAttribute("aria-selected",String(selected));tab.tabIndex=selected?0:-1;});
  periodPanels.forEach((panel,i)=>{const selected=i===step;panel.classList.toggle("is-active",selected);panel.hidden=!selected;panel.inert=!selected;panel.setAttribute("aria-hidden",String(!selected));});
}
periodTabs.forEach((tab)=>tab.addEventListener("click",()=>{build=Number(tab.dataset.periodStep);render();}));
document.querySelector("#periodTabs").addEventListener("keydown",(event)=>{if(!["ArrowLeft","ArrowRight"].includes(event.key))return;event.preventDefault();const delta=event.key==="ArrowRight"?1:-1;build=(build+delta+periodTabs.length)%periodTabs.length;render();periodTabs[build].focus();});
const baseC=261.625565;
document.querySelector("#pureFifthButton").addEventListener("click",(event)=>audio.frequencies([baseC,baseC*3/2],event.currentTarget,1300,"Pure fifth · 3:2"));
document.querySelector("#equalFifthButton").addEventListener("click",(event)=>audio.frequencies([baseC,baseC*Math.pow(2,7/12)],event.currentTarget,1300,"12-TET fifth · 2^(7/12)"));

document.querySelectorAll(".mode-card").forEach((card)=>{
  card.insertAdjacentHTML("beforeend",'<button class="compare-chord" type="button">Play C · E · G</button>');
  card.querySelector(".compare-chord").addEventListener("click",()=>audio.chord([60,64,67],card,1100,"C · E · G"));
  card.querySelectorAll(".snapshot-key").forEach((key)=>{key.tabIndex=0;key.setAttribute("role","button");key.setAttribute("aria-label",`Play MIDI ${key.dataset.midi}`);});
  card.addEventListener("click",(event)=>{const key=event.target.closest(".snapshot-key");if(key)audio.chord([Number(key.dataset.midi)],key,650);});
  card.addEventListener("keydown",(event)=>{if((event.key==="Enter"||event.key===" ")&&event.target.matches(".snapshot-key")){event.preventDefault();audio.chord([Number(event.target.dataset.midi)],event.target,650);}});
});
document.querySelector("#soundStopButton").addEventListener("click",()=>audio.stop());

function activeSlide(){return slides[index];}
function activePage(){return activeSlide().id;}
function maxBuildFor(i=index){return Number(slides[i].dataset.builds||0);}
function updateLattice(){
  const svg=lattice.querySelector("svg");if(!svg)return;
  const page=activePage();
  const visible=["kitaev","dual","pivot"].includes(page);lattice.hidden=!visible;lattice.inert=!visible;lattice.setAttribute("aria-hidden",String(!visible));
  svg.classList.remove("mode-kitaev","mode-dual","mode-pivot","dual-step-0","dual-step-1","dual-step-2");
  if(page==="kitaev"){svg.classList.add("mode-kitaev");svg.setAttribute("aria-label","Kitaev honeycomb lattice with two sublattices and x, y, z bonds");}
  else if(page==="dual"){svg.classList.add("mode-dual",`dual-step-${build}`);svg.setAttribute("aria-label","Honeycomb lattice and its triangular dual, without musical labels");}
  else if(page==="pivot"){svg.classList.add("mode-pivot");svg.setAttribute("aria-label","Playable Tonnetz note lattice");}
  lattice.querySelectorAll(".dual-site").forEach((node)=>{const playable=page==="pivot";node.tabIndex=playable?0:-1;node.setAttribute("aria-hidden",String(!playable));if(playable)node.setAttribute("role","button");else node.removeAttribute("role");});
  const triangle=lattice.querySelector(".major-triangle");if(triangle){const playable=page==="pivot";triangle.tabIndex=playable?0:-1;triangle.setAttribute("aria-hidden",String(!playable));if(playable)triangle.setAttribute("role","button");else triangle.removeAttribute("role");}
}
function setHash(){history.replaceState(null,"",`#${activePage()}`);}
function render({hash=true}={}){
  audio.stop();
  slides.forEach((slide,i)=>{const active=i===index;slide.classList.toggle("is-active",active);slide.setAttribute("aria-hidden",String(!active));});
  document.querySelectorAll(".build").forEach((el)=>{const shown=el.closest(".slide")===activeSlide()&&Number(el.dataset.build)<=build;el.classList.toggle("is-built",shown);el.inert=!shown;el.setAttribute("aria-hidden",String(!shown));});
  deck.dataset.page=activePage();deck.dataset.build=String(build);
  pageCount.textContent=`${index+1} / ${slides.length}`;pageCount.setAttribute("aria-label",`Page ${index+1} of ${slides.length}`);
  progress.style.width=`${((index+(maxBuildFor()?build/(maxBuildFor()+1):0)+1)/slides.length)*100}%`;
  prev.disabled=index===0&&build===0;next.disabled=index===slides.length-1&&build===maxBuildFor();updateLattice();updatePeriodicity();if(hash)setHash();
}
function forward(){if(build<maxBuildFor())build+=1;else if(index<slides.length-1){index+=1;build=0;}render();}
function backward(){if(build>0)build-=1;else if(index>0){index-=1;build=maxBuildFor();}render();}
function goFromHash(){const raw=location.hash.slice(1);const target=slides.findIndex((slide)=>slide.id===raw);if(target>=0){index=target;build=0;}render({hash:false});}
next.addEventListener("click",forward);prev.addEventListener("click",backward);
fullscreen.addEventListener("click",()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen?.());
document.addEventListener("keydown",(event)=>{if(event.defaultPrevented)return;const editing=event.target.closest?.("input,select,textarea");const interactive=event.target.closest?.("button,a,[role='button']");if(editing||((event.key===" "||event.key==="Enter")&&interactive))return;if(["ArrowRight","PageDown"," "].includes(event.key)){event.preventDefault();forward();}else if(["ArrowLeft","PageUp"].includes(event.key)){event.preventDefault();backward();}else if(event.key==="Home"){index=0;build=0;render();}else if(event.key==="End"){index=slides.length-1;build=0;render();}else if(event.key.toLowerCase()==="f")fullscreen.click();});
let pointerStart=null;
const contentSelector="button,a,input,select,textarea,[contenteditable='true'],[role='button'],[role='tab'],h1,h2,h3,p,small,blockquote,.katex,svg,.solution-map,.formula-card,.period-card,.lumatone-visual,.mode-card,.demo-card,.aigimon-links,.chord-grid,.filmstrip,.progression-grid";
function isBlankNavigationTarget(target){return Boolean(target.closest?.(".slide"))&&!target.closest?.(contentSelector)&&!window.getSelection()?.toString().trim();}
stage.addEventListener("pointerdown",(event)=>{pointerStart={x:event.clientX,y:event.clientY,button:event.button};});
stage.addEventListener("click",(event)=>{if(event.button!==0||!pointerStart||pointerStart.button!==0||Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y)>6||!isBlankNavigationTarget(event.target))return;forward();});
stage.addEventListener("contextmenu",(event)=>{if(!isBlankNavigationTarget(event.target))return;event.preventDefault();backward();});
window.addEventListener("hashchange",goFromHash);window.addEventListener("blur",()=>audio.stop());window.addEventListener("pagehide",()=>audio.stop());document.addEventListener("visibilitychange",()=>{if(document.hidden)audio.stop();});

lattice.innerHTML=latticeSceneSVG({mode:"pivot"});
document.querySelector("#coverLattice").innerHTML=latticeSceneSVG({mode:"kitaev"});
lattice.addEventListener("click",(event)=>{if(activePage()!=="pivot")return;const node=event.target.closest(".dual-site");if(node)audio.chord([60+Number(node.dataset.pc)],node,650);else if(event.target.closest(".major-triangle"))audio.chord([60,64,67],event.target.closest(".major-triangle"),1100,"C");});
lattice.addEventListener("keydown",(event)=>{if(event.key!=="Enter"&&event.key!==" ")return;const node=event.target.closest(".dual-site");if(node){event.preventDefault();audio.chord([60+Number(node.dataset.pc)],node,650);}else if(event.target.matches(".major-triangle")){event.preventDefault();audio.chord([60,64,67],event.target,1100,"C");}});
goFromHash();

window.TonnetzDeckBridge=Object.freeze({appLayoutSVG:(layout)=>appLayoutSnapshot({layout:layout==="harmonic"?"harmonic":"classic"}),chordSVG:(id)=>{const chord=CHORDS.find((item)=>item.id===id);return chord?chordSVG(chord):"";}});
