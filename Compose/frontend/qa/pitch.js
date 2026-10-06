import {AudioEngine} from '../src/audio.js';
import {routeInstrumentBar,nativeInstrumentBoard} from '../src/instrument-board.js';
import {ORCHESTRA_GROUP_IDS} from '../src/orchestration.js';
const result=document.querySelector('#result');
function dominantFrequency(pcm,offset,sampleRate){
  const size=16384,re=new Float64Array(size),im=new Float64Array(size);
  for(let i=0;i<size;i++)re[i]=pcm[offset+i]*(.5-.5*Math.cos(2*Math.PI*i/(size-1)));
  for(let i=1,j=0;i<size;i++){let bit=size>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)[re[i],re[j]]=[re[j],re[i]];}
  for(let width=2;width<=size;width*=2)for(let start=0;start<size;start+=width)for(let j=0;j<width/2;j++){
    const angle=-2*Math.PI*j/width,c=Math.cos(angle),s=Math.sin(angle),left=start+j,right=left+width/2;
    const tr=re[right]*c-im[right]*s,ti=re[right]*s+im[right]*c;
    re[right]=re[left]-tr;im[right]=im[left]-ti;re[left]+=tr;im[left]+=ti;
  }
  let peak=1,power=0;for(let i=1;i<size/2;i++){const p=re[i]**2+im[i]**2;if(p>power){power=p;peak=i;}}
  return peak*sampleRate/size;
}
document.querySelector('#run').onclick=async()=>{
  document.querySelector('#run').disabled=true;
  try{
    const fixture=await (await fetch('./v2-pitch-fixture.json')).json();
    const board=nativeInstrumentBoard();for(const id of ORCHESTRA_GROUP_IDS)board.lanes[id].enabled=true;
    const rows=[];
    const notes=[...fixture.notes,...['brass','high_strings','percussion'].map(group=>({pitch:69,group,role:0,key:'control:'+group,control:true}))];
    for(const note of notes){
      result.textContent=`Rendering ${rows.length+1}/${notes.length}…`;
      const source={midi:note.pitch,modelPitch:note.pitch,nativeGroup:note.group,exactPitch:true,role:['harmony','bass','melody'][note.role],time:0,duration:.65,velocity:.6,sourceKey:note.key};
      const events=routeInstrumentBar({events:[source]},board,{},0);
      if(events.length!==1)throw Error('Missing or duplicate routed note');
      const context=new OfflineAudioContext(1,44100,44100),audio=new AudioEngine({context});
      audio.setOrchestra({enabled:true,mix:1,groups:Object.fromEntries(ORCHESTRA_GROUP_IDS.map(id=>[id,'on']))});
      audio.play(events[0],.03);
      const pcm=(await context.startRendering()).getChannelData(0);
      const expected=440*2**((note.pitch-69)/12);
      // Find the dominant peak independently of the expected pitch, then refine it.
      const offset=8820,length=17640;
      const magnitude=hz=>{let re=0,im=0;for(let i=0;i<length;i++){const value=pcm[offset+i]*(.5-.5*Math.cos(2*Math.PI*i/(length-1)));const phase=2*Math.PI*hz*i/44100;re+=value*Math.cos(phase);im+=value*Math.sin(phase);}return re*re+im*im;};
      const coarse=dominantFrequency(pcm,offset,44100);
      let best=coarse,power=-1;
      for(let hz=Math.max(1,coarse-3);hz<=coarse+3;hz+=.1){const p=magnitude(hz);if(p>power){power=p;best=hz;}}
      const center=best;for(let hz=center-.12;hz<=center+.12;hz+=.01){const p=magnitude(hz);if(p>power){power=p;best=hz;}}
      const cents=1200*Math.log2(best/expected);
      rows.push({source:note.control?'audio-engine control':'actual model note',group:note.group,modelMidi:note.pitch,scheduledMidi:events[0].midi,expectedHz:+expected.toFixed(3),measuredHz:+best.toFixed(3),cents:+cents.toFixed(2),pass:power>1e-10&&events[0].midi===note.pitch&&Math.abs(cents)<=2});
    }
    result.textContent=JSON.stringify({checkpoint:fixture.checkpoint,total:rows.length,passed:rows.filter(r=>r.pass).length,rows},null,2);
  }catch(error){result.textContent='Failed: '+error.message;}
  finally{document.querySelector('#run').disabled=false;}
};
