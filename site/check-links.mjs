#!/usr/bin/env node
// Check public-page links, anchors and deployment boundaries, including project subpaths.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const out = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'site-dist');
if (!fs.existsSync(out)) { console.error('site-dist missing; run `npm run site` first'); process.exit(2); }
const pages = [];
(function walk(d) { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.html')) pages.push(p); } })(out);
let bad = 0;
const fail = message => { console.error(message); bad++; };
for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8');
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
for (const relative of ['score/index.html', 'compose/index.html', 'compose/orchestra/joint.html', 'harmony/index.html', 'stage/index.html', 'results/index.html', 'version.json']) {
  if (!fs.existsSync(path.join(out, relative))) fail(`missing public entry: ${relative}`);
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
