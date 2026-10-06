import { TINY_TRANSFORMER_WEIGHTS } from "./tiny-transformer.js";

const chord = (id, label, roman, pcs, root, family, bass) => Object.freeze({
  id, label, roman, pcs: Object.freeze(pcs), root, family,
  ...(bass === undefined ? {} : { bass })
});

// Pitch classes use C = 0.  The id order deliberately matches the transformer's
// training vocabulary; do not reorder without retraining the exported model.
export const CHORD_VOCAB = Object.freeze([
  chord("C", "C", "I", [0, 4, 7], 0, "major"),
  chord("F", "F", "IV", [5, 9, 0], 5, "major"),
  chord("G", "G", "V", [7, 11, 2], 7, "major"),
  chord("Am", "Am", "vi", [9, 0, 4], 9, "minor"),
  chord("Dm", "Dm", "ii", [2, 5, 9], 2, "minor"),
  chord("Dm7", "Dm7", "ii7", [2, 5, 9, 0], 2, "minor-seventh"),
  chord("G7", "G7", "V7", [7, 11, 2, 5], 7, "dominant"),
  chord("Cmaj7", "Cmaj7", "Imaj7", [0, 4, 7, 11], 0, "major-seventh"),
  chord("Cmaj9", "Cmaj9", "Imaj9", [0, 4, 7, 11, 2], 0, "major-ninth"),
  chord("C7", "C7", "V7/IV", [0, 4, 7, 10], 0, "dominant"),
  chord("Cm", "Cm", "i", [0, 3, 7], 0, "minor"),
  chord("Cm7", "Cm7", "i7", [0, 3, 7, 10], 0, "minor-seventh"),
  chord("Cm9", "Cm9", "i9", [0, 3, 7, 10, 2], 0, "minor-ninth"),
  chord("Cdim7", "Cdim7", "ct°7", [0, 3, 6, 9], 0, "diminished-seventh"),
  chord("A♭", "A♭", "♭VI", [8, 0, 3], 8, "major"),
  chord("Em", "Em", "iii", [4, 7, 11], 4, "minor"),
  chord("B♭", "B♭", "♭VII", [10, 2, 5], 10, "major"),
  chord("Fmaj7", "Fmaj7", "IVmaj7", [5, 9, 0, 4], 5, "major-seventh"),
  chord("Fm", "Fm", "iv", [5, 8, 0], 5, "minor"),
  chord("Fm7", "Fm7", "iv7", [5, 8, 0, 3], 5, "minor-seventh"),
  chord("G9", "G9", "V9", [7, 11, 2, 5, 9], 7, "dominant-ninth"),
  chord("Am7", "Am7", "vi7", [9, 0, 4, 7], 9, "minor-seventh"),
  chord("Em7", "Em7", "iii7", [4, 7, 11, 2], 4, "minor-seventh"),
  chord("B♭7", "B♭7", "♭VII7", [10, 2, 5, 8], 10, "dominant"),
  chord("E♭", "E♭", "♭III", [3, 7, 10], 3, "major"),
  chord("D♭/F", "D♭/F", "♭II6", [1, 5, 8], 1, "neapolitan", 5),
  chord("Bø7", "Bø7", "viiø7", [11, 2, 5, 9], 11, "half-diminished"),
  chord("Bdim7", "Bdim7", "vii°7", [11, 2, 5, 8], 11, "diminished-seventh"),
  chord("C♯dim7", "C♯dim7", "vii°7/ii", [1, 4, 7, 10], 1, "diminished-seventh"),
  chord("F♯dim7", "F♯dim7", "vii°7/V", [6, 9, 0, 3], 6, "diminished-seventh"),
  chord("A7", "A7", "V7/ii", [9, 1, 4, 7], 9, "secondary-dominant"),
  chord("D7", "D7", "V7/V", [2, 6, 9, 0], 2, "secondary-dominant"),
  chord("E7", "E7", "V7/vi", [4, 8, 11, 2], 4, "secondary-dominant")
]);

const palette = (id, label, description, chordIds, temperature, harmonyPriorBlend) => Object.freeze({
  id, label, description, chordIds: Object.freeze(chordIds), temperature, harmonyPriorBlend
});

