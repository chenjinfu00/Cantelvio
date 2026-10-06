import test from "node:test";
import assert from "node:assert/strict";

import {
  CHORD_VOCAB,
  MODEL_IDS,
  PALETTES,
  predictNext,
  prepareModels,
  sampleDistribution,
  transformerForward,
  voiceChord
} from "../public/karaoke/harmony-models.js";
import { TINY_TRANSFORMER_WEIGHTS } from "../public/karaoke/tiny-transformer.js";

const ids = new Map(CHORD_VOCAB.map((entry, index) => [entry.id, index]));
const probabilitiesById = (result) => new Map(result.distribution.map((entry) => [entry.id, entry.probability]));
const maxDistributionDelta = (left, right) => {
  const rightById = probabilitiesById(right);
  return Math.max(...left.distribution.map((entry) => Math.abs(entry.probability - rightById.get(entry.id))));
};
const renderedPercent = (value) => value > 0 && value < 0.01 ? "<1%" : `${Math.round(value * 100)}%`;
const topFiveUiSignature = (result) => {
  const visible = result.distribution.filter(({ probability }) => probability > 0).slice(0, 5);
  const visibleIds = new Set(visible.map(({ id }) => id));
  const other = result.distribution.reduce((sum, item) => sum + (visibleIds.has(item.id) ? 0 : item.probability), 0);
  return [
    ...visible.map(({ id, probability }) => `${id}:${renderedPercent(probability)}`),
    ...(other > 0.0005 ? [`Other:${renderedPercent(other)}`] : [])
  ].join("|");
};

test("the 33-token vocabulary and four presets are complete", async () => {
  await prepareModels();
  assert.deepEqual(MODEL_IDS, ["markov1", "markov2", "transformer"]);
  assert.equal(CHORD_VOCAB.length, 33);
  assert.equal(new Set(CHORD_VOCAB.map(({ id }) => id)).size, 33);
  for (const entry of CHORD_VOCAB) {
    assert.ok(entry.pcs.length >= 3);
    assert.equal(new Set(entry.pcs).size, entry.pcs.length);
    assert.ok(entry.pcs.every((pc) => Number.isInteger(pc) && pc >= 0 && pc < 12));
  }
  const neapolitan = CHORD_VOCAB.find(({ id }) => id === "D♭/F");
  assert.deepEqual(neapolitan.pcs, [1, 5, 8]);
  assert.equal(neapolitan.bass, 5);
  assert.deepEqual(PALETTES.map(({ id }) => id), ["pop", "classical", "jazz", "chromatic"]);
  assert.deepEqual(PALETTES.find(({ id }) => id === "chromatic").chordIds, CHORD_VOCAB.map(({ id }) => id));
});

test("every returned distribution covers its palette and is sorted and normalized", () => {
  for (const model of MODEL_IDS) {
    for (const palette of PALETTES) {
      const result = predictNext(["C", "Am", "Dm", "G"], { model, palette: palette.id });
      assert.equal(result.distribution.length, palette.chordIds.length);
      assert.deepEqual(new Set(result.distribution.map(({ id }) => id)), new Set(palette.chordIds));
      let sum = 0;
      for (let index = 0; index < result.distribution.length; index += 1) {
        const probability = result.distribution[index].probability;
        assert.ok(Number.isFinite(probability) && probability >= 0);
        if (index) assert.ok(result.distribution[index - 1].probability >= probability);
        sum += probability;
      }
      assert.ok(Math.abs(sum - 1) < 1e-12, `${model}/${palette.id}: ${sum}`);
      assert.equal(result.parameters.mustChangeChord, true);
    }
  }
});

test("all models hard-mask the current chord for every history and preset", () => {
  for (const current of CHORD_VOCAB.map(({ id }) => id)) {
    for (const model of MODEL_IDS) {
      for (const palette of PALETTES) {
        const result = predictNext(["F", "G", current], { model, palette: palette.id });
        const currentEntry = result.distribution.find(({ id }) => id === current);
        if (currentEntry) assert.equal(currentEntry.probability, 0, `${model}/${palette.id}/${current}`);
        assert.ok(Math.abs(result.distribution.reduce((sum, entry) => sum + entry.probability, 0) - 1) < 1e-12);
        assert.notEqual(sampleDistribution(result.distribution, () => 0), current);
        assert.notEqual(sampleDistribution(result.distribution, () => 1), current);
      }
    }
  }
});

