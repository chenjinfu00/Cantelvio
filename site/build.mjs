#!/usr/bin/env node
// Assemble the static Cantelvio software and guide (GitHub Pages ready).
//   /            software launch page (site/index.html)
//   /demo/       independent guide and demonstrations
//   /score/      Score editor (Vite build, base './'; reuses Score/apps/web/dist unless --build)
//   /harmony/    Harmony (Tonnetz) public pages
//   /stage/      Stage (Volta) docs/ PWA
//   /results/    results page (site/results) + listening clips from Compose/training/reports/amt-compare-20261005
//   /compose/    Compose in-browser pages (orchestra joint model, QA); the main page and four-pillar need the local Python service and are NOT published
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {scoreLibraryPage,brandReaderPage} from './score-library.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a path`);
  return path.resolve(args[index + 1]);
};
const out = option('--out') || path.join(root, 'site-dist');
// A separate checkout can supply the previously published modules while local
// experiments remain untouched. Site pages/settings always come from this checkout.
const modulesRoot = option('--modules-root') || root;
const rebuild = process.argv.includes('--build');
const skip = (src) => !/(^|\/)(\.DS_Store|node_modules|\.git)(\/|$)/.test(src);
const rewrite = (relative, transform) => {
  const file = path.join(out, relative);
  fs.writeFileSync(file, transform(fs.readFileSync(file, 'utf8')));
};

// Never erase an existing preview or a module build. Use a new output directory.
if (fs.existsSync(out)) throw new Error(`Output already exists: ${out}. Choose a fresh directory with --out.`);
fs.mkdirSync(out, {recursive: true});

fs.copyFileSync(path.join(root, 'site/index.html'), path.join(out, 'index.html'));
for (const file of ['workspace.css', 'language.js']) fs.copyFileSync(path.join(root, 'site', file), path.join(out, file));
fs.cpSync(path.join(root, 'site/demo'), path.join(out, 'demo'), {recursive: true});
// Browser accompaniment: no local score, MIDI, recording or Python service.
fs.cpSync(path.join(root, 'site/concerto'), path.join(out, 'concerto'), {
  recursive: true, filter: s => !s.endsWith('/synth.mjs'),
});
const scoreRequire = createRequire(path.join(modulesRoot, 'Score/package.json'));
const {buildSync} = scoreRequire('esbuild');
buildSync({entryPoints:[path.join(root, 'site/concerto/synth.mjs')], bundle:true, format:'esm',
  platform:'browser', minify:true, nodePaths:[path.join(modulesRoot,'Score/node_modules')],
  outfile:path.join(out,'concerto/vendor/synth.js')});