const ALL_CHORD_IDS = CHORD_VOCAB.map(({ id }) => id);
export const PALETTES = Object.freeze([
  palette("pop", "Pop", "Diatonic loops with a little modal colour.",
    ["C", "F", "G", "Am", "Dm", "Em", "A♭", "B♭", "C7", "Fm"], 0.82, 0.18),
  palette("classical", "Classical", "Functional cadences, mixture, Neapolitan and applied dominants.",
    ["C", "F", "G", "Am", "Dm", "G7", "Cm", "A♭", "Em", "B♭", "Fm", "D♭/F", "Bø7", "Bdim7", "C♯dim7", "F♯dim7", "A7", "D7", "E7", "Cdim7", "C7"], 0.72, 0.28),
  palette("jazz", "Jazz", "Sevenths and ninths with ii–V motion and chromatic approaches.",
    ["Cmaj7", "Cmaj9", "Fmaj7", "Dm7", "G7", "G9", "Am7", "Em7", "C7", "Cm7", "Cm9", "Fm7", "B♭7", "E♭", "C♯dim7", "F♯dim7", "A7", "D7", "E7"], 0.92, 0.16),
  palette("chromatic", "Chromatic", "The complete 33-chord teaching vocabulary.", ALL_CHORD_IDS, 1.04, 0.22)
]);

export const MODEL_IDS = Object.freeze(["markov1", "markov2", "transformer"]);

const CHORD_BY_ID = new Map(CHORD_VOCAB.map((entry) => [entry.id, entry]));
const PALETTE_BY_ID = new Map(PALETTES.map((entry) => [entry.id, entry]));
const TOKEN_INDEX = new Map(CHORD_VOCAB.map((entry, index) => [entry.id, index]));

const FIRST_ORDER = Object.freeze({
  C: { F: 22, G: 20, Am: 16, Em: 12, Cmaj7: 10, C7: 8, "A♭": 6, Dm: 6, D7: 5, A7: 4, Cdim7: 3 },
  F: { G: 28, C: 23, Em: 15, "A♭": 14, Am: 8, Fm: 7, Dm: 5 },
  G: { C: 46, Am: 14, Em: 12, "A♭": 12, G7: 8, F: 8, Bdim7: 8 },
  Am: { Dm: 28, F: 20, E7: 16, G: 14, C: 12, Am7: 10 },
  Dm: { G: 50, G7: 25, Am: 10, F: 10, Dm7: 5, "Bø7": 4 },
  Dm7: { G7: 48, G9: 26, Cmaj7: 10, Em7: 9, A7: 7 },
  G7: { C: 54, Cmaj7: 22, Am: 10, Cm: 8, Cmaj9: 6, Bdim7: 7 },
  Cmaj7: { Am7: 24, Dm7: 20, Em7: 18, Fmaj7: 16, C7: 12, Cmaj9: 10, D7: 5 },
  Cmaj9: { Am7: 28, Dm7: 22, Fmaj7: 18, Em7: 14, C7: 10, Cmaj9: 8 },
  C7: { F: 52, Fmaj7: 20, Fm: 16, Fm7: 12 },
  Cm: { Fm: 26, G7: 26, "A♭": 18, "B♭": 14, "Bø7": 10, Cm7: 6 },
  Cm7: { Fm7: 30, "B♭7": 28, G7: 18, "A♭": 14, Cm9: 10 },
  Cm9: { Fm7: 34, "B♭7": 26, G7: 18, "D♭/F": 14, Cm9: 8 },
  Cdim7: { C: 72, Am: 16, Cm: 12 },
  "A♭": { "B♭": 55, Fm: 20, C: 15, Cm: 10 },
  Em: { Am: 34, F: 24, Dm: 14, G: 12, C: 10, E7: 6 },
  "B♭": { C: 55, Cm: 18, F: 12, "E♭": 10, "B♭7": 5 },
  Fmaj7: { Em7: 25, Dm7: 23, G9: 18, Cmaj7: 16, Fm7: 10, Am7: 8, D7: 5 },
  Fm: { C: 40, G7: 22, Cm: 18, "D♭/F": 12, "A♭": 8 },
  Fm7: { "B♭7": 38, Cmaj7: 18, Cm7: 16, G7: 14, "E♭": 14 },
  G9: { Cmaj7: 44, Cmaj9: 32, Am7: 12, Cm9: 7, Fmaj7: 5 },
  Am7: { Dm7: 37, Fmaj7: 19, E7: 16, G9: 12, Em7: 9, Cmaj7: 7 },
  Em7: { A7: 38, Am7: 21, Dm7: 16, Fmaj7: 13, Cmaj7: 12 },
  "B♭7": { "E♭": 63, Cm7: 17, Fm7: 12, Cmaj7: 8 },
  "E♭": { "A♭": 28, Fm7: 22, "B♭7": 20, G7: 16, Cm7: 14 },
  "D♭/F": { G7: 62, G: 30, Cm: 8 },
  "Bø7": { C: 55, Cm: 35, Dm: 10 },
  Bdim7: { C: 65, Cm: 27, Am: 8 },
  "C♯dim7": { Dm: 62, Dm7: 25, A7: 13 },
  "F♯dim7": { G: 78, G7: 17, Em: 5 },
  A7: { Dm: 68, Dm7: 22, "C♯dim7": 10 },
  D7: { G: 65, G7: 25, "F♯dim7": 10 },
  E7: { Am: 72, Am7: 18, C: 10 }
});