test("temperature changes every model distribution without weakening the no-repeat mask", () => {
  for (const model of MODEL_IDS) {
    const cold = predictNext(["C", "F", "G"], { model, palette: "chromatic", temperature: 0.25 });
    const hot = predictNext(["C", "F", "G"], { model, palette: "chromatic", temperature: 2 });
    assert.equal(cold.parameters.temperature, 0.25);
    assert.equal(hot.parameters.temperature, 2);
    assert.ok(cold.distribution[0].probability > hot.distribution[0].probability, model);
    assert.equal(probabilitiesById(cold).get("G"), 0, `${model} cold repeat`);
    assert.equal(probabilitiesById(hot).get("G"), 0, `${model} hot repeat`);
  }
});

test("authored functional resolutions remain strongest in the chromatic preset", () => {
  const strongest = (history) => predictNext(history, {
    model: "markov1", palette: "chromatic", temperature: 1
  }).distribution[0].id;
  assert.equal(strongest(["D♭/F"]), "G7");
  assert.equal(strongest(["Bdim7"]), "C");
  assert.equal(strongest(["Bø7"]), "C");
  assert.equal(strongest(["E7"]), "Am");
  assert.equal(strongest(["A7"]), "Dm");
  assert.equal(strongest(["D7"]), "G");
  assert.equal(strongest(["F♯dim7"]), "G");
  assert.equal(strongest(["C7"]), "F");
  assert.equal(strongest(["Cdim7"]), "C");
  assert.equal(strongest(["A♭"]), "B♭");
  assert.equal(strongest(["A♭", "B♭"]), "C");

  const mass = (source, targets) => {
    const byId = probabilitiesById(predictNext([source], {
      model: "markov1", palette: "chromatic", temperature: 1
    }));
    return targets.reduce((sum, id) => sum + byId.get(id), 0);
  };
  assert.ok(mass("D♭/F", ["G", "G7"]) > 0.89);
  assert.ok(mass("Bø7", ["C", "Cm"]) > 0.89);
  assert.ok(mass("Bdim7", ["C", "Cm"]) > 0.89);
  assert.ok(mass("E7", ["Am", "Am7"]) > 0.89);
  assert.ok(mass("A7", ["Dm", "Dm7"]) > 0.89);
  assert.ok(mass("D7", ["G", "G7"]) > 0.89);
  assert.ok(mass("F♯dim7", ["G", "G7"]) > 0.89);
});

test("every enabled chord is reachable through authored first-order edges", () => {
  for (const palette of PALETTES) {
    const visited = new Set([palette.chordIds[0]]);
    const queue = [palette.chordIds[0]];
    while (queue.length) {
      const current = queue.shift();
      const result = predictNext([current], { model: "markov1", palette: palette.id, temperature: 1 });
      for (const { id, probability } of result.distribution) {
        if (probability > 0 && !visited.has(id)) {
          visited.add(id);
          queue.push(id);
        }
      }
    }
    assert.deepEqual(visited, new Set(palette.chordIds), `${palette.id}: unreachable enabled chords`);
  }
});

test("Markov memory is exactly one or two chords", () => {
  const options1 = { model: "markov1", palette: "chromatic", temperature: 1 };
  assert.equal(maxDistributionDelta(
    predictNext(["C", "F", "G"], options1),
    predictNext(["Am", "Dm", "G"], options1)
  ), 0);

  const options2 = { model: "markov2", palette: "chromatic", temperature: 1 };
  assert.equal(maxDistributionDelta(
    predictNext(["C", "Am", "Dm", "G"], options2),
    predictNext(["E7", "Am", "Dm", "G"], options2)
  ), 0);
  assert.ok(maxDistributionDelta(
    predictNext(["C", "F", "G"], options2),
    predictNext(["C", "Dm", "G"], options2)
  ) > 0.1);
});

