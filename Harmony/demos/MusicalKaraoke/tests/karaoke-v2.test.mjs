import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import katex from "katex";
import {
  CHORD_SHAPES, FINAL_CADENCE, KARAOKE_PROGRESSIONS, EQUAL_FIFTH_RATIO, PURE_FIFTH_RATIO,
  PYTHAGOREAN_COMMA_CENTS, foldedFifths, validateShape
} from "../public/karaoke/karaoke-data.js";

const htmlUrl = new URL("../public/karaoke/index.html", import.meta.url);
const cssUrl = new URL("../public/karaoke/karaoke.css", import.meta.url);

test("karaoke has the requested eight guided pages in order", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const ids = [...html.matchAll(/<section class="slide[^>]*" id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["cover", "voices", "tonnetz", "shapes", "progressions", "keyboard", "summary", "closing"]);
  assert.match(html, /id="pageCount"[^>]*>1 \/ 8</);
  for (const title of ["Choir", "Process", "Tonnetz", "Shape of chords", "Isomorphic keyboard", "Authentic cadence"]) assert.match(html, new RegExp(`>${title}<`));
  assert.doesNotMatch(html, /Be the choir|Moving shapes|Almost home|A final cadence|CODA|AIgimon|Lumatone Play Modes|A major triad can fit under one finger/);
});

test("the initial Choir markup cannot reveal notes or chords", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const choir = html.slice(html.indexOf('<section class="slide voices"'), html.indexOf('<section class="slide tonnetz"'));
  assert.match(choir, /audience volunteer/);
  assert.doesNotMatch(choir, /C → G|C♯|A♭|Am|data-midi|Play C|note [A-G]/);
});

test("every progression uses a verified concrete coordinate chord", () => {
  for (const [name, shape] of Object.entries(CHORD_SHAPES)) assert.ok(validateShape(shape), name);
  assert.equal(KARAOKE_PROGRESSIONS.length, 8);
  assert.deepEqual(KARAOKE_PROGRESSIONS.at(-2), { romans: ["IV", "V", "♭VI", "♭VII", "I"], chords: ["F", "G", "A♭", "B♭", "C"] });
  assert.deepEqual(KARAOKE_PROGRESSIONS.at(-1), { romans: ["IV", "V", "iii", "vi", "ii", "V", "I"], chords: ["F", "G", "Em", "Am", "Dm", "G", "C"] });
  for (const progression of KARAOKE_PROGRESSIONS) for (const name of progression.chords) assert.ok(CHORD_SHAPES[name], `${name} must have a playable shape`);
  const pitchSet = notes => [...new Set(notes.map(n => n % 12))].sort((a, b) => a - b);
  FINAL_CADENCE.chords.forEach((name, i) => assert.deepEqual(pitchSet(FINAL_CADENCE.midis[i]), pitchSet(CHORD_SHAPES[name].midis)));
  assert.deepEqual(FINAL_CADENCE.chords, ["F", "G7", "C"]);
});

test("the eight Process controls fit a three-row grid", async () => {
  const css = await readFile(cssUrl, "utf8");
  assert.match(css, /\.filmstrip\{height:270px/);
  assert.match(css, /\.progression-list\{[^}]*grid-template-columns:repeat\(3,1fr\)/);
  assert.match(css, /\.progression\.is-long\{grid-column:span 2\}/);
  assert.match(css, /@media\(max-width:680px\)[\s\S]*\.progression\.is-long\{grid-column:auto\}/);
});

test("pure and equal fifth paths have distinct, correct endpoints", () => {
  const pure = foldedFifths(PURE_FIFTH_RATIO);
  const equal = foldedFifths(EQUAL_FIFTH_RATIO);
  assert.equal(pure.length, 13);
  assert.ok(Math.abs(1200 * Math.log2(pure.at(-1) / pure[0]) - PYTHAGOREAN_COMMA_CENTS) < 1e-9);
  assert.ok(Math.abs(PYTHAGOREAN_COMMA_CENTS - 23.460010384649014) < 1e-9);
  assert.ok(Math.abs(equal.at(-1) - equal[0]) < 1e-9);
});

test("tuning formulas parse and audio cancellation follows the media clock", async () => {
  for (const formula of ["3:2", "2^{7/12}"]) assert.match(katex.renderToString(formula, { throwOnError: true, strict: "error", output: "htmlAndMathml" }), /<math/);
  const source = await readFile(new URL("../public/karaoke/karaoke-audio.js", import.meta.url), "utf8");
  const controller = await readFile(new URL("../public/karaoke/karaoke.js", import.meta.url), "utf8");
  assert.match(source, /media\.currentTime/);
  assert.match(source, /cue\.time \+ cue\.duration/);
  assert.match(source, /this\.generation/);
  assert.match(source, /sampler\?\.stopAll/);
  assert.match(controller, /visibilitychange/);
  assert.match(controller, /audio\.setSampler\(sampler\)/);
});

test("closing keeps only the requested Tonnetz destination", async () => {
  const html = await readFile(htmlUrl, "utf8");
  assert.match(html, /Now play your own song:/);
  assert.match(html, /https:\/\/aigimon\.ai\/tonnetz\//);
  assert.equal((html.match(/https:\/\//g) || []).length, 1);
  assert.doesNotMatch(html, /demo=(?:melody|harmony)|Tchaikovsky|Mendelssohn|rehearsal-links|https:\/\/www\.aigimon\.com"/);
});