const SECOND_ORDER = Object.freeze({
  "C|F": { G: 46, Em: 21, "A♭": 18, C: 15 },
  "F|G": { Em: 42, "A♭": 36, C: 14, Am: 8 },
  "G|Em": { Am: 62, F: 20, Dm: 10, C: 8 },
  "Em|Am": { Dm: 58, F: 22, E7: 12, G: 8 },
  "Am|Dm": { G: 65, G7: 25, F: 10 },
  "Dm|G": { C: 75, Cmaj7: 15, Am: 10 },
  "A♭|B♭": { C: 75, Cm: 15, F: 10 },
  "C|E7": { Am: 82, Am7: 13, C: 5 },
  "C|A7": { Dm: 78, Dm7: 17, "C♯dim7": 5 },
  "C|D7": { G: 76, G7: 18, "F♯dim7": 6 },
  "C|D♭/F": { G7: 75, G: 25 },
  "G|Bdim7": { C: 84, Cm: 10, Am: 6 },
  "Cm|Bø7": { Cm: 78, C: 14, Dm: 8 },
  "C|Cdim7": { C: 86, Am: 9, Cm: 5 },
  "Em7|A7": { Dm7: 82, Dm: 13, "C♯dim7": 5 },
  "Dm7|G9": { Cmaj9: 62, Cmaj7: 30, Am7: 8 },
  "Fm7|B♭7": { "E♭": 82, Cm7: 12, G7: 6 }
});

const BASELINE = Object.freeze({
  C: 16, F: 11, G: 13, Am: 9, Dm: 8, G7: 8, Cmaj7: 5, Cm: 4,
  Em: 4, "A♭": 3, "B♭": 3, Dm7: 3, Fmaj7: 3, Am7: 3, G9: 2,
  Cmaj9: 2, Fm: 2, E7: 2, A7: 1, D7: 1
});

// A real beginning-of-sequence prior for Markov · 2.  It is deliberately
// separate from the first-order C row: a new phrase can begin away from I.
const MARKOV2_START = Object.freeze({
  C: 24, Am: 16, F: 14, Dm: 11, G: 10, Cmaj7: 8, Cm: 7, Fmaj7: 6,
  Dm7: 5, "A♭": 5, Em: 4, Am7: 4, Cmaj9: 3, Fm: 3, "E♭": 2, G7: 2
});

const MARKOV2_CONTEXT_BLEND = 0.42;
const MARKOV2_AUTHORED_BLEND = 0.72;
const MARKOV2_MIN_VISIBLE_DELTA = 0.035;
const MARKOV2_CONTEXT_CACHE = new Map();

function normalizedWeights(weightMap, enabledIds) {
  const weights = enabledIds.map((id) => Math.max(0, Number(weightMap?.[id]) || 0));
  let total = weights.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) {
    const fallback = enabledIds.map((id) => Math.max(0, Number(BASELINE[id]) || 1));
    total = fallback.reduce((sum, value) => sum + value, 0);
    return fallback.map((value) => value / total);
  }
  return weights.map((value) => value / total);
}

