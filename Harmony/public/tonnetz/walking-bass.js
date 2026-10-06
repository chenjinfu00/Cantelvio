import { keyPitches } from './lib/tonality.js';
const pc = n => ((n % 12) + 12) % 12;
const register = Array.from({ length: 20 }, (_, i) => 36 + i);
export const bassLanding = midi => register.filter(n => pc(n) === pc(midi)).sort((a, b) => Math.abs(a - 40) - Math.abs(b - 40) || a - b)[0];
// Search whole phrases, including the next bar's actual landing, rather than choosing greedily.
export function walkingBass(chord, nextChord, { beats = 4, key = { tonic: 0, mode: 'major' }, bar = 0 } = {}) {
    if (!chord.length)
        return [];
    const first = bassLanding(chord[0]), target = bassLanding(nextChord[0] ?? chord[0]);
    const tones = new Set(chord.map(pc)), scale = new Set([...keyPitches(key), ...tones]);
    const approach = [target - 1, target + 1].filter(n => n >= 36 && n <= 55);
    const pools = Array.from({ length: beats }, (_, beat) => beat === 0 ? [first] : beat === beats - 1 ? approach :
        register.filter(n => (beat % 2 === 0 || beats === 3 ? tones : scale).has(pc(n))));
    let paths = [{ notes: [first], score: 0 }];
    for (let beat = 1; beat < beats; beat++) {
        const next = [];
        for (const path of paths)
            for (const note of pools[beat]) {
                const previous = path.notes.at(-1), step = note - previous, distance = Math.abs(step);
                const before = path.notes.length > 1 ? previous - path.notes.at(-2) : 0;
                const desired = (bar % 4 < 2 ? 1 : -1);
                let score = path.score + distance * .24 + Math.max(0, distance - 4) ** 2 * .7 + (distance === 0 ? 2.8 : 0);
                if (before && step && Math.sign(before) !== Math.sign(step))
                    score += .48;
                if (path.notes.includes(note))
                    score += .35;
                if (!tones.has(pc(note)))
                    score += beat === beats - 1 ? 0 : .28;
                score += Math.abs(note - 43) * .025 + (Math.sign(step) !== desired ? .14 : 0);
                if (beat === beats - 1)
                    score += Math.abs(target - note) * .4 + Math.max(0, Math.abs(note - previous) - 3) * .25;
                next.push({ notes: [...path.notes, note], score });
            }
        // Keep alternatives by endpoint and last direction so a globally smoother route can win.
        const best = new Map();
        for (const path of next.sort((a, b) => a.score - b.score)) {
            const end = path.notes.at(-1), direction = Math.sign(end - path.notes.at(-2));
            const id = `${end}:${direction}`;
            if (!best.has(id))
                best.set(id, path);
        }
        paths = [...best.values()];
    }
    const best = paths.sort((a, b) => a.score - b.score)[0];
    return best.notes.map((midi, beat) => ({ beat, midi, length: beat === beats - 1 ? .88 : .94, accent: beat === 0 ? .96 : beat % 2 ? .79 : .88 }));
}
