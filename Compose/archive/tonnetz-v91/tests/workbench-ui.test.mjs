import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../public/tonnetz/", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");

test("index loads the independent workbench after the keyboard and keeps both handles", async () => {
  const index = await read("index.html");
  assert.match(index, /id="settingsHandleLabel"[^>]*>Settings</);
  assert.match(index, /id="harmonyWorkbench"/);
  const dock = index.slice(index.indexOf('id="performanceDock"'), index.indexOf('<aside id="harmonyWorkbench"'));
  for (const id of ["settingsHandle", "wbTimeline", "wbToggle"]) assert.match(dock, new RegExp(`id="${id}"`));
  assert.doesNotMatch(index, /id="(?:wbStart|wbStop|wbCurrentChord|wbCurrentRoman)"/);
  assert.match(index, /data-wb-tab="accompaniment"/);
  assert.match(index, /data-wb-tab="harmony"/);
  assert.match(index, /data-wb-tab="learn"/);
  assert.ok(index.indexOf("app.js?v=") < index.indexOf("workbench.js?v="));
  assert.ok(index.indexOf("katex.min.js") < index.indexOf("workbench.js?v=12"));
});

test("workbench binds the exact audio, accompaniment, Learn and language interfaces", async () => {
  const source = await read("workbench.js");
  assert.match(source, /window\.TonnetzAudio/);
  assert.match(source, /createAccompaniment\(\{/);
  assert.match(source, /createLearnPanel\(\{ container: learnContainer, audio, getLanguage \}\)/);
  assert.match(source, /tonnetzlanguagechange/);
  assert.match(source, /tonnetz:panic/);
  assert.match(source, /onBar: chordForNextBar/);
  assert.match(source, /syncController: false/);
  assert.doesNotMatch(source, /choir/i);
});

test("bottom sheet overlays a stable keyboard and only its content scrolls", async () => {
  const css = await read("workbench.css");
  assert.match(css, /\.wb[\s\S]*bottom: var\(--dock-space\)/);
  assert.match(css, /\.instrument\.wb-expanded \.play-surface[^}]*bottom: var\(--dock-space\)/);
  assert.doesNotMatch(css, /\.play-surface[^}]*bottom:.*(?:panel|vh)/);
  assert.match(css, /\.wb\.is-expanded[^}]*transform: translate\(-50%, 0\)/);
  assert.match(css, /\.wb-panel-scroll[\s\S]*overflow-y: auto/);
  assert.match(css, /\.instrument[\s\S]*overflow: clip/);
  assert.match(css, /\.instrument \.settings-sheet[\s\S]*visibility: hidden/);
  assert.match(css, /font-size: 14px/);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[0-3])px/);
});

test("service worker only cleans Tonnetz caches and caches successful scoped responses", async () => {
  const sw = await read("sw.js");
  assert.match(sw, /key\.startsWith\(CACHE_PREFIX\)/);
  assert.match(sw, /requestURL\.origin !== scopeURL\.origin/);
  assert.match(sw, /requestURL\.pathname\.startsWith\(scopeURL\.pathname\)/);
  assert.match(sw, /if \(response\.ok\)/);
  const index = await read("index.html");
  const workbenchAsset = index.match(/workbench\.js\?v=\d+/)[0];
  assert.ok(sw.includes(workbenchAsset), "offline cache must match the HTML module version");
  assert.ok(sw.includes('./lib/melody-model.js') && sw.includes('./lib/melody-transformer-weights.js'));
  assert.match(sw, /learn\.js/);
  assert.match(sw, /accompaniment\.js/);
});