function applyTemperature(probabilities, temperature) {
  const power = 1 / temperature;
  const adjusted = probabilities.map((value) => value > 0 ? Math.pow(value, power) : 0);
  const total = adjusted.reduce((sum, value) => sum + value, 0);
  return adjusted.map((value) => value / total);
}

function softmax(logits) {
  const maximum = Math.max(...logits);
  const values = logits.map((value) => Math.exp(value - maximum));
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}

function transformerDistribution(logits, enabledIds, prior, priorBlend) {
  const full = softmax(logits);
  const selected = enabledIds.map((id) => full[TOKEN_INDEX.get(id)]);
  const selectedTotal = selected.reduce((sum, value) => sum + value, 0);
  const masked = selected.map((value) => value / selectedTotal);
  return masked.map((value, index) => (1 - priorBlend) * value + priorBlend * prior[index]);
}

function enforceChordChange(probabilities, enabledIds, currentId) {
  const withoutCurrent = probabilities.map((value, index) => enabledIds[index] === currentId ? 0 : value);
  let total = withoutCurrent.reduce((sum, value) => sum + value, 0);
  if (!(total > Number.MIN_VALUE)) {
    const fallback = enabledIds.map((id) => id === currentId ? 0 : Math.max(0, Number(BASELINE[id]) || 1));
    total = fallback.reduce((sum, value) => sum + value, 0);
    if (!(total > 0)) throw new RangeError("palette must contain an alternative to the current chord");
    return fallback.map((value) => value / total);
  }
  return withoutCurrent.map((value) => value / total);
}

function withoutCurrent(probabilities, enabledIds, currentId) {
  return enforceChordChange(probabilities, enabledIds, currentId);
}

function pitchClassOverlap(left, right) {
  let shared = 0;
  for (const pitchClass of left.pcs) shared += Number(right.pcs.includes(pitchClass));
  return shared / Math.max(left.pcs.length, right.pcs.length);
}

function signedRootMotion(from, to) {
  const upward = mod12(to.root - from.root);
  return upward > 6 ? upward - 12 : upward;
}

// Scores a candidate as the continuation of an actual two-chord gesture.  The
// previous row supplies phrase memory; the remaining terms favour shared chord
// tones, familiar root motion, and a change of melodic-root direction.
function contextualConnectionWeights(previousId, currentId, enabledIds) {
  const previousWeights = normalizedWeights(
    previousId ? FIRST_ORDER[previousId] : MARKOV2_START,
    enabledIds
  );
  const baselineWeights = normalizedWeights(BASELINE, enabledIds);
  const previous = previousId ? CHORD_BY_ID.get(previousId) : null;
  const current = currentId ? CHORD_BY_ID.get(currentId) : null;
  const incoming = previous && current ? signedRootMotion(previous, current) : 0;
  const musicalScores = enabledIds.map((id) => {
    if (id === currentId) return 0;
    const candidate = CHORD_BY_ID.get(id);
    let musical = 1;
    if (current) {
      const outgoing = signedRootMotion(current, candidate);
      const interval = Math.abs(outgoing);
      musical += 1.8 * pitchClassOverlap(current, candidate);
      if (interval === 5) musical += 1.4;
      else if (interval === 1 || interval === 2) musical += 0.8;
      else if (interval === 3 || interval === 4) musical += 0.45;
      if (incoming && outgoing && Math.sign(incoming) !== Math.sign(outgoing)) musical += 0.75;
      if (previous) musical += 0.55 * pitchClassOverlap(previous, candidate);
    }
    return musical;
  });
  const musicalTotal = musicalScores.reduce((sum, value) => sum + value, 0);
  const raw = enabledIds.map((id, index) => id === currentId ? 0 : (
    0.58 * previousWeights[index]
    + 0.17 * baselineWeights[index]
    + 0.25 * musicalScores[index] / musicalTotal
  ));
  return normalizedWeights(Object.fromEntries(enabledIds.map((id, index) => [id, raw[index]])), enabledIds);
}

function blendDistributions(left, right, rightShare) {
  return left.map((value, index) => (1 - rightShare) * value + rightShare * right[index]);
}

