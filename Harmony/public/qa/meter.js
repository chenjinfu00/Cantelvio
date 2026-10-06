(() => {
 const analyzers = []; let maxRms=0;
 const original = AudioNode.prototype.connect;
 AudioNode.prototype.connect = function(destination,...args) {
  if (destination instanceof AudioDestinationNode) {
   const analyser=this.context.createAnalyser(); analyser.fftSize=512;
   original.call(this,analyser); original.call(analyser,destination,...args); analyzers.push(analyser); return destination;
  }
  return original.call(this,destination,...args);
 };
 document.addEventListener('DOMContentLoaded',()=>{
  const output=document.createElement('output'); output.id='qa-audio';
  output.style='position:fixed;left:6px;top:6px;z-index:99999;padding:4px;background:#000;color:#fff;font:11px monospace;pointer-events:none;max-width:700px;';document.body.append(output);
  setInterval(()=>{
   let rms=0;for(const a of analyzers){const buf=new Float32Array(a.fftSize);a.getFloatTimeDomainData(buf);rms+=Math.sqrt(buf.reduce((n,x)=>n+x*x,0)/buf.length)}
   maxRms=Math.max(rms,maxRms); const d=window.TonnetzAudio?.getDiagnostics?.()||{};
   output.textContent=JSON.stringify({...d,rms:+rms.toFixed(5),maxRms:+maxRms.toFixed(5)});
  },100);
 });
})();(()=>{const rows=[];let output;document.addEventListener('DOMContentLoaded',()=>{output=document.createElement('output');output.id='qa-pointer';output.style='position:fixed;left:6px;top:100px;background:black;color:white;z-index:99999;font:10px monospace;pointer-events:none';document.body.append(output)});for(const type of ['pointerdown','pointerup','click','pointercancel'])document.addEventListener(type,e=>{rows.push([type,e.target.id,e.target.getAttribute('aria-label'),e.pointerId,e.defaultPrevented]);if(output)output.textContent=JSON.stringify(rows.slice(-6))},true)})();