test("Markov · 2 stays meaningfully and visibly distinct for every UI context", () => {
  const chordIds = CHORD_VOCAB.map(({ id }) => id);
  const temperatures = Array.from({ length: 176 }, (_, index) => (25 + index) / 100);
  for (const palette of PALETTES) {
    for (const current of chordIds) {
      const contextSignatures = new Set();
      for (const previous of chordIds) {
        const history = [previous, current];
        const atOne = predictNext(history, { model: "markov2", palette: palette.id, temperature: 1 });
        contextSignatures.add(atOne.distribution.map(({ probability }) => probability.toFixed(12)).join(","));
        for (const temperature of temperatures) {
          const options = { palette: palette.id, temperature };
          const first = predictNext(history, { ...options, model: "markov1" });
          const second = predictNext(history, { ...options, model: "markov2" });
          assert.ok(maxDistributionDelta(first, second) >= 0.03,
            `numeric contrast ${palette.id}/${previous}|${current}/T=${temperature}`);
          assert.notEqual(topFiveUiSignature(first), topFiveUiSignature(second),
            `rendered contrast ${palette.id}/${previous}|${current}/T=${temperature}`);
        }
      }
      assert.ok(contextSignatures.size > 1, `previous chord affects ${palette.id}/*|${current}`);

      for (const temperature of temperatures) {
        const options = { palette: palette.id, temperature };
        const first = predictNext([current], { ...options, model: "markov1" });
        const second = predictNext([current], { ...options, model: "markov2" });
        assert.notEqual(topFiveUiSignature(first), topFiveUiSignature(second),
          `BOS context ${palette.id}/BOS|${current}/T=${temperature}`);
      }
    }
    for (const temperature of temperatures) {
      const options = { palette: palette.id, temperature };
      const first = predictNext([], { ...options, model: "markov1" });
      const second = predictNext([], { ...options, model: "markov2" });
      assert.notEqual(topFiveUiSignature(first), topFiveUiSignature(second),
        `empty BOS ${palette.id}/T=${temperature}`);
    }
  }
});

test("Markov · 2 uses its authored pair rows and discloses the teaching constraint", () => {
  const fg = predictNext(["F", "G"], { model: "markov2", palette: "chromatic", temperature: 1 });
  const dmg = predictNext(["Dm", "G"], { model: "markov2", palette: "chromatic", temperature: 1 });
  assert.equal(fg.distribution[0].id, "Em");
  assert.equal(fg.distribution[1].id, "A♭");
  assert.equal(dmg.distribution[0].id, "C");
  assert.ok(probabilitiesById(dmg).get("Cmaj7") > 0.04);
  assert.equal(fg.parameters.authoredPairBlend, 0.72);
  assert.match(fg.parameters.contextSmoothing, /previous-chord/);
  assert.match(fg.parameters.teachingContrastConstraint, /minimum mass.*3.5 percentage points/);
  assert.match(fg.parameters.provenance, /not a mathematical property/);

  const unlistedLeft = predictNext(["Cmaj9", "Bø7"], { model: "markov2", palette: "chromatic" });
  const unlistedRight = predictNext(["E♭", "Bø7"], { model: "markov2", palette: "chromatic" });
  assert.ok(maxDistributionDelta(unlistedLeft, unlistedRight) > 1e-4);
  assert.equal(unlistedLeft.parameters.authoredPairBlend, 0);
});

test("Markov · 2 recovers a musical alternative after palette masking leaves one first-order choice", () => {
  const first = predictNext(["C", "D♭/F"], { model: "markov1", palette: "pop", temperature: 1 });
  const second = predictNext(["C", "D♭/F"], { model: "markov2", palette: "pop", temperature: 1 });
  assert.equal(first.distribution[0].id, "G");
  assert.equal(first.distribution[0].probability, 1);
  assert.equal(second.distribution[0].id, "G");
  assert.ok(second.distribution[0].probability < 0.95);
  assert.ok(second.distribution[1].probability > 0.02);
  assert.notEqual(second.distribution[1].id, "D♭/F");
});