function markov2Distribution(previousId, currentId, enabledIds, firstOrder) {
  const base = withoutCurrent(firstOrder, enabledIds, currentId);
  const contextual = contextualConnectionWeights(previousId, currentId, enabledIds);
  const authoredRow = previousId && currentId ? SECOND_ORDER[`${previousId}|${currentId}`] : null;
  const hasAuthoredSupport = Boolean(authoredRow && enabledIds.some((id) => id !== currentId && authoredRow[id] > 0));
  const authored = hasAuthoredSupport
    ? withoutCurrent(normalizedWeights(authoredRow, enabledIds), enabledIds, currentId)
    : null;
  // The 17 hand-authored phrase rows remain the musical statement.  A small
  // general context prior only smooths them; unseen pairs instead interpolate
  // the first-order row with that prior.
  const context = authored || contextual;
  const smoothed = authored
    ? blendDistributions(contextual, authored, MARKOV2_AUTHORED_BLEND)
    : blendDistributions(base, contextual, MARKOV2_CONTEXT_BLEND);

  let leaderIndex = 0;
  for (let index = 1; index < base.length; index += 1) {
    if (base[index] > base[leaderIndex]) leaderIndex = index;
  }
  const leaderValue = base[leaderIndex];
  const firstOrderLeaders = new Set(base.flatMap((value, index) => (
    Math.abs(value - leaderValue) < 1e-14 ? [index] : []
  )));
  let anchorIndex = -1;
  for (let index = 0; index < context.length; index += 1) {
    if (enabledIds[index] === currentId || firstOrderLeaders.has(index)) continue;
    if (anchorIndex < 0 || context[index] > context[anchorIndex]) anchorIndex = index;
  }
  if (anchorIndex < 0) {
    for (let index = 0; index < context.length; index += 1) {
      if (index !== leaderIndex && enabledIds[index] !== currentId && (anchorIndex < 0 || context[index] > context[anchorIndex])) {
        anchorIndex = index;
      }
    }
  }
  return { probabilities: smoothed, leaderIndex, anchorIndex, hasAuthoredSupport };
}

function cachedMarkov2Distribution(previousId, currentId, selectedPalette, firstOrder) {
  const cacheKey = `${selectedPalette.id}|${previousId ?? "BOS"}|${currentId ?? "BOS"}`;
  let context = MARKOV2_CONTEXT_CACHE.get(cacheKey);
  if (!context) {
    context = markov2Distribution(previousId, currentId, selectedPalette.chordIds, firstOrder);
    MARKOV2_CONTEXT_CACHE.set(cacheKey, context);
  }
  return context;
}

function renderedDistributionSignature(probabilities, enabledIds) {
  const sorted = enabledIds.map((id, index) => ({ id, probability: probabilities[index] }))
    .sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
  const visible = sorted.filter(({ probability }) => probability > 0).slice(0, 5);
  const shown = new Set(visible.map(({ id }) => id));
  const label = (value) => value > 0 && value < 0.01 ? "<1%" : `${Math.round(value * 100)}%`;
  const other = sorted.reduce((sum, item) => sum + (shown.has(item.id) ? 0 : item.probability), 0);
  return [...visible.map(({ id, probability }) => `${id}:${label(probability)}`),
    ...(other > 0.0005 ? [`Other:${label(other)}`] : [])].join("|");
}

function ensureMarkov2TeachingContrast(probabilities, firstOrder, enabledIds, leaderIndex, anchorIndex) {
  const largestDelta = Math.max(...probabilities.map((value, index) => Math.abs(value - firstOrder[index])));
  if (largestDelta >= MARKOV2_MIN_VISIBLE_DELTA
    && renderedDistributionSignature(probabilities, enabledIds) !== renderedDistributionSignature(firstOrder, enabledIds)) {
    return probabilities;
  }
  if (anchorIndex < 0 || anchorIndex === leaderIndex) return probabilities;
  const adjusted = [...probabilities];
  const desiredLeaderMaximum = Math.max(0, firstOrder[leaderIndex] - MARKOV2_MIN_VISIBLE_DELTA);
  const transfer = Math.min(adjusted[leaderIndex], Math.max(0, adjusted[leaderIndex] - desiredLeaderMaximum));
  if (transfer > 0) {
    adjusted[leaderIndex] -= transfer;
    adjusted[anchorIndex] += transfer;
  }
  return adjusted;
}

