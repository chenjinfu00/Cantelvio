#!/usr/bin/env node
// Check that every relative src/href in the built site's HTML files points at a file that exists.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const out = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'site-dist');
if (!fs.existsSync(out)) { console.error('site-dist missing; run `npm run site` first'); process.exit(2); }
const pages = [];
(function walk(d) { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.html')) pages.push(p); } })(out);
let bad = 0;
for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|mailto:|data:|#|\/\/|javascript:)/.test(ref) || ref.startsWith('/')) continue;
    const target = path.resolve(path.dirname(page), decodeURIComponent(ref.split(/[?#]/)[0] || '.'));
    const ok = fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.existsSync(path.join(target, 'index.html')));
    if (!ok) { console.error(`missing: ${path.relative(out, page)} -> ${ref}`); bad++; }
  }
}
console.log(`checked ${pages.length} html files, ${bad} broken link(s)`);
process.exit(bad ? 1 : 0);
