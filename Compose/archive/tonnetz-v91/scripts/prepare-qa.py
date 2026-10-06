from pathlib import Path
root=Path(__file__).resolve().parents[1]/'public'
qa=root/'qa'; qa.mkdir(exist_ok=True)
html=(root/'tonnetz/index.html').read_text().replace('<head>','<head><base href="/tonnetz/"><script src="/qa/meter.js"></script>',1)
(qa/'index.html').write_text(html)
(qa/'meter.js').write_text(r'''(() => {
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
})();''')
for label,width,height in [('phone',390,700),('tablet',1024,700)]:
 (qa/(label+'.html')).write_text(f'<!doctype html><meta name="viewport" content="width=device-width"><style>body{{margin:0;background:#555}}iframe{{display:block;width:{width}px;height:{height}px;border:0;}}</style><iframe title="{label} Tonnetz preview" src="/qa/index.html" allow="autoplay"></iframe>')
print('Temporary QA fixtures prepared (outside production /tonnetz)')