test("the Transformer responds to an earlier prefix even when the final pair matches", () => {
  const options = { model: "transformer", palette: "chromatic", temperature: 1 };
  const left = predictNext(["C", "F", "G"], options);
  const right = predictNext(["Am", "F", "G"], options);
  assert.deepEqual(left.tokens, ["C", "F", "G"]);
  assert.ok(maxDistributionDelta(left, right) > 1e-5);
  const long = predictNext(["C", "F", "G", "Em", "Am", "Dm", "G", "C", "D7"], options);
  assert.deepEqual(long.tokens, ["F", "G", "Em", "Am", "Dm", "G", "C", "D7"]);
  assert.equal(long.parameters.harmonyPriorBlend, PALETTES.find(({ id }) => id === "chromatic").harmonyPriorBlend);
  assert.match(long.parameters.training.corpus, /synthetic tonal teaching phrases/);
});

test("attention is causal, has no future mass, and every visible row sums to one", () => {
  const result = predictNext(["C", "F", "G", "Em", "Am", "Dm", "G", "C"], {
    model: "transformer", palette: "classical"
  });
  assert.equal(result.attention.length, 2);
  for (const head of result.attention) {
    assert.equal(head.length, 8);
    for (let query = 0; query < head.length; query += 1) {
      assert.equal(head[query].length, 8);
      assert.ok(Math.abs(head[query].reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
      for (let key = query + 1; key < head.length; key += 1) assert.equal(head[query][key], 0);
    }
  }
});

test("JavaScript inference matches the Python-exported parity probe", () => {
  const probe = TINY_TRANSFORMER_WEIGHTS.parityProbe;
  const result = transformerForward(probe.tokens.map((token) => ids.get(token)));
  assert.equal(result.logits.length, probe.logits.length);
  result.logits.forEach((value, index) => assert.ok(Math.abs(value - probe.logits[index]) < 3e-6));
  for (let head = 0; head < result.attention.length; head += 1) {
    for (let query = 0; query < result.attention[head].length; query += 1) {
      for (let key = 0; key < result.attention[head][query].length; key += 1) {
        assert.ok(Math.abs(result.attention[head][query][key] - probe.attention[head][query][key]) < 5e-7);
      }
    }
  }
});

test("sampling consumes the displayed distribution, including boundary draws", () => {
  const distribution = [
    { id: "C", probability: 0.25 },
    { id: "G", probability: 0.75 },
    { id: "F", probability: 0 }
  ];
  assert.equal(sampleDistribution(distribution, () => 0), "C");
  assert.equal(sampleDistribution(distribution, () => 0.249999), "C");
  assert.equal(sampleDistribution(distribution, () => 0.25), "G");
  assert.equal(sampleDistribution(distribution, () => 1), "G");
  assert.throws(() => sampleDistribution(distribution, () => -0.1), /0 to 1/);
});

test("seeded Transformer generation has no immediate repeats", () => {
  for (const [paletteIndex, palette] of PALETTES.entries()) {
    let seed = 73421 + paletteIndex;
    const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
    let repeats = 0;
    let transitions = 0;
    for (let run = 0; run < 8; run += 1) {
      const history = ["C"];
      for (let step = 0; step < 12; step += 1) {
        const result = predictNext(history, { model: "transformer", palette: palette.id });
        const next = sampleDistribution(result.distribution, random);
        repeats += Number(next === history.at(-1));
        transitions += 1;
        history.push(next);
      }
    }
    assert.equal(repeats, 0, `${palette.id}: ${repeats}/${transitions} immediate repeats`);
  }
});

test("voiceChord preserves pitch classes in a compact, stable register", () => {
  let previous = [];
  for (const id of ["C", "F", "G", "A♭", "B♭", "C", "D♭/F", "G7", "C"]) {
    const entry = CHORD_VOCAB.find((candidate) => candidate.id === id);
    const voiced = voiceChord(id, previous);
    assert.deepEqual(new Set(voiced.map((midi) => midi % 12)), new Set(entry.pcs));
    assert.ok(Math.min(...voiced) >= 48 && Math.max(...voiced) <= 79);
    assert.ok(Math.max(...voiced) - Math.min(...voiced) <= 19);
    if (id === "D♭/F") assert.equal(voiced[0] % 12, 5);
    if (previous.length) {
      const averageNearestMotion = voiced.reduce((sum, midi) => (
        sum + Math.min(...previous.map((old) => Math.abs(old - midi)))
      ), 0) / voiced.length;
      assert.ok(averageNearestMotion <= 5);
    }
    previous = voiced;
  }
});
