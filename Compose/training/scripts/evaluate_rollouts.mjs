/** Free-running evaluation. node training/scripts/evaluate_rollouts.mjs [BASELINE_IMPROVISATION_MODULE] */
import {pathToFileURL} from 'node:url';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {voiceChord} from '../../vendor/lib/harmony-models.js';
const root=resolve(import.meta.dirname,'..'),old=process.argv[2];
const modules={current:await import('../../vendor/improvisation.js')};
if(old)modules.baseline=await import(pathToFileURL(resolve(old)));
const rng=(seed)=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const pc=n=>((n%12)+12)%12,mean=a=>a.reduce((s,n)=>s+n,0)/Math.max(1,a.length);
const jaccard=(a,b)=>{const aa=new Set(a),bb=new Set(b);return [...aa].filter(x=>bb.has(x)).length/Math.max(1,new Set([...aa,...bb]).size);};
const contour=notes=>notes.slice(1).map((e,i)=>Math.sign(e.midi-notes[i].midi)).map((_,i,a)=>i+1<a.length?`${a[i]},${a[i+1]}`:null).filter(x=>x!==null);
const progressions=[['C','G','Am','F','C','G','F','C'],['Dm7','G7','Cmaj7','Am7','Dm7','G7','Cmaj7','Cmaj7'],['C7','F7','C7','G7','F7','G7','C7','C7'],['Am','F','Dm','E7','Am','F','E7','Am']];
const output={protocol:{seeds:12,styles:['pop','jazz','blues','classical','ambient'],bars:8,progressions,interpretation:'Descriptive free-running measurements, not listening-quality scores. Rhythm/motif recurrence are desired structural signals, not proof of musicality.'}},examples={};
for(const [version,{createMelodyPerformer}] of Object.entries(modules)){
 const styles={};let totalEvents=0,totalMs=0;
 for(const style of output.protocol.styles){
  const density=[],stepwise=[],repeated=[],tensions=[],resolved=[],breathing=[],rhythmRecall=[],contourRecall=[],velRange=[],latency=[],maxRuns=[];
  for(let seed=1;seed<=12;seed++){
   const player=createMelodyPerformer({random:rng(seed*871)}),ids=progressions[(seed-1)%4],bars=[];let prev=null,pending=null,all=[];
   for(let bar=0;bar<8;bar++){
    const chord=voiceChord(ids[bar]),tones=chord.map(pc),start=performance.now();
    const r=player.plan(chord,{enabled:true,chordId:ids[bar],nextChord:voiceChord(ids[(bar+1)%8]),bar,style,density:.6,feel:.7,key:{tonic:0,mode:ids[0]==='Am'?'minor':'major'},bpm:96});
    latency.push(performance.now()-start);bars.push(r.events);totalEvents+=r.events.length;
    const barDur=2.5;
    if([3,7].includes(bar))breathing.push(barDur-(r.events.at(-1)?.time+(r.events.at(-1)?.duration)||0));
    for(const e of r.events){
     if(prev!==null){stepwise.push(+(Math.abs(e.midi-prev)<=2));repeated.push(+(e.midi===prev));}
     if(pending!==null){resolved.push(+(tones.includes(pc(e.midi))&&Math.abs(e.midi-pending)<=2));pending=null;}
     const tension=!tones.includes(pc(e.midi));tensions.push(+tension);if(tension)pending=e.midi;prev=e.midi;all.push({...e,bar});
    }
   }
   let run=0,longest=0,last=null;for(const e of all){run=e.midi===last?run+1:1;last=e.midi;longest=Math.max(longest,run);}maxRuns.push(longest);
   density.push(all.length/8);rhythmRecall.push(mean([0,1].map(i=>jaccard(bars[i].map(e=>e.beat),bars[i+6].map(e=>e.beat)))));contourRecall.push(mean([0,1].map(i=>jaccard(contour(bars[i]),contour(bars[i+6])))));
   velRange.push(Math.max(...all.map(e=>e.velocity))-Math.min(...all.map(e=>e.velocity)));
   if(seed===1)examples[`${version}-${style}`]=all;
  }
  totalMs+=latency.reduce((a,b)=>a+b,0);styles[style]={eventsPerBar:mean(density),maxConsecutiveAttacks:Math.max(...maxRuns),phrasesWithFiveRepeatedAttacks:maxRuns.filter(n=>n>=5).length,stepwiseRate:mean(stepwise),repeatRate:mean(repeated),nonChordRate:mean(tensions),stepResolutionRate:mean(resolved),cadenceBreathSeconds:mean(breathing),rhythmReturnJaccard:mean(rhythmRecall),contourReturnJaccard:mean(contourRecall),velocityRange:mean(velRange),meanBarInferenceMs:mean(latency),p95BarInferenceMs:latency.sort((a,b)=>a-b)[Math.floor(latency.length*.95)]};
 }
 output[version]={styles,totalEvents,meanEventInferenceMs:totalMs/totalEvents};
}
writeFileSync(resolve(root,'reports/current-rollouts.json'),JSON.stringify(output,null,2));writeFileSync(resolve(root,'reports/current-listening-examples.json'),JSON.stringify(examples));console.log(JSON.stringify(output,null,2));
