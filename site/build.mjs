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
import {execSync, execFileSync} from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = path.join(root, 'site-dist');
const rebuild = process.argv.includes('--build');
const skip = (src) => !/(^|\/)(\.DS_Store|node_modules|\.git)(\/|$)/.test(src);
const rewrite = (relative, transform) => {
  const file = path.join(out, relative);
  fs.writeFileSync(file, transform(fs.readFileSync(file, 'utf8')));
};

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});

fs.copyFileSync(path.join(root, 'site/index.html'), path.join(out, 'index.html'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

if (rebuild) execSync('npm run build', {
  cwd: path.join(root, 'Score'), stdio: 'inherit',
  env: {...process.env, VITE_STATIC_PREVIEW: 'true'},
});
const scoreDist = 'Score/apps/web/dist';
if (!fs.existsSync(path.join(root, scoreDist, 'index.html'))) throw new Error('Score dist missing; run with --build');
fs.cpSync(path.join(root, scoreDist), path.join(out, 'score'), {recursive: true, filter: (s) => skip(s) && !s.endsWith('.map')});
rewrite('score/index.html', html => html.replace('<title>AIlegro Score</title>', '<title>Cantelvio Score</title>'));

fs.cpSync(path.join(root, 'Harmony/public/tonnetz'), path.join(out, 'harmony'), {recursive: true, filter: skip});
fs.cpSync(path.join(root, 'Stage/docs'), path.join(out, 'stage'), {recursive: true, filter: (s) => skip(s) && !/\/(library|sources|fit)(\/|$)/.test(s)});

// The public modules share an entrance without changing their standalone/local navigation.
rewrite('harmony/index.html', html => html
  .replace('<title>Tonnetz · Isomorphic keyboard</title>', '<title>Cantelvio Harmony · Tonnetz</title>')
  .replace('<div id="performanceToggles"', '<style>.cantelvio-home{color:inherit;text-decoration:none;font:600 13px system-ui;padding:10px 12px;border:1px solid rgba(175,222,231,.3);border-radius:10px;touch-action:manipulation}.cantelvio-home:focus-visible{outline:2px solid #64e5df;outline-offset:3px}</style><div id="performanceToggles"')
  .replace('<label class="performance-layout-select">', '<a class="cantelvio-home" href="../">← Cantelvio</a><label class="performance-layout-select">'));
rewrite('stage/index.html', html => {
  const shelfHeading = '<div class="drawer-heading"><div><strong>volta';
  if (!html.includes(shelfHeading)) throw new Error('Stage shelf heading changed; update site/build.mjs');
  return html
    .replace('<title>Volta · 听谱翻页</title>', '<title>Cantelvio Stage · 听谱翻页</title>')
    .replace('<a class="brand" href="./"><span class="brand-mark">V</span><span>volta', '<a class="brand" href="../" aria-label="Cantelvio 首页 / Home"><span class="brand-mark">C</span><span>Cantelvio Stage')
    .replace(shelfHeading, '<a class="secondary full" href="../" style="display:block;margin-bottom:12px;text-align:left;text-decoration:none">← Cantelvio</a>' + shelfHeading);
});

// Compose: browser-only pages and their vendored model/audio assets.
const cf = 'Compose/frontend';
fs.mkdirSync(path.join(out, 'compose'), {recursive: true});
for (const d of ['orchestra', 'vendor', 'media', 'src']) {
  if (fs.existsSync(path.join(root, cf, d))) fs.cpSync(path.join(root, cf, d), path.join(out, 'compose', d), {recursive: true, dereference: true, filter: skip});
}
// The five-model comparison page needs the local Python service: publish only the in-browser joint page.
fs.rmSync(path.join(out, 'compose/orchestra/index.html'), {force: true});
const jointPage = path.join(out, 'compose/orchestra/joint.html');
const jointOld = 'href="./" data-en="← Five-model comparison" data-zh="← 返回五组模型对比">← Five-model comparison';
const jointHtml = fs.readFileSync(jointPage, 'utf8');
if (!jointHtml.includes(jointOld)) throw new Error('joint.html back link changed; update site/build.mjs');
fs.writeFileSync(jointPage, jointHtml
  .replace(jointOld, 'href="../" data-en="← About this demo" data-zh="← 关于这个演示">← About this demo')
  .replace('<title>AIlegro · Joint-model orchestra prototype</title>', '<title>Cantelvio Compose · Browser generation</title>')
  .replace('<span>AI<span class="brand-accent">legro</span><small>JOINT ORCHESTRA</small></span>', '<span>Cantelvio<small>COMPOSE</small></span>'));
fs.copyFileSync(path.join(root, 'site/compose-index.html'), path.join(out, 'compose/index.html'));
for (const f of ['style.css', 'favicon.svg']) fs.copyFileSync(path.join(root, cf, f), path.join(out, 'compose', f));

// Results page and its listening clips.
fs.mkdirSync(path.join(out, 'results'), {recursive: true});
for (const f of fs.readdirSync(path.join(root, 'site/results'))) fs.copyFileSync(path.join(root, 'site/results', f), path.join(out, 'results', f));
const clips = path.join(root, 'Compose/training/reports/amt-compare-20261005');
fs.mkdirSync(path.join(out, 'results/audio'), {recursive: true});
let nClips = 0;
for (const f of fs.existsSync(clips) ? fs.readdirSync(clips) : []) if (f.endsWith('.mp3')) { fs.copyFileSync(path.join(clips, f), path.join(out, 'results/audio', f)); nClips++; }
if (nClips !== 9) throw new Error(`Expected 9 listening clips, found ${nClips}`);

// Identify the live release; this contains no local path or model/training artifact.
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({commit, builtAt: new Date().toISOString(), mode: 'static-preview'}, null, 2) + '\n');

let bytes = 0, files = 0;
(function walk(d) { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (files++, bytes += fs.statSync(p).size); } })(out);
console.log(`site-dist: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