function resolveHistory(history) {
  if (!Array.isArray(history)) throw new TypeError("history must be an array of chord ids");
  for (const id of history) {
    if (!CHORD_BY_ID.has(id)) throw new RangeError(`Unknown chord id: ${id}`);
  }
  return history;
}

function resolveOptions(options = {}) {
  const model = options.model ?? "markov1";
  const paletteId = options.palette ?? "classical";
  if (!MODEL_IDS.includes(model)) throw new RangeError(`Unknown harmony model: ${model}`);
  const selectedPalette = PALETTE_BY_ID.get(paletteId);
  if (!selectedPalette) throw new RangeError(`Unknown harmony palette: ${paletteId}`);
  const temperature = options.temperature ?? selectedPalette.temperature;
  if (!Number.isFinite(temperature) || temperature <= 0) throw new RangeError("temperature must be positive");
  return { model, selectedPalette, temperature };
}

let preparation;
export async function prepareModels() {
  if (!preparation) preparation = Promise.resolve().then(() => {
    const architecture = TINY_TRANSFORMER_WEIGHTS.architecture;
    if (architecture.contextLength !== 8 || architecture.dModel !== 24 || architecture.heads !== 2) {
      throw new Error("Unsupported tiny Transformer architecture");
    }
    if (TINY_TRANSFORMER_WEIGHTS.tokenEmbedding.length !== CHORD_VOCAB.length) {
      throw new Error("Transformer vocabulary does not match CHORD_VOCAB");
    }
    return Object.freeze({ transformer: true });
  });
  return preparation;
}

export function predictNext(history, options = {}) {
  const usableHistory = resolveHistory(history);
  const { model, selectedPalette, temperature } = resolveOptions(options);
  const modelHistory = model === "markov2" || usableHistory.length ? usableHistory : ["C"];
  const enabledIds = selectedPalette.chordIds;
  const last = modelHistory.at(-1);
  const firstOrder = normalizedWeights(last ? FIRST_ORDER[last] : BASELINE, enabledIds);
  let probabilities;
  let attention = [];
  let tokens;
  let parameters;
  let markov2Context;

  if (model === "markov1") {
    probabilities = firstOrder;
    tokens = [last];
    parameters = {
      order: 1,
      conditioning: "last chord only",
      temperature,
      mustChangeChord: true,
      authoredTransitions: true,
      empiricalCorpus: false
    };
  } else if (model === "markov2") {
    const previous = usableHistory.at(-2);
    markov2Context = cachedMarkov2Distribution(previous, last, selectedPalette, firstOrder);
    probabilities = markov2Context.probabilities;
    tokens = usableHistory.slice(-2);
    parameters = {
      order: 2,
      conditioning: previous ? "last two chords" : last ? "BOS plus current chord" : "BOS start prior",
      temperature,
      mustChangeChord: true,
      authoredTransitions: true,
      empiricalCorpus: false,
      contextSmoothing: "previous-chord continuation, shared chord tones, root motion, and authored phrase anchors",
      contextBlend: MARKOV2_CONTEXT_BLEND,
      authoredPairBlend: markov2Context.hasAuthoredSupport ? MARKOV2_AUTHORED_BLEND : 0,
      teachingContrastConstraint: `after temperature, only when needed: move the minimum mass to a context-selected musical alternative so a leading probability differs by at least ${Math.round(MARKOV2_MIN_VISIBLE_DELTA * 1000) / 10} percentage points`,
      provenance: "Authored teaching model. The visible Markov-order contrast is an explicit demonstration constraint, not a mathematical property of Markov models."
    };
  } else {
    tokens = modelHistory.slice(-TINY_TRANSFORMER_WEIGHTS.architecture.contextLength);
    const tokenIds = tokens.map((id) => TOKEN_INDEX.get(id));
    const forward = transformerForward(tokenIds, TINY_TRANSFORMER_WEIGHTS);
    attention = forward.attention;
    probabilities = transformerDistribution(
      forward.logits,
      enabledIds,
      firstOrder,
      selectedPalette.harmonyPriorBlend
    );
    parameters = {
      ...TINY_TRANSFORMER_WEIGHTS.architecture,
      temperature,
      mustChangeChord: true,
      harmonyPriorBlend: selectedPalette.harmonyPriorBlend,
      harmonyPrior: "authored first-order row blended after palette masking",
      training: TINY_TRANSFORMER_WEIGHTS.training
    };
  }

  probabilities = applyTemperature(enforceChordChange(probabilities, enabledIds, last), temperature);
  if (model === "markov2") {
    const temperedFirstOrder = applyTemperature(enforceChordChange(firstOrder, enabledIds, last), temperature);
    probabilities = ensureMarkov2TeachingContrast(
      probabilities,
      temperedFirstOrder,
      enabledIds,
      markov2Context.leaderIndex,
      markov2Context.anchorIndex
    );
  }

  const distribution = enabledIds
    .map((id, index) => ({ id, probability: probabilities[index] }))
    .sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
  return { distribution, attention, tokens, parameters, model, palette: selectedPalette.id };
}

