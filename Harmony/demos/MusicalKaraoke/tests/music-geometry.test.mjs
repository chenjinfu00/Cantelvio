import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CHORDS, PROGRESSIONS, pitchClass } from "../public/shared/music-data.js";
import { BASIS, appLayoutSnapshot, point } from "../public/shared/lattice.js";

test("all eight chord shapes encode exactly their stated pitch classes", () => {
  assert.equal(CHORDS.length, 8);
  for (const chord of CHORDS) {
    assert.equal(chord.coords.length, chord.pcs.length, chord.id);
    assert.deepEqual(chord.coords.map(pitchClass), chord.pcs, chord.id);
  }
});

test("app basis matches the verified U/V mapping", () => {
  assert.deepEqual(BASIS.appU, { x: 0.9606, y: -0.2781 });
  assert.deepEqual(BASIS.appV, { x: -0.2398, y: 0.9708 });
  const fifth = point([1, 0], 1);
  const majorThird = point([0, 1], 1);
  assert.deepEqual(fifth, BASIS.e5);
  assert.deepEqual(majorThird, BASIS.e3);
});

test("layout exports select one concrete C E G set in both modes", () => {
  for (const layout of ["classic", "harmonic"]) {
    const svg = appLayoutSnapshot({ layout });
    const selected = [...svg.matchAll(/<g class="snapshot-key is-highlight[^>]*>[\s\S]*?<text[^>]*>([^<]+)<\/text>/g)].map((match) => match[1]).sort();
    assert.deepEqual(selected, ["C", "E", "G"], layout);
    assert.equal((svg.match(/class="snapshot-key/g) || []).length, 96, layout);
  }
});

test("all six progression formulas remain present", () => {
  assert.equal(PROGRESSIONS.length, 6);
  assert.deepEqual(PROGRESSIONS.at(-1), { romans: ["I", "V", "vi", "IV"], chords: ["C", "G", "Am", "F"] });
});

test("rehearsal uses media time, cue durations, cancellation, and score-range preparation", async () => {
  const rehearsal = await readFile(new URL("../public/tonnetz/rehearsal.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/tonnetz/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(rehearsal, /PRACTICE/);
  assert.match(rehearsal, /activeAudio\.currentTime/);
  assert.match(rehearsal, /currentCue\.time \+ currentCue\.duration/);
  assert.match(rehearsal, /playGeneration/);
  assert.match(rehearsal, /rehearsal\.beatSeconds \/ rate\(\)/);
  assert.match(rehearsal, /prepareRehearsal/);
  assert.match(app, /columnCount = classic \? 21 : 13/);
  assert.match(app, /Array\.isArray\(spec\?\.midis\)/);
});

test("deck has an independent cover, eleven slides, and both rehearsal entries return to #demo", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal((html.match(/<section class="slide/g) || []).length, 11);
  assert.match(html, /<section class="slide title-cover is-active" id="cover"/);
  assert.match(html, /<section class="slide act-one solution" id="solution"/);
  assert.match(html, /id="pageCount"[^>]*>1 \/ 11</);
  assert.equal((html.match(/data-period-step="[0-3]"/g) || []).length, 4);
  assert.match(html, /id="lumatone"[^>]*data-builds="3"/);
  assert.match(html, /You play the soloist/);
  assert.match(html, /You play the chords/);
  assert.doesNotMatch(html, /Op\. 35|Op\. 64|main theme|V-E\+F/);
  assert.match(html, /tonnetz\/\?demo=melody/);
  assert.match(html, /tonnetz\/\?demo=harmony/);
  const instrument = await readFile(new URL("../public/tonnetz/index.html", import.meta.url), "utf8");
  assert.match(instrument, /href="\.\.\/#demo"/);
});

test("development copy does not register a service worker", async () => {
  const app = await readFile(new URL("../public/tonnetz/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /serviceWorker\.register/);
  assert.match(app, /registration\.unregister/);
});
