// AIlegro joint R/H/B/M Transformer: browser/Node inference for the StructuredJoint
// checkpoint exported by training/scripts/export_joint_js.py.
//
// Token streams, one token per sixteenth-note step each, generated per step in the
// fixed order R (accompaniment rhythm) -> H (harmony) -> B (bass) -> M (melody).
// Positions are interleaved time-major (R0 H0 B0 M0 R1 ...); position (t, s) holds
// token s at step t and predicts token s at step t+1. Its input may only use tokens
// that precede (s, t+1) in the generation order, so the decoder computes every
// position exactly once and caches its keys and values.
//
// This file reproduces training/scripts/joint_model.py (StructuredJoint.forward);
// tests/joint-model.test.js checks it against PyTorch logits.
import { JOINT_META, JOINT_MANIFEST, JOINT_WEIGHTS_BASE64 } from './joint-continued-weights.js';

export { JOINT_META };
export const STREAMS = Object.freeze(['R', 'H', 'B', 'M']);
export const PAD = 0, UNK = 1;
export const R_REST = 2, R_HOLD = 3, R_ONE = 4, R_MULTI = 5;
export const H_HOLD = 2, H_CHORD0 = 3;
export const REST = 2, HOLD = 3, ONSET0 = 4;
export const VOCAB = Object.freeze({ ...JOINT_META.vocab });
export const PITCHES = Object.freeze({ ...JOINT_META.pitches });
export const CONTEXT_STEPS = JOINT_META.contextSteps;
export const N_SINCE = JOINT_META.controls.since;
export const N_QUALITIES = JOINT_META.controls.qualities;
export const LKEY_UNKNOWN = JOINT_META.controls.lkey - 1;
export const STYLE_IDS = Object.freeze({ ...JOINT_META.styleIds });
/** Metre id -> sixteenth steps per beat, as in training (joint_data.BEAT_OF_METER). */
export const BEAT_OF_METER = Object.freeze(Object.fromEntries(Object.entries(JOINT_META.beatOfMeter).map(([k, v]) => [Number(k), v])));

const TWO_PI = 2 * Math.PI;
const TIME_FREQ = [4, 16, 64, 256].map(p => TWO_PI / p);

/** Rotary angles of one step: four time frequencies, two beat-phase and two bar-phase harmonics. */
export function metricalAngles(step, pos, barlen, beatphase, beatlen, out = new Float64Array(8)) {
    for (let i = 0; i < 4; i++) out[i] = step * TIME_FREQ[i];
    const beat = TWO_PI * (beatphase / beatlen), bar = TWO_PI * (pos / barlen);
    out[4] = beat; out[5] = 2 * beat; out[6] = bar; out[7] = 2 * bar;
    return out;
}

/** Metrical level of a step in the bar (0 downbeat, 1 beat, 2 eighth, 3 sixteenth). */
export function metricalLevel(pos, beatlen) {
    if (pos === 0) return 0;
    if (pos % beatlen === 0) return 1;
    return pos % 2 === 0 ? 2 : 3;
}

function decodeBase64(text) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text);
    const binary = atob(text), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

let cachedModel = null;
/** Decode the exported float32 tensors once; later calls return the same model. */
export function loadJointModel() {
    if (cachedModel) return cachedModel;
    cachedModel = decodeJointModel(JOINT_META, JOINT_MANIFEST, JOINT_WEIGHTS_BASE64);
    return cachedModel;
}