export function sampleDistribution(distribution, random = Math.random) {
  if (!Array.isArray(distribution) || distribution.length === 0) throw new TypeError("distribution must be a non-empty array");
  if (typeof random !== "function") throw new TypeError("random must be a function");
  const rawDraw = Number(random());
  if (!Number.isFinite(rawDraw) || rawDraw < 0 || rawDraw > 1) throw new RangeError("random must return a number from 0 to 1");
  const draw = rawDraw === 1 ? 1 - Number.EPSILON : rawDraw;
  const total = distribution.reduce((sum, item) => {
    if (!item || !CHORD_BY_ID.has(item.id) || !Number.isFinite(item.probability) || item.probability < 0) {
      throw new TypeError("distribution entries need a known id and nonnegative finite probability");
    }
    return sum + item.probability;
  }, 0);
  if (!(total > 0)) throw new RangeError("distribution must have positive mass");
  let cumulative = 0;
  for (const item of distribution) {
    cumulative += item.probability / total;
    if (draw < cumulative) return item.id;
  }
  for (let index = distribution.length - 1; index >= 0; index -= 1) {
    if (distribution[index].probability > 0) return distribution[index].id;
  }
  throw new RangeError("distribution must have positive mass");
}

const mod12 = (value) => ((value % 12) + 12) % 12;

function voicingCandidates(entry) {
  const orders = [];
  const visit = (prefix, remaining) => {
    if (!remaining.length) {
      orders.push(prefix);
      return;
    }
    remaining.forEach((pc, index) => visit([...prefix, pc], [...remaining.slice(0, index), ...remaining.slice(index + 1)]));
  };
  visit([], [...entry.pcs]);
  const candidates = [];
  for (const order of orders) {
    for (let first = 48; first <= 64; first += 1) {
      if (mod12(first) !== order[0]) continue;
      const notes = [first];
      for (const pc of order.slice(1)) {
        let next = notes.at(-1) + 1;
        while (mod12(next) !== pc) next += 1;
        notes.push(next);
      }
      if (notes.at(-1) <= 79 && notes.at(-1) - notes[0] <= 19) candidates.push(notes);
    }
  }
  return candidates;
}

const VOICINGS = new Map(CHORD_VOCAB.map((entry) => [entry.id, voicingCandidates(entry)]));

function voiceLeadingCost(notes, previous) {
  if (!previous.length) return 0;
  const towardPrevious = notes.reduce((sum, note) => sum + Math.min(...previous.map((old) => Math.abs(note - old))), 0);
  const towardNew = previous.reduce((sum, old) => sum + Math.min(...notes.map((note) => Math.abs(note - old))), 0);
  return towardPrevious + 0.35 * towardNew;
}

