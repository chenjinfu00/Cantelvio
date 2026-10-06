import { HARMONY_TRANSFORMER_WEIGHTS as W } from './harmony-transformer.js';
import { CHORD_VOCAB, BASE_CHORDS, QUALITIES, getChord, mod12 } from './chord-vocabulary.js';
import { resolveKey, keyPitches, keyLabel } from './tonality.js';
export { CHORD_VOCAB, BASE_CHORDS, QUALITIES, getChord } from './chord-vocabulary.js';
export const MODEL_IDS = Object.freeze(['transformer']);
export const MODEL_METADATA = Object.freeze({ architecture: W.architecture, training: W.training });
const all = Object.freeze(CHORD_VOCAB.map(c => c.id));
// Styles condition the network; none of them hard-mask the expanded vocabulary.
export const PALETTES = Object.freeze([
    { id: 'pop', label: 'Pop', temperature: .78 }, { id: 'classical', label: 'Classical', temperature: .72 },
    { id: 'jazz', label: 'Jazz', temperature: .82 }, { id: 'chromatic', label: 'Exploratory', temperature: .96 }
].map(p => Object.freeze({ ...p, chordIds: all })));
const softmax = values => {
    const max = Math.max(...values), exps = values.map(v => Number.isFinite(v) ? Math.exp(Math.max(-700, v - max)) : 0), sum = exps.reduce((a, b) => a + b, 0);
    return exps.map(v => v / sum);
};
function linear(x, layer) { const out = new Array(layer.weight.length); for (let j = 0; j < out.length; j++) {
    let n = layer.bias[j];
    const row = layer.weight[j];
    for (let i = 0; i < x.length; i++)
        n += row[i] * x[i];
    out[j] = n;
} return out; }
function norm(x, layer, epsilon) { let m = 0, v = 0; for (const n of x)
    m += n; m /= x.length; for (const n of x)
    v += (n - m) ** 2; const s = 1 / Math.sqrt(v / x.length + epsilon); return x.map((n, i) => (n - m) * s * layer.weight[i] + layer.bias[i]); }
