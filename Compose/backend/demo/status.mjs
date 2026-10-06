import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=new URL('../../',import.meta.url);
async function present(relative) { try { return (await stat(fileURLToPath(new URL(relative,root)))).isFile(); } catch { return false; } }
export async function demoStatus() {
  let composer=null,scoreReady=false;
  try { const r=await fetch('http://127.0.0.1:8766/health',{signal:AbortSignal.timeout(2000)});if(r.ok) composer=await r.json(); } catch {}
  try { const r=await fetch('http://127.0.0.1:5178/',{signal:AbortSignal.timeout(2000)});scoreReady=r.ok; } catch {}
  return {composer,scoreReady,scoreUrl:'http://127.0.0.1:5178/',serviceUrl:'http://127.0.0.1:8766',
    performanceReady:await present('training/runs/four-pillar-v2-preview-20261001-step19193/state.pt'),
    amtDownloaded:await present('Anticipatory-Music-Transformer/DOWNLOAD_MANIFEST.json'),amtReady:false};
}