/** Decode a checkpoint with the production model's token/control contract. */
export function decodeJointModel(meta, manifest, encoded) {
    if (JSON.stringify(meta.config) !== JSON.stringify(JOINT_META.config) ||
        JSON.stringify(meta.vocab) !== JSON.stringify(JOINT_META.vocab) ||
        JSON.stringify(meta.controls) !== JSON.stringify(JOINT_META.controls) ||
        meta.contextSteps !== JOINT_META.contextSteps || meta.float32Count !== JOINT_META.float32Count)
        throw new Error('Candidate joint model has an incompatible decoder contract');
    const bytes = decodeBase64(encoded);
    if (bytes.length !== meta.float32Count * 4) throw new Error('Joint weights have an unexpected size');
    const all = new Float32Array(bytes.buffer, bytes.byteOffset, meta.float32Count);
    const tensors = new Map();
    for (const [name, offset, shape] of manifest) {
        const size = shape.reduce((a, b) => a * b, 1);
        tensors.set(name, { data: all.subarray(offset, offset + size), shape });
    }
    const get = name => {
        const t = tensors.get(name);
        if (!t) throw new Error(`Missing joint weight ${name}`);
        return t.data;
    };
    const { d, heads, layers, ff } = meta.config;
    const S = STREAMS.length;
    const linear = (prefix, rows, cols) => ({ w: get(`${prefix}.weight`), b: get(`${prefix}.bias`), rows, cols });
    const norm = prefix => ({ w: get(`${prefix}.weight`), b: get(`${prefix}.bias`) });
    return Object.freeze({
        d, heads, dh: d / heads, layerCount: layers, ff,
        tok: STREAMS.map((_, s) => get(`tok.${s}.weight`)),
        front: STREAMS.map((_, s) => get(`front.${s}.weight`)),
        stream: get('stream'),
        ctrl: {
            domain: get('controls.domain.weight'), style: get('controls.style.weight'), refmode: get('controls.refmode.weight'),
            meter: get('controls.meter.weight'), lkey: get('controls.lkey.weight'), pos: get('controls.pos.weight'),
            level: get('controls.level.weight'), phrase: get('controls.phrase.weight')
        },
        chordRoot: get('chord_root.weight'), chordQ: get('chord_q.weight'), since: get('since.weight'), change: get('change.weight'),
        layers: Array.from({ length: layers }, (_, l) => STREAMS.map((_, s) => ({
            ln1: norm(`layers.${l}.ln1.${s}`), ln2: norm(`layers.${l}.ln2.${s}`),
            q: linear(`layers.${l}.q.${s}`, d, d), k: linear(`layers.${l}.k.${s}`, d, d), v: linear(`layers.${l}.v.${s}`, d, d),
            o: linear(`layers.${l}.o.${s}`, d, d), ff1: linear(`layers.${l}.ff1.${s}`, ff, d), ff2: linear(`layers.${l}.ff2.${s}`, d, ff)
        }))),
        lnF: STREAMS.map((_, s) => norm(`ln_f.${s}`)),
        head: STREAMS.map((name, s) => linear(`head.${s}`, VOCAB[name], d)),
        rel: { B: linear('rel_head.B', 12, d), M: linear('rel_head.M', 12, d) },
        S
    });
}

function matvec(layer, x, out) {
    // Two rows per pass and four partial sums per row: about twice the speed of a
    // naive loop in V8 (cols is a multiple of 4 for every layer of this model).
    const { w, b, rows, cols } = layer;
    let j = 0;
    for (; j + 1 < rows; j += 2) {
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0, c0 = 0, c1 = 0, c2 = 0, c3 = 0;
        const p = j * cols, q = p + cols;
        for (let i = 0; i < cols; i += 4) {
            const x0 = x[i], x1 = x[i + 1], x2 = x[i + 2], x3 = x[i + 3];
            a0 += w[p + i] * x0; a1 += w[p + i + 1] * x1; a2 += w[p + i + 2] * x2; a3 += w[p + i + 3] * x3;
            c0 += w[q + i] * x0; c1 += w[q + i + 1] * x1; c2 += w[q + i + 2] * x2; c3 += w[q + i + 3] * x3;
        }
        out[j] = b[j] + ((a0 + a1) + (a2 + a3));
        out[j + 1] = b[j + 1] + ((c0 + c1) + (c2 + c3));
    }
    if (j < rows) {
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
        const p = j * cols;
        for (let i = 0; i < cols; i += 4) { a0 += w[p + i] * x[i]; a1 += w[p + i + 1] * x[i + 1]; a2 += w[p + i + 2] * x[i + 2]; a3 += w[p + i + 3] * x[i + 3]; }
        out[j] = b[j] + ((a0 + a1) + (a2 + a3));
    }
    return out;
}

function layerNorm(x, { w, b }, out) {
    const n = x.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) { const c = x[i] - mean; variance += c * c; }
    const scale = 1 / Math.sqrt(variance / n + 1e-5);
    for (let i = 0; i < n; i++) out[i] = (x[i] - mean) * scale * w[i] + b[i];
    return out;
}

const GELU_C = Math.sqrt(2 / Math.PI);
const addRow = (x, table, row, d) => {
    const base = row * d;
    if (!(row >= 0) || base + d > table.length) throw new RangeError(`Joint model input index ${row} is out of range`);
    for (let i = 0; i < d; i++) x[i] += table[base + i];
};

/**
 * Incremental decoder over one context window. Feed positions strictly in the
 * interleaved order; `position()` appends one position to the key/value cache and
 * optionally returns the logits that predict the stream's next-step token.
 */
