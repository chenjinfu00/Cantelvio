import test from "node:test";
import assert from "node:assert/strict";
import {
  PROGRESSIONS,
  AUTHENTIC_CADENCE,
  CHORDS_BY_ID,
  WORKBENCH_COPY
} from "../public/tonnetz/workbench-data.js";
import {
  CHORD_VOCAB,
  PALETTES,
  MODEL_IDS,
  predictNext,
  prepareModels
} from "../public/tonnetz/lib/harmony-models.js";

test("workbench exposes all eight presentation progressions and the cadence", () => {
  assert.equal(PROGRESSIONS.length, 8);
  assert.equal(new Set(PROGRESSIONS.map(({ id }) => id)).size, 8);
  assert.deepEqual(AUTHENTIC_CADENCE.chords, ["F", "G7", "C"]);
  assert.deepEqual(AUTHENTIC_CADENCE.romans, ["IV", "V7", "I"]);
  assert.equal(AUTHENTIC_CADENCE.voicings.length, 3);
  for (const sequence of [...PROGRESSIONS, AUTHENTIC_CADENCE]) {
    assert.equal(sequence.chords.length, sequence.romans.length, sequence.id);
    sequence.chords.forEach((id) => assert.ok(CHORDS_BY_ID.has(id), `${sequence.id}: ${id}`));
    assert.ok(sequence.name.en && sequence.name["zh-CN"]);
  }
});

test("cadence voicings sound the displayed chords with a root-position V7-I close", () => {
  AUTHENTIC_CADENCE.voicings.forEach((midis, index) => {
    const expected = new Set(CHORDS_BY_ID.get(AUTHENTIC_CADENCE.chords[index]).pcs);
    const actual = new Set(midis.map((midi) => ((midi % 12) + 12) % 12));
    assert.deepEqual(actual, expected);
  });
  assert.equal(AUTHENTIC_CADENCE.voicings[1][0] % 12, 7);
  assert.equal(AUTHENTIC_CADENCE.voicings[2][0] % 12, 0);
});

test("all chord inversions remain reachable from every style", () => {
  assert.equal(CHORD_VOCAB.length, 2172);
  const complete = PALETTES.find(({ id }) => id === "chromatic");
  assert.deepEqual(new Set(complete.chordIds), new Set(CHORD_VOCAB.map(({ id }) => id)));
});

test("each model returns normalized probabilities and cannot repeat the current chord", async () => {
  await prepareModels();
  for (const model of MODEL_IDS) {
    const result = predictNext(["C", "F"], { model, palette: "chromatic", temperature: 0.87 });
    const total = result.distribution.reduce((sum, item) => sum + item.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-10, model);
    assert.equal(result.distribution.find(({ id }) => id === "F").probability, 0, model);
    assert.ok(result.distribution.every(({ probability }) => Number.isFinite(probability) && probability >= 0));
    assert.ok(result.parameters && typeof result.parameters === "object");
  }
});

test("only the trained Transformer is supported", () => {
  assert.deepEqual(MODEL_IDS, ["transformer"]);
  assert.throws(() => predictNext(["C"], {model:"markov1"}), /Only Transformer/);
});

test("new workbench copy has English and Chinese for every key", () => {
  for (const [key, value] of Object.entries(WORKBENCH_COPY)) {
    assert.ok(value.en, `${key} English`);
    assert.ok(value["zh-CN"], `${key} Chinese`);
  }
});
