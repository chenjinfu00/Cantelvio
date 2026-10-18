#!/usr/bin/env node
// Check public-page links, anchors and deployment boundaries, including project subpaths.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {PUBLISHED_ASSETS} from './concerto/preset.mjs';
import {ScoreMap} from './concerto/alignment.mjs';
const index = process.argv.indexOf('--out');
if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))) throw new Error('--out needs a path');
const out = index >= 0 ? path.resolve(process.argv[index + 1]) : path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'site-dist');
if (!fs.existsSync(out)) { console.error('site-dist missing; run `npm run site` first'); process.exit(2); }
const pages = [];
(function walk(d) { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.html')) pages.push(p); } })(out);
let bad = 0;
const fail = message => { console.error(message); bad++; };
for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8');
  if (!html.includes('data-cv-app=') || !html.includes('appearance.js')) fail(`missing shared appearance: ${path.relative(out, page)}`);
  if (/AI(?:<[^>]*>)*legro/i.test(html)) fail(`old visible branding: ${path.relative(out, page)}`);
  for (const m of html.matchAll(/\b(src|href|poster)=["']([^"']+)["']/g)) {
    const [, attr, ref] = m;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(?:[:/]|$)/i.test(ref)) {
      fail(`local-only URL: ${path.relative(out, page)} -> ${ref}`); continue;
    }
    if (/^(https?:|mailto:|data:|\/\/|javascript:)/.test(ref)) continue;
    if (ref.startsWith('/')) { fail(`origin-root URL breaks project hosting: ${path.relative(out, page)} -> ${ref}`); continue; }
    const [pathname, hash] = ref.split('#');
    let target = path.resolve(path.dirname(page), decodeURIComponent(pathname.split('?')[0] || (hash ? path.basename(page) : '.')));
    if (!target.startsWith(out + path.sep) && target !== out) { fail(`outside site: ${path.relative(out, page)} -> ${ref}`); continue; }
    const ok = fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.existsSync(path.join(target, 'index.html')));
    if (!ok) { fail(`missing: ${path.relative(out, page)} -> ${ref}`); continue; }
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    if (attr === 'href' && hash && target.endsWith('.html')) {
      const ids = [...fs.readFileSync(target, 'utf8').matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
      if (!ids.includes(decodeURIComponent(hash))) fail(`missing anchor: ${path.relative(out, page)} -> ${ref}`);
    }
  }
}
for (const relative of ['index.html', 'demo/index.html', 'workspace.css', 'language.js', 'score/index.html', 'compose/index.html', 'compose/orchestra/joint.html', 'harmony/index.html', 'stage/index.html', 'results/index.html', 'version.json', 'appearance/common.css', 'appearance/appearance.js', 'appearance/core.mjs']) {
  if (!fs.existsSync(path.join(out, relative))) fail(`missing public entry: ${relative}`);
}
for (const file of ['index.html','play.html','app.mjs','session.mjs','preset.mjs','remembered.mjs','alignment.mjs','assets/chopin-op21-alignment.json','midi.mjs','transport.mjs','follower.mjs','audio.mjs','demo.mjs','style.css','vendor/synth.js','vendor/processor.js']) {
  if (!fs.existsSync(path.join(out,'concerto',file))) fail(`missing Concerto browser asset: ${file}`);
}
for (const file of ['stage/matcher.js','stage/capture-worklet.js','stage/vendor/pdf.mjs','stage/vendor/pdf.worker.mjs','score/audio/soundfonts/MuseScore_General.sf3','score/licenses/spessasynth_lib/LICENSE','score/licenses/spessasynth_core/LICENSE']) {
  if (!fs.existsSync(path.join(out,file))) fail(`missing Concerto dependency: ${file}`);
}
const allowedMedia=new Map(PUBLISHED_ASSETS.map(asset=>[asset.path,asset]));
try {new ScoreMap(JSON.parse(fs.readFileSync(path.join(out,'concerto/assets/chopin-op21-alignment.json'),'utf8')),PUBLISHED_ASSETS[0].sha256);}catch(error){fail(`invalid published score alignment: ${error.message}`);}
for (const asset of PUBLISHED_ASSETS){
  const file=path.join(out,'concerto',asset.path);
  if(!fs.existsSync(file))fail(`missing approved Concerto resource: ${asset.path}`);
  else {const bytes=fs.readFileSync(file);if(bytes.length!==asset.bytes || createHash('sha256').update(bytes).digest('hex')!==asset.sha256)fail(`Concerto resource identity mismatch: ${asset.path}`);}
}
for (const entry of fs.readdirSync(path.join(out,'concerto'),{recursive:true})) {
  if (/\.(pdf|mid|midi|wav|mp3|concerto)$/i.test(entry) && !allowedMedia.has(entry) || /(^|\/)(local|\.runtime_cache)(\/|$)/.test(entry)) fail(`unapproved media in Concerto bundle: ${entry}`);
}
const stageManifest = path.join(out, 'stage/cache-manifest.json');
if (!fs.existsSync(stageManifest)) fail('missing Stage offline cache manifest');
else for (const ref of JSON.parse(fs.readFileSync(stageManifest, 'utf8'))) {
  if (typeof ref !== 'string' || !ref.startsWith('./')) { fail(`invalid Stage offline asset: ${ref}`); continue; }
  const target = path.resolve(path.dirname(stageManifest), ref);
  if (!target.startsWith(path.dirname(stageManifest) + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) fail(`missing Stage offline asset: ${ref}`);
  if (ref === './.nojekyll') fail('Stage offline cache contains deployment-only .nojekyll');
}
(function checkPublishedFiles(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) checkPublishedFiles(file);
    else if (entry.isSymbolicLink() || /\.(pt|pth|ckpt|safetensors)$/i.test(entry.name)) fail(`unexpected published training asset: ${path.relative(out, file)}`);
  }
})(out);
console.log(`checked ${pages.length} html files, ${bad} broken link(s)`);
process.exit(bad ? 1 : 0);
