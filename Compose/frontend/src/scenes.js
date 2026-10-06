import { INSTRUMENTS, BASS_INSTRUMENTS, MELODY_INSTRUMENTS, STYLES, GROOVES } from './instruments.js';
import { DEFAULT_ORCHESTRA_GROUPS } from './orchestration.js';
import { defaultInstrumentBoard } from './instrument-board.js';

export const SCENES = [
 {id:'warm',name:'Warm Piano',zh:'暖音钢琴',tag:'Art-song piano · open space',tagZh:'艺术歌曲钢琴 · 留白',color:'#dda75b',style:'lieder',meter:4,groove:'straight',chordInstrument:'piano',bassInstrument:'piano',melodyInstrument:'piano',harmonyT:.8,melodyT:.8,density:.5,feel:.65,mix:{harmony:.75,bass:.64,melody:.66}},
 {id:'velvet',name:'Velvet Jazz',zh:'丝绒爵士',tag:'Electric keys · swing',tagZh:'电钢琴 · 摇摆',color:'#b299da',style:'jazz',meter:4,groove:'swing',chordInstrument:'epiano',bassInstrument:'electric-bass',melodyInstrument:'reed-lead',harmonyT:.85,melodyT:.8,density:.5,feel:.72,mix:{harmony:.67,bass:.76,melody:.57}},
 {id:'indie',name:'Indie Drive',zh:'独立摇滚',tag:'Guitar · steady drive',tagZh:'吉他 · 稳定律动',color:'#da917b',style:'blues',meter:4,groove:'straight',chordInstrument:'electric-guitar',bassInstrument:'electric-bass',melodyInstrument:'electric-guitar',harmonyT:.8,melodyT:.82,density:.55,feel:.55,mix:{harmony:.62,bass:.69,melody:.66}},
 {id:'air',name:'Open Air',zh:'旷野氛围',tag:'Slow bloom · suspended light',tagZh:'缓慢展开 · 悬浮光影',color:'#8ebdc0',style:'ambient',meter:4,groove:'straight',chordInstrument:'pad',bassInstrument:'synth-bass',melodyInstrument:'bell',harmonyT:.75,melodyT:.7,density:.4,feel:.5,mix:{harmony:.68,bass:.53,melody:.52}}
];
for(const scene of SCENES)Object.assign(scene,{melodyRegister:'middle'});
export const SCENE_FIELDS=['style','meter','groove','chordInstrument','bassInstrument','melodyInstrument','melodyRegister','harmonyT','melodyT','density','feel','mix'];
export function snapshotScene(state){return Object.fromEntries(SCENE_FIELDS.map(k=>[k,structuredClone(state[k])]));}

const LEGACY_STYLE={pop:'pop',jazz:'jazz',classical:'classical'};
const valid=(list,id)=>list.some(e=>e.id===id);
/** Scene data saved by this or the earlier (Harmony v2 / Melody v5) console, made
 * complete: unknown or retired fields are dropped, missing ones come from the preset. */
export function normalizeScene(data,presetId='warm'){
 const preset=snapshotScene(SCENES.find(s=>s.id===presetId)||SCENES[0]),out={...preset};
 if(!data||typeof data!=='object')return out;
 for(const k of SCENE_FIELDS)if(data[k]!==undefined)out[k]=structuredClone(data[k]);
 if(data.style===undefined&&LEGACY_STYLE[data.harmonyStyle])out.style=LEGACY_STYLE[data.harmonyStyle];
 if(data.meter===undefined&&data.rhythm==='waltz')out.meter=3;
 if(data.groove===undefined&&data.rhythm==='swing')out.groove='swing';
 if(!valid(STYLES,out.style))out.style=preset.style;
 if(![2,3,4,5,6,9,12].includes(Number(out.meter)))out.meter=4;
 if(!valid(GROOVES,out.groove))out.groove=preset.groove;
 if(!valid(INSTRUMENTS,out.chordInstrument))out.chordInstrument=preset.chordInstrument;
 if(!valid(BASS_INSTRUMENTS,out.bassInstrument))out.bassInstrument=preset.bassInstrument;
 if(!valid(MELODY_INSTRUMENTS,out.melodyInstrument))out.melodyInstrument=preset.melodyInstrument;
 if(!['middle','high'].includes(out.melodyRegister))out.melodyRegister='middle';
 for(const k of ['harmonyT','melodyT','density','feel'])if(!Number.isFinite(out[k]))out[k]=preset[k];
 out.mix={...preset.mix,...(out.mix&&typeof out.mix==='object'?out.mix:{})};
 return out;
}
export function defaults(){return {...snapshotScene(SCENES[0]),scene:'warm',bpm:92,mode:'hold',changeMode:'bar',key:{tonic:0,mode:'major'},keyWalk:false,keyEvery:8,melodyOn:false,bassOn:true,randomScenes:false,randomEvery:8,master:.8,mutes:{harmony:false,bass:false,melody:false},orchestra:{enabled:false,mix:.55,groups:{...DEFAULT_ORCHESTRA_GROUPS}},instrumentBoard:defaultInstrumentBoard()};}
