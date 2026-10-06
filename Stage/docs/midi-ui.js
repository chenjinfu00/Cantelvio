import {parseMIDI} from './midi-file.js';
import {Piano} from './piano.js';
import {MIDIPlayer} from './midi-player.js';
const $=id=>document.getElementById(id);
export const clock=seconds=>{
  const total=Math.max(0,Math.round(seconds||0));
  return Math.floor(total/60)+':'+String(total%60).padStart(2,'0');
};

export function setupMIDI({sources=()=>[],url=()=>null,toast=()=>{}}={}){
  const bar=$('midi-bar');if(!bar)return null;
  const play=$('midi-play'),pick=$('midi-pick'),seek=$('midi-seek'),time=$('midi-time'),status=$('midi-status');
  let piano=null,player=null,loaded=null,list=[];
  function show(position,duration){
    seek.disabled=!duration;
    if(document.activeElement!==seek)seek.value=duration?Math.round(position/duration*1000):0;
    time.textContent=`${clock(position)} / ${clock(duration)}`;
    play.textContent=player?.playing?'⏸ 暂停':'▶ 播放';
  }
  async function engine(){
    if(!piano){
      const Context=window.AudioContext||window.webkitAudioContext;
      piano=new Piano({context:new Context()});
      player=new MIDIPlayer({piano,onProgress:show,onEnd:()=>{status.textContent='播放结束。';show(0,player.duration);}});
    }
    if(piano.context.state==='suspended')await piano.context.resume();
    if(!piano.ready){
      status.textContent='正在载入钢琴音色…';
      await piano.load((done,total)=>{status.textContent=`正在载入钢琴音色 ${done}/${total}…`;});
      status.textContent='';
    }
    return player;
  }
  async function open(name){
    const player=await engine();
    if(loaded===name)return player;
    const address=url(name);
    if(!address)throw new Error('这份 MIDI 暂时取不到。');
    status.textContent='正在读取 MIDI…';
    const response=await fetch(address,{cache:'force-cache'});
    if(!response.ok)throw new Error('MIDI 读取失败。');
    player.load(parseMIDI(await response.arrayBuffer()));
    loaded=name;status.textContent='';
    return player;
  }
  play.onclick=async()=>{
    try{
      if(player?.playing)return player.pause();
      play.disabled=true;
      const ready=await open(pick.value);
      ready.play();show(ready.position,ready.duration);
    }catch(error){status.textContent=error.message;toast(error.message);}
    finally{play.disabled=!list.length;}
  };
  pick.onchange=()=>{player?.stop();loaded=null;status.textContent='';};
  seek.oninput=()=>{if(player?.duration)time.textContent=`${clock(seek.value/1000*player.duration)} / ${clock(player.duration)}`;};
  seek.onchange=()=>{if(player?.duration)player.seek(seek.value/1000*player.duration);};
  return {
    setScore(item){
      player?.stop();loaded=null;status.textContent='';
      list=(item?.sources||[]).filter(source=>source.kind==='midi');
      bar.hidden=!list.length;
      pick.hidden=list.length<2;pick.textContent='';
      for(const source of list){
        const option=document.createElement('option');
        option.value=source.name;option.textContent=source.name.replace(/\.midi?$/i,'');
        pick.append(option);
      }
      play.disabled=!list.length;
      show(0,0);
    },
    stop(){player?.stop();},
  };
}
