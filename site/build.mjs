#!/usr/bin/env node
// Assemble the static Cantelvio demo site into ../site-dist/ (GitHub Pages ready).
//   /            landing page (site/index.html)
//   /score/      Score editor (Vite build, base './'; reuses Score/apps/web/dist unless --build)
//   /harmony/    Harmony (Tonnetz) public pages
//   /stage/      Stage (Volta) docs/ PWA
//   /results/    results page (site/results) + listening clips from Compose/training/reports/amt-compare-20261005
//   /compose/    Compose in-browser pages (orchestra joint model, QA); the main page and four-pillar need the local Python service and are NOT published
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execSync} from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = path.join(root, 'site-dist');
const rebuild = process.argv.includes('--build');
const copy = (from, to) => fs.cpSync(path.join(root, from), path.join(out, to), {recursive: true, dereference: true});
const skip = (src) => !/(^|\/)(\.DS_Store|node_modules|\.git)(\/|$)/.test(src);

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});

fs.copyFileSync(path.join(root, 'site/index.html'), path.join(out, 'index.html'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

if (rebuild) execSync('npm run build', {cwd: path.join(root, 'Score'), stdio: 'inherit'});
const scoreDist = 'Score/apps/web/dist';
if (!fs.existsSync(path.join(root, scoreDist, 'index.html'))) throw new Error('Score dist missing; run with --build');
fs.cpSync(path.join(root, scoreDist), path.join(out, 'score'), {recursive: true, filter: (s) => skip(s) && !s.endsWith('.map')});

fs.cpSync(path.join(root, 'Harmony/public/tonnetz'), path.join(out, 'harmony'), {recursive: true, filter: skip});
fs.cpSync(path.join(root, 'Stage/docs'), path.join(out, 'stage'), {recursive: true, filter: (s) => skip(s) && !/\/(library|sources|fit)(\/|$)/.test(s)});

// Compose: browser-only pages and their vendored model/audio assets.
const cf = 'Compose/frontend';
fs.mkdirSync(path.join(out, 'compose'), {recursive: true});
for (const d of ['orchestra', 'vendor', 'media', 'src']) {
  if (fs.existsSync(path.join(root, cf, d))) fs.cpSync(path.join(root, cf, d), path.join(out, 'compose', d), {recursive: true, dereference: true, filter: skip});
}
for (const f of ['style.css', 'favicon.svg']) fs.copyFileSync(path.join(root, cf, f), path.join(out, 'compose', f));

// Results page and its listening clips.
fs.mkdirSync(path.join(out, 'results'), {recursive: true});
for (const f of fs.readdirSync(path.join(root, 'site/results'))) fs.copyFileSync(path.join(root, 'site/results', f), path.join(out, 'results', f));
const clips = path.join(root, 'Compose/training/reports/amt-compare-20261005');
fs.mkdirSync(path.join(out, 'results/audio'), {recursive: true});
let nClips = 0;
for (const f of fs.existsSync(clips) ? fs.readdirSync(clips) : []) if (f.endsWith('.mp3')) { fs.copyFileSync(path.join(clips, f), path.join(out, 'results/audio', f)); nClips++; }
if (nClips !== 9) console.warn(`warning: expected 9 listening clips, found ${nClips}`);

let bytes = 0, files = 0;
(function walk(d) { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (files++, bytes += fs.statSync(p).size); } })(out);
console.log(`site-dist: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
