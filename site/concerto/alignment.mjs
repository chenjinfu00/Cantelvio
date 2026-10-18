export const SCORE_BASIS='chopin-op21-score-v1';
const finite=n=>typeof n==='number' && Number.isFinite(n);
function interpolate(points,value,input,output){
  if(value<=points[0][input])return points[0][output];
  if(value>=points.at(-1)[input])return points.at(-1)[output];
  let lo=0,hi=points.length-1;
  while(hi-lo>1){const mid=(lo+hi)>>1;if(points[mid][input]<=value)lo=mid;else hi=mid;}
  const a=points[lo],b=points[hi];return a[output]+(value-a[input])/(b[input]-a[input])*(b[output]-a[output]);
}
// Playback keeps the original expressive MIDI clock. Only score coordinates change.
export class ScoreMap {
  constructor(data,expectedMidiSha){
    const bad=()=>{throw Error('谱面定位资料不匹配，请刷新重试 / Score alignment does not match; reload to retry');};
    if(data?.schema!=='cantelvio-score-map/1' || data.midiSha256!==expectedMidiSha || data.workId!=='chopin-op21-1' || data.measureCount!==348 || data.pickupQuarters!==1.25 || !Array.isArray(data.knots) || data.knots.length<1396 || data.knots.length>12000)bad();
    this.points=data.knots.map(point=>{if(!Array.isArray(point) || point.length!==2 || !point.every(finite))bad();return [...point];});
    for(let i=0;i<this.points.length;i++){
      const point=this.points[i],previous=this.points[i-1];
      if(point[0]<-1.25 || point[0]>1392 || point[1]<0 || point[1]>2000 || previous && (point[0]<=previous[0] || point[1]<=previous[1]))bad();
    }
    if(this.points[0][0]!==-1.25 || this.points.at(-1)[0]!==1392)bad();
    for(let quarter=0;quarter<=1392;quarter++)if(!this.points.some(p=>p[0]===quarter))bad();
    this.freeRanges=data.freeRanges || [];
    if(!Array.isArray(this.freeRanges) || this.freeRanges.some(r=>!Array.isArray(r) || r.length!==2 || !r.every(finite) || r[0]<0 || r[1]>1392 || r[0]>=r[1]))bad();
    this.measureCount=348;this.basis=SCORE_BASIS;this.firstNote=this.points[0][1];this.endBeat=this.points.at(-1)[1];this.source=data.source;
  }
  quarterAt(beat){return interpolate(this.points,beat,1,0);}
  midiAt(quarter){return interpolate(this.points,quarter,0,1);}
  atBeat(beat){
    const q=this.quarterAt(beat);
    if(beat<this.firstNote-1e-8)return {measure:0,beat:3.75,pickup:true,preparing:true,complete:false};
    if(q< -1e-8)return {measure:0,beat:5+q,pickup:true,preparing:false,complete:false};
    if(beat>=this.endBeat-1e-8)return {measure:348,beat:4,complete:true,pickup:false,preparing:false};
    const measure=Math.min(348,Math.floor((q+1e-8)/4)+1);
    return {measure,beat:1+Math.max(0,q-(measure-1)*4),pickup:false,preparing:false,complete:false,freeTime:this.freeRanges.some(([a,b])=>q>=a && q<b)};
  }
  atMeasure(measure){
    if(!Number.isInteger(measure) || measure<0 || measure>348)throw Error('请选择原谱第0–348小节 / Choose score bar 0–348');
    return measure===0?0:this.midiAt((measure-1)*4);
  }
  bpmAt(beat,clock,rate=1){
    const q=this.quarterAt(beat),lo=Math.max(-1.25,q-.5),hi=Math.min(1392,q+.5);
    const seconds=clock.seconds(this.midiAt(hi))-clock.seconds(this.midiAt(lo));
    return seconds>0?60*(hi-lo)/seconds*rate:0;
  }
}
let cached;
export async function loadScoreMap(expectedMidiSha,{fetcher=globalThis.fetch}={}){
  if(cached?.sha===expectedMidiSha)return cached.map;
  const response=await fetcher(new URL('./assets/chopin-op21-alignment.json?v=20261018-score-1',import.meta.url),{credentials:'omit',redirect:'error'});
  if(!response.ok)throw Error('谱面定位下载失败，请刷新重试 / Score alignment download failed; reload to retry');
  const text=await response.text();if(text.length>500000)throw Error('Invalid score alignment size');
  const map=new ScoreMap(JSON.parse(text),expectedMidiSha);cached={sha:expectedMidiSha,map};return map;
}
export function scoreStart(settings,map,rawMeter){
  if(!map)return {...settings,positionBasis:'midi',measure:Math.max(1,settings.measure)};
  if(settings.positionBasis===SCORE_BASIS)return {...settings,measure:Math.min(348,Math.max(0,settings.measure))};
  return {...settings,positionBasis:SCORE_BASIS,measure:settings.measure===1?0:map.atBeat(rawMeter.atMeasure(settings.measure)).measure};
}
