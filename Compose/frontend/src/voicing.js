import { QUALITIES, CHORD_VOCAB, mod12 } from '../vendor/lib/chord-vocabulary.js';

/** Chord tones for the accompaniment voicing (at most four; the fifth goes first). */
export function voicingPitchClasses(root, q) {
    let intervals = [...QUALITIES[q].intervals];
    if (intervals.length > 4) intervals = intervals.filter(i => i !== 7);
    if (intervals.length > 4) intervals = intervals.slice(0, 4);
    return intervals.map(i => mod12(root + i));
}

/** Voicing between E3 and F5 with the least motion from the previous one, avoiding
 * clusters of seconds. The joint model's bass stream carries the bass, so the voicing
 * has no bass note of its own. */
export function voiceChord(root, q, previous = [], { low = 52, high = 77, center = 64 } = {}) {
    const pcs = voicingPitchClasses(root, q);
    const options = pcs.map(pc => { const out = []; for (let n = low + mod12(pc - low); n <= high; n += 12) out.push(n); return out; });
    let best = null, bestCost = Infinity;
    const pick = (i, chosen) => {
        if (i === options.length) {
            const notes = [...chosen].sort((a, b) => a - b);
            let clusters = 0;
            for (let k = 1; k < notes.length; k++) { const gap = notes[k] - notes[k - 1]; clusters += gap === 1 ? 3 : gap === 2 ? 1 : 0; }
            const span = notes.at(-1) - notes[0], mean = notes.reduce((a, b) => a + b, 0) / notes.length;
            const motion = previous.length ? notes.reduce((sum, n) => sum + Math.min(...previous.map(p => Math.abs(n - p))), 0) / notes.length : 0;
            const cost = motion + 0.35 * Math.abs(mean - center) + clusters + 0.2 * Math.max(0, span - 12);
            if (cost < bestCost) { bestCost = cost; best = notes; }
            return;
        }
        for (const n of options[i]) pick(i + 1, [...chosen, n]);
    };
    pick(0, []);
    return best;
}

/** Vocabulary entry for a chord and the bass under it (slash chord when the bass is another chord tone). */
export function chordEntry(root, q, bassPc = null) {
    const candidates = CHORD_VOCAB.filter(c => c.root === root && c.qualityIndex === q);
    return candidates.find(c => bassPc !== null && c.bass === bassPc) || candidates.find(c => c.inversion === 0);
}

const LETTERS = 'CDEFGAB', NATURAL = [0, 2, 4, 5, 7, 9, 11];
const TONIC_NAMES = { major: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'], minor: ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'] };
const DEGREE = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];   // scale step of each semitone above the tonic
const accidental = n => n > 0 ? '♯'.repeat(n) : '♭'.repeat(-n);
function spell(pc, letterIndex) {
    const acc = ((pc - NATURAL[letterIndex]) % 12 + 18) % 12 - 6;
    return Math.abs(acc) > 2 ? null : LETTERS[letterIndex] + accidental(acc);
}
/** Root name by its scale degree in the local key (C♯ in D major, D♭ in A♭ major). */
export function spellRoot(pc, key = { tonic: 0, mode: 'major' }) {
    const tonicName = TONIC_NAMES[key.mode === 'minor' ? 'minor' : 'major'][key.tonic];
    const letter = (LETTERS.indexOf(tonicName[0]) + DEGREE[mod12(pc - key.tonic)]) % 7;
    const name = spell(pc, letter);
    return name && !/[♯♭]{2}/.test(name) ? name : TONIC_NAMES.major[pc];
}
/** Chord label spelled in the local key; the slash bass is spelled as a chord tone. */
export function chordLabel(root, q, bassPc = null, key = { tonic: 0, mode: 'major' }) {
    const quality = QUALITIES[q], rootName = spellRoot(root, key);
    let label = rootName + quality.suffix;
    if (bassPc !== null && bassPc !== root) {
        const interval = mod12(bassPc - root);
        if (quality.intervals.includes(interval)) {
            // Same chord-tone letters as chord-vocabulary.js (a diminished fifth is a fifth, a sharp 11 a fourth).
            let step = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6][interval];
            if (interval === 3 && quality.id === 'dom7s9') step = 1;
            if (interval === 6 && /s11/.test(quality.id)) step = 3;
            if (interval === 8 && ['aug', 'dom7s5'].includes(quality.id)) step = 4;
            if (interval === 9 && quality.id === 'dim7') step = 6;
            label += '/' + (spell(bassPc, (LETTERS.indexOf(rootName[0]) + step) % 7) || TONIC_NAMES.major[bassPc]);
        }
    }
    return label;
}
