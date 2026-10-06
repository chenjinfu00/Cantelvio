import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createArpeggioLoop, formulaForModel, summarizeDistribution } from "../public/karaoke/harmony-summary.js";

test("model formulas disclose each conditioning context", () => {
  assert.equal(formulaForModel("markov1"), "P(c_{t+1}\\mid c_t)");
  assert.equal(formulaForModel("markov2"), "P(c_{t+1}\\mid c_{t-1},c_t)");
  assert.equal(formulaForModel("transformer"), "P(c_{t+1}\\mid c_{\\leq t})");
});

test("distribution summary keeps the strongest choices and exposes omitted mass", () => {
  const distribution = [
    { id: "F", probability: .19 }, { id: "C", probability: .31 },
    { id: "G", probability: .23 }, { id: "Am", probability: .14 },
    { id: "Dm", probability: .08 }, { id: "Em", probability: .04 },
    { id: "Fm", probability: .01 }, { id: "A7", probability: 0 }
  ];
  const summary = summarizeDistribution(distribution, 5);
  assert.deepEqual(summary.visible.map(({ id }) => id), ["C", "G", "F", "Am", "Dm"]);
  assert.ok(Math.abs(summary.other - .05) < 1e-12);
  assert.deepEqual(distribution.map(({ id }) => id), ["F", "C", "G", "Am", "Dm", "Em", "Fm", "A7"], "input remains untouched");
});

test("harmony explorer implements the lifecycle and disclosure contract", async () => {
  const source = await readFile(new URL("../public/karaoke/harmony-summary.js", import.meta.url), "utf8");
  assert.match(source, /export function createHarmonyExplorer/);
  assert.match(source, /return \{ render, advance: playPhrase, cancel, enter \}/);
  assert.match(source, /id: "markov1", label: "Markov · 1"/);
  assert.match(source, /id: "markov2", label: "Markov · 2"/);
  assert.match(source, /id: "transformer", label: "Transformer"/);
  assert.match(source, /data-action="play">▶ Play 8/);
  assert.match(source, /data-action="next">Next chord/);
  assert.match(source, /If you want to play some melody, please visit/);
  assert.match(source, /href="https:\/\/www\.aigimon\.com\/tonnetz\/" target="_blank" rel="noopener noreferrer">aigimon\.ai\/tonnetz/);
  assert.match(source, /type="range" min="0\.25" max="2" step="0\.01" data-temperature/);
  assert.match(source, /role="button" tabindex="\$\{busy \? -1 : 0\}"[^>]*data-next-chord/);
  assert.match(source, /container\.addEventListener\("keydown", handleKeydown\)/);
  assert.match(source, /container\.addEventListener\("input", handleTemperatureInput\)/);
  assert.match(source, /New palette/);
  assert.match(source, /data-action="parameters">Parameters/);
  assert.match(source, /data-no-advance/);
  assert.match(source, /same distribution used to sample/);
  assert.match(source, /New chord every step/);
  assert.match(source, /Must change chord/);
  assert.match(source, /Probabilities are authored musical choices/);
  assert.match(source, /synthetic teaching phrases, not real recordings/);
  assert.match(source, /attention/);
  assert.match(source, /Causal mask/);
});

test("arpeggio cancellation invalidates a pending piano preparation", async () => {
  let finishPrepare;
  const notes = [];
  const audio = {
    generation: 0,
    timers: new Set(),
    stop() { this.generation += 1; this.timers.clear(); },
    preparePiano() { return new Promise((resolve) => { finishPrepare = resolve; }); },
    playMidiNow(midi) { notes.push(midi); return true; }
  };
  const loop = createArpeggioLoop({ audio, setTimer: () => 1 });
  assert.equal(loop.start([60, 64, 67], "C"), true);
  loop.stop({ silence: false });
  finishPrepare(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(notes, []);
  assert.equal(loop.active, false);
});

test("temperature and direct graph choices share the live prediction path", async () => {
  const source = await readFile(new URL("../public/karaoke/harmony-summary.js", import.meta.url), "utf8");
  assert.match(source, /predictNext\(state\.history, \{ model: state\.model, palette: state\.palette, temperature: state\.temperature \}\)/);
  assert.match(source, /predictNext\(plannedHistory, \{[\s\S]*temperature: state\.temperature/);
  assert.match(source, /state\.temperature = next\.temperature/);
  assert.match(source, /async function playNext\(chosenId, trigger, restoreGraphFocus = false\)/);
  assert.match(source, /appendAudibleChord\(nextId\)/);
  assert.match(source, /playNext\(control\.dataset\.nextChord, control\)/);
  assert.match(source, /arpeggio\.stop\(\)/);
  assert.match(source, /if \(completed && lifecycle === state\.lifecycle && state\.entered\) startArpeggio/);
  const inputHandler = source.slice(source.indexOf("function handleTemperatureInput"), source.indexOf("function cancel"));
  assert.match(inputHandler, /refreshPrediction\(\{ preservePrediction: true \}\)/);
  assert.doesNotMatch(inputHandler, /acceptsInput|claimInput/);
  assert.match(source, /if \(restoreGraphFocus && refreshed\) container\.querySelector\('\[data-next-chord\]:not/);
});

test("phrase playback commits only chords reported by the audio step callback", async () => {
  const source = await readFile(new URL("../public/karaoke/harmony-summary.js", import.meta.url), "utf8");
  const phrase = source.slice(source.indexOf("async function playPhrase"), source.indexOf("async function playPaletteChord"));
  assert.match(phrase, /audio\.sequence\(plan\.map/);
  assert.match(phrase, /if \(index < 0 \|\| !plan\[index\]\) return/);
  assert.match(phrase, /appendAudibleChord\(step\.nextId\)/);
  assert.doesNotMatch(phrase, /state\.history\s*=\s*plannedHistory/);
  assert.match(phrase, /\(\) => onComplete\?\.\(\)/);
});

test("summary styling fits the stage, supports an overlay and flows on mobile", async () => {
  const css = await readFile(new URL("../public/karaoke/harmony-summary.css", import.meta.url), "utf8");
  assert.match(css, /\.harmony-explorer\{[^}]*box-sizing:border-box[^}]*height:620px/);
  assert.match(css, /\.harmony-drawer\{[^}]*height:620px/);
  assert.match(css, /\.harmony-drawer-body\{[^}]*overflow:auto/);
  assert.match(css, /\.harmony-history\{[^}]*grid-template-columns:repeat\(4[^}]*grid-template-rows:repeat\(2/);
  assert.match(css, /\.harmony-attention table\{[^}]*font-size:18px/);
  assert.match(css, /\.harmony-temperature\{/);
  assert.match(css, /\.harmony-next-node\{cursor:pointer/);
  assert.match(css, /@media\(max-width:620px\)/);
  assert.doesNotMatch(css, /(^|})\s*(button|svg|table|header|section)\s*\{/m);
});