export function voiceChord(id, previousMidis = []) {
  const entry = CHORD_BY_ID.get(id);
  if (!entry) throw new RangeError(`Unknown chord id: ${id}`);
  if (!Array.isArray(previousMidis) || previousMidis.some((midi) => !Number.isFinite(midi))) {
    throw new TypeError("previousMidis must be an array of MIDI note numbers");
  }
  const preferredBass = entry.bass ?? entry.root;
  let best;
  let bestCost = Infinity;
  for (const notes of VOICINGS.get(id)) {
    if (entry.bass !== undefined && mod12(notes[0]) !== entry.bass) continue;
    const centre = notes.reduce((sum, note) => sum + note, 0) / notes.length;
    const bassPenalty = mod12(notes[0]) === preferredBass ? 0 : 5.5;
    const registerPenalty = Math.abs(centre - 64) * 0.38;
    const spanPenalty = Math.max(0, notes.at(-1) - notes[0] - 12) * 0.18;
    const cost = voiceLeadingCost(notes, previousMidis) + bassPenalty + registerPenalty + spanPenalty;
    if (cost < bestCost) {
      bestCost = cost;
      best = notes;
    }
  }
  return [...best];
}

function linear(vector, layer) {
  return layer.weight.map((row, outputIndex) => {
    let sum = layer.bias[outputIndex];
    for (let index = 0; index < vector.length; index += 1) sum += row[index] * vector[index];
    return sum;
  });
}

function layerNorm(vector, layer, epsilon) {
  const mean = vector.reduce((sum, value) => sum + value, 0) / vector.length;
  const variance = vector.reduce((sum, value) => sum + (value - mean) ** 2, 0) / vector.length;
  const scale = 1 / Math.sqrt(variance + epsilon);
  return vector.map((value, index) => (value - mean) * scale * layer.weight[index] + layer.bias[index]);
}

function geluTanh(value) {
  const coefficient = Math.sqrt(2 / Math.PI);
  return 0.5 * value * (1 + Math.tanh(coefficient * (value + 0.044715 * value ** 3)));
}

export function transformerForward(tokenIds, weights = TINY_TRANSFORMER_WEIGHTS) {
  if (!Array.isArray(tokenIds) || tokenIds.length < 1 || tokenIds.length > weights.architecture.contextLength) {
    throw new RangeError(`Transformer input must contain 1–${weights.architecture.contextLength} tokens`);
  }
  if (tokenIds.some((id) => !Number.isInteger(id) || id < 0 || id >= CHORD_VOCAB.length)) {
    throw new RangeError("Transformer token ids are outside the vocabulary");
  }
  const { dModel, heads, dHead, layerNormEpsilon } = weights.architecture;
  let x = tokenIds.map((tokenId, position) => weights.tokenEmbedding[tokenId].map(
    (value, index) => value + weights.positionEmbedding[position][index]
  ));
  const normalized = x.map((vector) => layerNorm(vector, weights.ln1, layerNormEpsilon));
  const queries = normalized.map((vector) => linear(vector, weights.q));
  const keys = normalized.map((vector) => linear(vector, weights.k));
  const values = normalized.map((vector) => linear(vector, weights.v));
  const attention = Array.from({ length: heads }, () => []);
  const attended = Array.from({ length: tokenIds.length }, () => Array(dModel).fill(0));
  for (let head = 0; head < heads; head += 1) {
    const offset = head * dHead;
    for (let query = 0; query < tokenIds.length; query += 1) {
      const scores = [];
      for (let key = 0; key <= query; key += 1) {
        let dot = 0;
        for (let index = 0; index < dHead; index += 1) {
          dot += queries[query][offset + index] * keys[key][offset + index];
        }
        scores.push(dot / Math.sqrt(dHead));
      }
      const row = softmax(scores);
      const paddedRow = [...row, ...Array(tokenIds.length - row.length).fill(0)];
      attention[head].push(paddedRow);
      for (let key = 0; key <= query; key += 1) {
        for (let index = 0; index < dHead; index += 1) {
          attended[query][offset + index] += row[key] * values[key][offset + index];
        }
      }
    }
  }
  x = x.map((vector, position) => {
    const projected = linear(attended[position], weights.o);
    return vector.map((value, index) => value + projected[index]);
  });
  x = x.map((vector) => {
    const hidden = linear(layerNorm(vector, weights.ln2, layerNormEpsilon), weights.ff1).map(geluTanh);
    const projected = linear(hidden, weights.ff2);
    return vector.map((value, index) => value + projected[index]);
  });
  x = x.map((vector) => layerNorm(vector, weights.lnFinal, layerNormEpsilon));
  return { logits: linear(x.at(-1), weights.output), attention };
}