fs.copyFileSync(path.join(path.dirname(scoreRequire.resolve('spessasynth_lib')), 'spessasynth_processor.min.js'), path.join(out,'concerto/vendor/processor.js'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

if (rebuild) {
  execFileSync('npm', ['run', 'build', '--', '--outDir', path.join(out, 'score'), '--emptyOutDir', 'false', '--sourcemap', 'false', '--configLoader', 'runner'], {
    cwd: path.join(modulesRoot, 'Score'), stdio: 'inherit',
    env: {...process.env, VITE_STATIC_PREVIEW: 'true'},
  });
} else {
  const scoreDist = path.join(modulesRoot, 'Score/apps/web/dist');
  if (!fs.existsSync(path.join(scoreDist, 'index.html'))) throw new Error('Score dist missing; run with --build');
  fs.cpSync(scoreDist, path.join(out, 'score'), {recursive: true, filter: (s) => skip(s) && !s.endsWith('.map')});
}
rewrite('score/index.html', html => html.replace(/<title>[^<]*<\/title>/, '<title>Cantelvio Score</title>'));

fs.cpSync(path.join(modulesRoot, 'Harmony/public/tonnetz'), path.join(out, 'harmony'), {recursive: true, filter: skip});
fs.cpSync(path.join(modulesRoot, 'Stage/docs'), path.join(out, 'stage'), {recursive: true, filter: (s) => skip(s) && !/\/(library|sources|fit)(\/|$)/.test(s)});

// PDF library: the same on-device folder reader under Score's own entry point.
// The local catalog, scores and page-boundary sidecars are never copied here.
fs.cpSync(path.join(modulesRoot, 'Stage/docs'), path.join(out, 'score/library'), {recursive: true, filter: (s) => skip(s) && !/\/(library|sources|fit)(\/|$)/.test(s)});
fs.copyFileSync(path.join(root, 'Score/tools/score-library.css'), path.join(out, 'score/library/score-library.css'));
rewrite('score/library/index.html', html => scoreLibraryPage(html));
rewrite('score/library/manifest.webmanifest', json => {
  const manifest=JSON.parse(json);manifest.name='Cantelvio Score · 曲谱库';manifest.short_name='Score';manifest.start_url='./?library=1';
  return JSON.stringify(manifest,null,2)+'\n';
});
rewrite('score/library/cache-manifest.json', json => JSON.stringify([...new Set([...JSON.parse(json),'./score-library.css'])].sort(),null,2)+'\n');

// The public modules share an entrance without changing their standalone/local navigation.
rewrite('harmony/index.html', html => html
  .replace('<title>Tonnetz · Isomorphic keyboard</title>', '<title>Cantelvio Harmony · Tonnetz</title>')
  .replace('<div id="performanceToggles"', '<style>.cantelvio-home{color:inherit;text-decoration:none;font:600 13px system-ui;padding:10px 12px;border:1px solid rgba(175,222,231,.3);border-radius:10px;touch-action:manipulation}.cantelvio-home:focus-visible{outline:2px solid #64e5df;outline-offset:3px}</style><div id="performanceToggles"')
  .replace('<label class="performance-layout-select">', '<a class="cantelvio-home" href="../">← Cantelvio</a><label class="performance-layout-select">'));
rewrite('harmony/i18n.js', js => js.replace(/("app.title": ")Tonnetz/g, '$1Cantelvio Harmony · Tonnetz'));
for (const app of ['harmony', 'stage']) rewrite(app + '/manifest.webmanifest', json => {
  const manifest = JSON.parse(json);
  manifest.name = 'Cantelvio ' + (app === 'harmony' ? 'Harmony' : 'Stage');
  manifest.short_name = manifest.name;
  manifest.background_color = '#f6f5ef';manifest.theme_color = '#2f6b4f';
  return JSON.stringify(manifest, null, 2) + '\n';
});
rewrite('stage/index.html', html => {
  const shelfHeading = '<div class="drawer-heading"><div><strong>volta';
  if (!html.includes(shelfHeading)) throw new Error('Stage shelf heading changed; update site/build.mjs');
  return brandReaderPage(html
    .replace('<title>Volta · 听谱翻页</title>', '<title>Cantelvio Stage · 听谱翻页</title>')
    .replace('<a class="brand" href="./"><span class="brand-mark">V</span><span>volta', '<a class="brand" href="../" aria-label="Cantelvio 首页 / Home"><span class="brand-mark">C</span><span>Cantelvio Stage')
    .replace(shelfHeading, '<a class="secondary full" href="../" style="display:block;margin-bottom:12px;text-align:left;text-decoration:none">← Cantelvio</a>' + shelfHeading)
    .replace('<strong>volta', '<strong>Cantelvio Stage').replace('，Volta 就把', '，Cantelvio Stage 就把'),{name:'Cantelvio Stage',eyebrow:'CANTELVIO STAGE'});
});

// Compose: browser-only pages and their vendored model/audio assets.
const cf = 'Compose/frontend';
fs.mkdirSync(path.join(out, 'compose'), {recursive: true});
for (const d of ['orchestra', 'vendor', 'media', 'src']) {
  const source = path.join(modulesRoot, cf, d);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(out, 'compose', d), {
    recursive: true, dereference: true,
    filter: s => skip(s) && s !== path.join(modulesRoot, cf, 'orchestra/index.html'),
  });
}
// The five-model comparison page needs the local Python service: publish only the in-browser joint page.
const jointPage = path.join(out, 'compose/orchestra/joint.html');
const jointOld = 'href="./" data-en="← Five-model comparison" data-zh="← 返回五组模型对比">← Five-model comparison';
const jointHtml = fs.readFileSync(jointPage, 'utf8');
if (!jointHtml.includes(jointOld)) throw new Error('joint.html back link changed; update site/build.mjs');
fs.writeFileSync(jointPage, jointHtml
  .replace(jointOld, 'href="../" data-en="← Generation workspace" data-zh="← 音乐生成">← Generation workspace')
  .replace(/<title>[^<]*<\/title>/, '<title>Cantelvio Compose · Browser generation</title>')
  .replace(/<span>Cantelvio<small>JOINT ORCHESTRA<\/small><\/span>/, '<span>Cantelvio<small>COMPOSE</small></span>'));
fs.copyFileSync(path.join(root, 'site/compose-index.html'), path.join(out, 'compose/index.html'));
for (const f of ['style.css', 'favicon.svg']) fs.copyFileSync(path.join(modulesRoot, cf, f), path.join(out, 'compose', f));

// Results page and its listening clips.
fs.mkdirSync(path.join(out, 'results'), {recursive: true});
for (const f of fs.readdirSync(path.join(root, 'site/results'))) fs.copyFileSync(path.join(root, 'site/results', f), path.join(out, 'results', f));
const clips = path.join(modulesRoot, 'Compose/training/reports/amt-compare-20261005');
fs.mkdirSync(path.join(out, 'results/audio'), {recursive: true});
let nClips = 0;
for (const f of fs.existsSync(clips) ? fs.readdirSync(clips) : []) if (f.endsWith('.mp3')) { fs.copyFileSync(path.join(clips, f), path.join(out, 'results/audio', f)); nClips++; }
if (nClips !== 9) throw new Error(`Expected 9 listening clips, found ${nClips}`);

// Shared settings use the project root for storage and module-local files for
// offline caches. Standalone module distributions keep their own build behavior.
const appearanceDir = path.join(root, 'site/appearance');
const sharedFiles = ['common.css', 'appearance.js', 'core.mjs'];
const appearanceHash = createHash('sha256');
for (const file of fs.readdirSync(appearanceDir).sort()) appearanceHash.update(fs.readFileSync(path.join(appearanceDir, file)));
// Assembly repairs must also refresh the installed modules' offline caches.
appearanceHash.update(fs.readFileSync(new URL(import.meta.url)));
const appearanceVersion = appearanceHash.digest('hex').slice(0, 10);
for (const app of ['home', 'score', 'harmony', 'stage', 'compose']) {
  const destination = path.join(out, app === 'home' ? '' : app, 'appearance');
  fs.mkdirSync(destination, {recursive: true});
  for (const file of [...sharedFiles, ...(app === 'home' ? [] : [app + '.css'])]) {
    fs.copyFileSync(path.join(appearanceDir, file), path.join(destination, file));
  }
}
const publicPages = [
  ['index.html', 'home', './', './appearance/'],
  ['demo/index.html', 'home', '../', '../appearance/'],
  ['concerto/index.html', 'home', '../', '../appearance/'],
  ['concerto/play.html', 'home', '../', '../appearance/'],
  ['results/index.html', 'results', '../', '../appearance/'],
  ['score/index.html', 'score', '../', './appearance/'],
  ['score/library/index.html', 'stage', '../../', '../../stage/appearance/'],
  ['harmony/index.html', 'harmony', '../', './appearance/'],
  ['stage/index.html', 'stage', '../', './appearance/'],
  ['compose/index.html', 'compose', '../', './appearance/'],
  ['compose/orchestra/joint.html', 'compose', '../../', '../appearance/'],
  ['compose/orchestra/qa.html', 'compose', '../../', '../appearance/'],
];
for (const [page, app, projectRoot, assets] of publicPages) {
  if (!fs.existsSync(path.join(out, page))) continue;
  rewrite(page, html => html
    .replace(/<html\b/, `<html data-cv-app="${app}" data-cv-root="${projectRoot}"`)
    .replace('</head>', `<link rel="stylesheet" href="${assets}common.css">${['home', 'results'].includes(app) ? '' : `<link rel="stylesheet" href="${assets}${app}.css">`}<script type="module" src="${assets}appearance.js"></script></head>`));
}
rewrite('compose/index.html', html => html.replace('<p><a href="../">', '<p class="cv-landing-actions"><a href="../">'));
rewrite('stage/index.html', html => {
  const choices = /<div class="theme-choices"><button data-theme-choice="blue"[\s\S]*?<\/div>/;
  if (!choices.test(html)) throw new Error('Stage theme choices changed; update shared settings integration');
  return html.replace(choices, '<button type="button" class="cv-appearance-trigger" data-cv-open data-cv-in-settings><span class="cv-gear" aria-hidden="true">⚙</span><span data-cv-label="open">外观设置</span></button>')
    .replace('菜单颜色随主题改变，谱纸始终保持原样。', '外观设置在所有 Cantelvio 页面通用。谱纸底色可在下方单独调整。');
});
const localAppearance = app => [...sharedFiles, app + '.css'].map(file => './appearance/' + file);
rewrite('harmony/sw.js', js => js
  .replace(/const CACHE_NAME = [^;]+;/, `const CACHE_NAME = \`\${CACHE_PREFIX}appearance-${appearanceVersion}\`;`)
  .replace('const ASSETS = [', 'const ASSETS = [\n' + localAppearance('harmony').map(file => `  ${JSON.stringify(file)},`).join('\n')));
for (const file of ['sw.js', 'offline.js', 'offline-deploy.js']) {
  rewrite('stage/' + file, js => js.replaceAll('20261008-onboarding-1', '20261008-appearance-' + appearanceVersion));
}
// .nojekyll configures deployment; it is not a runtime asset served by Pages.
rewrite('stage/cache-manifest.json', json => JSON.stringify([...new Set([...JSON.parse(json).filter(file => file !== './.nojekyll'), ...localAppearance('stage')])].sort(), null, 2) + '\n');

// Identify the live release; this contains no local path or model/training artifact.
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
const modulesCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: modulesRoot, encoding: 'utf8'}).trim();
const siteSourceModified = Boolean(execFileSync('git', ['status', '--porcelain', '--', 'site'], {cwd: root, encoding: 'utf8'}).trim());
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({commit, modulesCommit, siteSourceModified, builtAt: new Date().toISOString(), mode: 'static-preview'}, null, 2) + '\n');

let bytes = 0, files = 0;
(function walk(d) { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (files++, bytes += fs.statSync(p).size); } })(out);
console.log(`${out}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