export class JointDecoder {
    constructor(model = loadJointModel(), maxPositions = (CONTEXT_STEPS - 1) * STREAMS.length) {
        const { d, ff, layerCount } = model;
        this.model = model; this.maxPositions = maxPositions; this.length = 0;
        this.keys = Array.from({ length: layerCount }, () => new Float32Array(maxPositions * d));
        this.values = Array.from({ length: layerCount }, () => new Float32Array(maxPositions * d));
        this.x = new Float64Array(d); this.z = new Float64Array(d); this.q = new Float64Array(d); this.k = new Float64Array(d);
        this.v = new Float64Array(d); this.a = new Float64Array(d); this.o = new Float64Array(d); this.h = new Float64Array(ff);
        this.scores = new Float64Array(maxPositions * model.heads);
        this.cosQ = new Float64Array(8); this.sinQ = new Float64Array(8); this.cosK = new Float64Array(8); this.sinK = new Float64Array(8);
        this.logits = Object.fromEntries(STREAMS.map(name => [name, new Float32Array(VOCAB[name])]));
        this.rel = new Float64Array(12);
        this.lastFeature = new Float32Array(d);
    }
    reset() { this.length = 0; }
    truncate(length) { this.length = Math.max(0, Math.min(this.length, length)); }

    /**
     * input: { s, token, front: [4 tokens; own stream ignored], global: {domain, style, refmode},
     *          next: {meter, lkey, pos, level, phrase} (controls of step t+1),
     *          chord: {chord, since, change} (step t for R/H, step t+1 for B/M),
     *          angQ, angK (8 angles each), nextRoot (chord root at t+1, B/M only) }
     */
    position(input, wantLogits = true) {
        const m = this.model, { d, dh, heads } = m, s = input.s, name = STREAMS[s];
        if (this.length >= this.maxPositions) throw new Error('Joint context window is full');
        const x = this.x;
        x.fill(0);
        addRow(x, m.tok[s], input.token, d);
        addRow(x, m.stream, s, d);
        const g = input.global, n = input.next;
        addRow(x, m.ctrl.domain, g.domain, d); addRow(x, m.ctrl.style, g.style, d); addRow(x, m.ctrl.refmode, g.refmode, d);
        addRow(x, m.ctrl.meter, n.meter, d); addRow(x, m.ctrl.lkey, n.lkey, d); addRow(x, m.ctrl.pos, n.pos, d);
        addRow(x, m.ctrl.level, n.level, d); addRow(x, m.ctrl.phrase, n.phrase, d);
        const c = input.chord;
        addRow(x, m.chordRoot, c.chord % 12, d); addRow(x, m.chordQ, Math.floor(c.chord / 12), d); addRow(x, m.since, c.since, d);
        if (s >= 2) addRow(x, m.change, c.change ? 1 : 0, d);
        for (let u = 0; u < STREAMS.length; u++) if (u !== s) addRow(x, m.front[u], input.front[u], d);
        if(input.extraStep)for(let i=0;i<d;i++)x[i]+=input.extraStep[i];
        for (let i = 0; i < 8; i++) {
            this.cosQ[i] = Math.cos(input.angQ[i]); this.sinQ[i] = Math.sin(input.angQ[i]);
            this.cosK[i] = Math.cos(input.angK[i]); this.sinK[i] = Math.sin(input.angK[i]);
        }
        const p = this.length, count = p + 1, scale = 1 / Math.sqrt(dh), pairs = Math.min(8, dh / 2);
        for (let l = 0; l < m.layerCount; l++) {
            const L = m.layers[l][s], K = this.keys[l], V = this.values[l];
            layerNorm(x, L.ln1, this.z);
            matvec(L.q, this.z, this.q); matvec(L.k, this.z, this.k); matvec(L.v, this.z, this.v);
            for (let h = 0; h < heads; h++) {
                const base = h * dh;
                for (let i = 0; i < pairs; i++) {
                    const a = base + 2 * i, b = a + 1;
                    const q1 = this.q[a], q2 = this.q[b], k1 = this.k[a], k2 = this.k[b];
                    this.q[a] = q1 * this.cosQ[i] - q2 * this.sinQ[i]; this.q[b] = q1 * this.sinQ[i] + q2 * this.cosQ[i];
                    this.k[a] = k1 * this.cosK[i] - k2 * this.sinK[i]; this.k[b] = k1 * this.sinK[i] + k2 * this.cosK[i];
                }
            }
            const row = p * d, qv = this.q, kv = this.k, vv = this.v, scores = this.scores;
            for (let i = 0; i < d; i++) { K[row + i] = kv[i]; V[row + i] = vv[i]; }
            const a = this.a;
            a.fill(0);
            // One pass over the cache for all heads (contiguous rows), then softmax per head.
            if (dh === 16) {
                // Specialised for the exported model (6 heads x 16): fully unrolled head dots.
                for (let h = 0; h < heads; h++) {
                    const base = h * 16, off = h * count;
                    const q0 = qv[base], q1 = qv[base + 1], q2 = qv[base + 2], q3 = qv[base + 3], q4 = qv[base + 4], q5 = qv[base + 5], q6 = qv[base + 6], q7 = qv[base + 7];
                    const q8 = qv[base + 8], q9 = qv[base + 9], q10 = qv[base + 10], q11 = qv[base + 11], q12 = qv[base + 12], q13 = qv[base + 13], q14 = qv[base + 14], q15 = qv[base + 15];
                    let max = -Infinity;
                    for (let j = 0, k = base; j < count; j++, k += d) {
                        const dot = ((q0 * K[k] + q1 * K[k + 1]) + (q2 * K[k + 2] + q3 * K[k + 3]) + (q4 * K[k + 4] + q5 * K[k + 5]) + (q6 * K[k + 6] + q7 * K[k + 7])
                            + (q8 * K[k + 8] + q9 * K[k + 9]) + (q10 * K[k + 10] + q11 * K[k + 11]) + (q12 * K[k + 12] + q13 * K[k + 13]) + (q14 * K[k + 14] + q15 * K[k + 15])) * scale;
                        scores[off + j] = dot;
                        if (dot > max) max = dot;
                    }
                    let sum = 0;
                    for (let j = 0; j < count; j++) { const e = Math.exp(scores[off + j] - max); scores[off + j] = e; sum += e; }
                    const inv = 1 / sum;
                    let a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0, a7 = 0, a8 = 0, a9 = 0, a10 = 0, a11 = 0, a12 = 0, a13 = 0, a14 = 0, a15 = 0;
                    for (let j = 0, k = base; j < count; j++, k += d) {
                        const w = scores[off + j];
                        a0 += w * V[k]; a1 += w * V[k + 1]; a2 += w * V[k + 2]; a3 += w * V[k + 3]; a4 += w * V[k + 4]; a5 += w * V[k + 5]; a6 += w * V[k + 6]; a7 += w * V[k + 7];
                        a8 += w * V[k + 8]; a9 += w * V[k + 9]; a10 += w * V[k + 10]; a11 += w * V[k + 11]; a12 += w * V[k + 12]; a13 += w * V[k + 13]; a14 += w * V[k + 14]; a15 += w * V[k + 15];
                    }
                    a[base] = a0 * inv; a[base + 1] = a1 * inv; a[base + 2] = a2 * inv; a[base + 3] = a3 * inv; a[base + 4] = a4 * inv; a[base + 5] = a5 * inv; a[base + 6] = a6 * inv; a[base + 7] = a7 * inv;
                    a[base + 8] = a8 * inv; a[base + 9] = a9 * inv; a[base + 10] = a10 * inv; a[base + 11] = a11 * inv; a[base + 12] = a12 * inv; a[base + 13] = a13 * inv; a[base + 14] = a14 * inv; a[base + 15] = a15 * inv;
                }
            } else {
                for (let j = 0; j < count; j++) {
                    const kr = j * d;
                    for (let h = 0; h < heads; h++) {
                        const base = h * dh, kb = kr + base;
                        let dot = 0;
                        for (let i = 0; i < dh; i++) dot += qv[base + i] * K[kb + i];
                        scores[h * count + j] = dot * scale;
                    }
                }
                for (let h = 0; h < heads; h++) {
                    const off = h * count;
                    let max = -Infinity;
                    for (let j = 0; j < count; j++) if (scores[off + j] > max) max = scores[off + j];
                    let sum = 0;
                    for (let j = 0; j < count; j++) { const e = Math.exp(scores[off + j] - max); scores[off + j] = e; sum += e; }
                    const inv = 1 / sum;
                    for (let j = 0; j < count; j++) scores[off + j] *= inv;
                }
                for (let j = 0; j < count; j++) {
                    const vr = j * d;
                    for (let h = 0; h < heads; h++) {
                        const w = scores[h * count + j], base = h * dh, vb = vr + base;
                        for (let i = 0; i < dh; i++) a[base + i] += w * V[vb + i];
                    }
                }
            }
            matvec(L.o, a, this.o);
            for (let i = 0; i < d; i++) x[i] += this.o[i];
            layerNorm(x, L.ln2, this.z);
            matvec(L.ff1, this.z, this.h);
            for (let i = 0; i < this.h.length; i++) { const u = this.h[i]; this.h[i] = 0.5 * u * (1 + Math.tanh(GELU_C * (u + 0.044715 * u * u * u))); }
            matvec(L.ff2, this.h, this.o);
            for (let i = 0; i < d; i++) x[i] += this.o[i];
        }
        this.length = count;
        this.lastFeature.set(x);
        if (!wantLogits) return null;
        layerNorm(x, m.lnF[s], this.z);
        const logits = this.logits[name];
        matvec(m.head[s], this.z, logits);
        if (name === 'B' || name === 'M') {
            matvec(m.rel[name], this.z, this.rel);
            const root = input.nextRoot;
            for (let pitch = 0; pitch < PITCHES[name]; pitch++) logits[ONSET0 + pitch] += this.rel[(((pitch - root) % 12) + 12) % 12];
        }
        return logits;
    }
}