const gelu = x => .5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + .044715 * x * x * x)));
export function transformerForward(tokens, { inversions = tokens.map(() => 0), mode = 0, style = 0 } = {}, weights = W) {
    const { contextLength, dModel, heads, dHead, layerNormEpsilon } = weights.architecture;
    if (!Array.isArray(tokens) || !tokens.length || tokens.length > contextLength || tokens.some(n => !Number.isInteger(n) || n < 0 || n >= BASE_CHORDS.length))
        throw new RangeError('Invalid Transformer chord tokens');
    if (inversions.length !== tokens.length || inversions.some((n, i) => !Number.isInteger(n) || n < 0 || n >= QUALITIES[Math.floor(tokens[i] / 12)].intervals.length))
        throw new RangeError('Invalid chord inversion');
    if (![0, 1].includes(mode) || ![0, 1, 2, 3].includes(style))
        throw new RangeError('Invalid key mode or style');
    let x = tokens.map((token, t) => Array.from({ length: dModel }, (_, i) => weights.rootEmbedding[token % 12][i] + weights.qualityEmbedding[Math.floor(token / 12)][i] + weights.inversionEmbedding[inversions[t]][i] + weights.positionEmbedding[t][i] + weights.modeEmbedding[mode][i] + weights.styleEmbedding[style][i]));
    const attentionLayers = [];
    for (const block of weights.blocks) {
        const z = x.map(row => norm(row, block.ln1, layerNormEpsilon));
        const q = z.map(row => linear(row, block.q)), k = z.map(row => linear(row, block.k)), v = z.map(row => linear(row, block.v));
        const att = Array.from({ length: heads }, () => []), mixed = x.map(() => Array(dModel).fill(0));
        for (let head = 0; head < heads; head++)
            for (let t = 0; t < x.length; t++) {
                const offset = head * dHead, scores = [];
                for (let j = 0; j <= t; j++) {
                    let dot = 0;
                    for (let i = 0; i < dHead; i++)
                        dot += q[t][offset + i] * k[j][offset + i];
                    scores.push(dot / Math.sqrt(dHead));
                }
                const row = softmax(scores);
                att[head].push([...row, ...Array(x.length - row.length).fill(0)]);
                for (let j = 0; j <= t; j++)
                    for (let i = 0; i < dHead; i++)
                        mixed[t][offset + i] += row[j] * v[j][offset + i];
            }
        attentionLayers.push(att);
        x = x.map((row, t) => { const o = linear(mixed[t], block.o); return row.map((n, i) => n + o[i]); });
        x = x.map(row => { const f = linear(linear(norm(row, block.ln2, layerNormEpsilon), block.ff1).map(gelu), block.ff2); return row.map((n, i) => n + f[i]); });
    }
    const h = norm(x.at(-1), weights.lnFinal, layerNormEpsilon);
    const inversionLogits = BASE_CHORDS.map((_, base) => linear(h.map((n, i) => Math.tanh(n + weights.rootEmbedding[base % 12][i] + weights.qualityEmbedding[Math.floor(base / 12)][i])), weights.inversionOutput));
    return { logits: linear(h, weights.output), inversionLogits, attentionLayers, attention: attentionLayers.at(-1) };
}
const forwardCache = new Map();
export async function prepareModels() {
    const a = W.architecture;
    if (a.layers !== W.blocks.length || a.dModel % a.heads || W.output.weight.length !== BASE_CHORDS.length || W.training.qualityOrder.join('|') !== QUALITIES.map(q => q.id).join('|'))
        throw new Error('Transformer weights and chord vocabulary do not agree');
    return { transformer: true };
}
export function predictNext(history, options = {}) {
    if (!Array.isArray(history))
        throw new TypeError('History must be an array');
    if (options.model && options.model !== 'transformer')
        throw new RangeError('Only Transformer is supported');
    const palette = PALETTES.find(p => p.id === (options.palette ?? 'pop'));
    if (!palette)
        throw new RangeError('Unknown harmony style');
    const temperature = options.temperature ?? palette.temperature;
    if (!Number.isFinite(temperature) || temperature <= 0)
        throw new RangeError('Temperature must be positive');
    const key = resolveKey(options.key), usable = history.length ? history : [BASE_CHORDS[(key.mode === 'minor' ? 12 : 0) + key.tonic].id];
    const chords = usable.map(id => { const c = getChord(id); if (!c)
        throw new RangeError(`Unknown chord: ${id}`); return c; }).slice(-W.architecture.contextLength);
    const tokens = chords.map(c => c.id), ids = chords.map(c => c.qualityIndex * 12 + mod12(c.root - key.tonic)), inversions = chords.map(c => c.inversion), mode = key.mode === 'minor' ? 1 : 0, style = PALETTES.indexOf(palette);
    const cacheKey = `${ids}/${inversions}/${mode}/${style}`;
    let forward = forwardCache.get(cacheKey);
    if (!forward) {
        forward = transformerForward(ids, { inversions, mode, style });
        forwardCache.set(cacheKey, forward);
        if (forwardCache.size > 24)
            forwardCache.delete(forwardCache.keys().next().value);
    }
    const last = chords.at(-1), scale = keyPitches(key);
    const invProbs = forward.inversionLogits.map((logits, i) => softmax(logits.slice(0, QUALITIES[Math.floor(i / 12)].intervals.length)));
    const feedback=options.melodyFeedback;
    if(feedback && (!Array.isArray(feedback.affinity)||feedback.affinity.length!==12||feedback.affinity.some(p=>!Number.isFinite(p)||p<0||p>1)))throw new TypeError('Invalid melody affinity');
    const interaction=feedback?Math.max(0,Math.min(1,feedback.strength??.35))*Math.min(1,(feedback.events||0)/8):0;
    const affinity=feedback?.affinity.map(p=>Math.max(-3,Math.min(3,Math.log(Math.max(.001,p)/Math.max(.001,1-p)))));
    const meanAffinity=affinity?affinity.reduce((a,b)=>a+b,0)/12:0;
    const scores = CHORD_VOCAB.map(c => {
        if (c.baseIndex === last.baseIndex)
            return -Infinity; // An inversion alone does not count as a new harmony.
        const relative = c.qualityIndex * 12 + mod12(c.root - key.tonic);
        const chromaticTones = c.pcs.filter(pc => !scale.includes(pc)).length;
        const tonalBias = -.12 * chromaticTones; // Soft decoding preference, never a vocabulary mask.
        return (forward.logits[relative] + Math.log(Math.max(1e-12, invProbs[relative][c.inversion])) + tonalBias + (affinity?interaction*1.6*(c.pcs.reduce((sum,p)=>sum+affinity[p],0)/c.pcs.length-meanAffinity):0)) / temperature;
    });
    const probs = softmax(scores);
    return { model: 'transformer', palette: palette.id, key, tokens, attentionLayers: forward.attentionLayers, attention: forward.attention,
        distribution: CHORD_VOCAB.map((c, i) => ({ id: c.id, probability: probs[i] })).sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id)),
        parameters: { ...W.architecture, parameterCount: W.training.parameterCount, temperature, key: keyLabel(key), baseChords: BASE_CHORDS.length, chordsWithInversions: CHORD_VOCAB.length, mustChangeHarmony: true, melodyInteraction: interaction, melodyFeedbackSource: feedback?.source || null, tonalDecodingBias: .12, validationPerplexity: W.training.validationMetrics.perplexity, trainingPhrases: W.training.trainingPhraseCount, validationPhrases: W.training.validationPhraseCount, provenance: W.training.corpus } };
}
export function sampleDistribution(distribution, random = Math.random) {
    if (!Array.isArray(distribution) || !distribution.length)
        throw new TypeError('Empty distribution');
    const draw = Number(random());
    if (!Number.isFinite(draw) || draw < 0 || draw > 1)
        throw new RangeError('Invalid random draw');
    let total = 0;
    for (const item of distribution) {
        if (!getChord(item.id) || !Number.isFinite(item.probability) || item.probability < 0)
            throw new TypeError('Invalid probability');
        total += item.probability;
    }
    if (!(total > 0))
        throw new RangeError('No positive probability');
    let n = Math.min(draw, 1 - Number.EPSILON) * total;
    for (const item of distribution) {
        n -= item.probability;
        if (n < 0)
            return item.id;
    }
    return distribution.findLast(x => x.probability > 0).id;
}
const voicingCache = new Map();
function candidates(c) {
    if (voicingCache.has(c.id))
        return voicingCache.get(c.id);
    const upper = c.pcs.filter(pc => pc !== c.bass).sort((a, b) => a - b), out = [];
    for (let bass = 40; bass <= 59; bass++)
        if (mod12(bass) === c.bass) {
            for (let rotation = 0; rotation < upper.length; rotation++) {
                const order = [...upper.slice(rotation), ...upper.slice(0, rotation)];
                for (const low of [Math.max(52, bass + 3), Math.max(59, bass + 7)]) {
                    let prev = low - 1;
                    const notes = [bass];
                    for (const pc of order) {
                        let n = prev + 1;
                        while (mod12(n) !== pc)
                            n++;
                        notes.push(n);
                        prev = n;
                    }
                    if (notes.at(-1) <= 88 && notes.at(-1) - bass <= 40)
                        out.push(notes);
                }
            }
        }
    voicingCache.set(c.id, out);
    return out;
}
export function voiceChord(id, previous = []) {
    const c = getChord(id);
    if (!c)
        throw new RangeError(`Unknown chord: ${id}`);
    if (!Array.isArray(previous) || previous.some(n => !Number.isFinite(n)))
        throw new TypeError('Invalid previous MIDI notes');
    let best, bestCost = Infinity;
    for (const notes of candidates(c)) {
        let motion = 0;
        if (previous.length) {
            motion = notes.reduce((sum, n) => sum + Math.min(...previous.map(p => Math.abs(n - p))), 0) + .4 * Math.abs(notes[0] - previous[0]);
        }
        const center = notes.reduce((a, b) => a + b, 0) / notes.length;
        const close = notes.slice(1).reduce((n, p, i) => n + (i && p - notes[i] < 3 ? 1 : 0), 0);
        const cost = motion + .22 * Math.abs(center - 62) + .20 * Math.abs(notes[0] - 47) + .18 * Math.max(0, notes.at(-1) - notes[0] - 24) + .8 * close;
        if (cost < bestCost) {
            bestCost = cost;
            best = notes;
        }
    }
    if (!best)
        throw new Error(`No playable voicing for ${id}`);
    return [...best];
}
