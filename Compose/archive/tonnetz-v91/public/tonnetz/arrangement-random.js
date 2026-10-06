const styles = ['pop', 'rock', 'jazz', 'classical'];
const transitions = { pop: [0, .45, .35, .20], rock: [.60, 0, .25, .15], jazz: [.45, .15, 0, .40], classical: [.45, .15, .40, 0] };
const presets = {
    pop: { rhythms: ['syncopated', 'eighth', 'quarter'], patterns: ['comping', 'updown', 'ascending'], instruments: ['piano', 'epiano', 'harp', 'synth-lead'], bass: ['electric-bass', 'synth-bass', 'piano'], lines: ['root-fifth', 'pedal', 'driving'], solo: ['pop', 'ambient'] },
    rock: { rhythms: ['eighth', 'syncopated'], patterns: ['rock-strum', 'comping', 'updown'], instruments: ['electric-guitar', 'organ', 'epiano'], bass: ['electric-bass', 'synth-bass'], lines: ['driving', 'root-fifth'], solo: ['blues', 'pop'] },
    jazz: { rhythms: ['swing', 'syncopated', 'quarter'], patterns: ['comping', 'bass-chord', 'descending'], instruments: ['epiano', 'piano', 'organ'], bass: ['electric-bass', 'piano'], lines: ['walking', 'root-fifth'], solo: ['jazz', 'blues'] },
    classical: { rhythms: ['eighth', 'waltz', 'quarter'], patterns: ['alberti', 'ascending', 'updown', 'block'], instruments: ['piano', 'harp', 'strings'], bass: ['piano', 'synth-bass'], lines: ['root-fifth', 'pedal'], solo: ['classical', 'ambient'] }
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function arrangementTransition(style, every = 8, wild = false) {
    if (!styles.includes(style))
        style = 'pop';
    const row = transitions[style] || transitions.pop, p = 1 / clamp(Number(every) || 8, 1, 32);
    return styles.map((id, i) => ({ id, probability: id === style ? 1 - p : p * (wild ? 1 / 3 : row[i]) }));
}
export function createRandomArranger({ random = Math.random } = {}) {
    let enabled = false, every = 8, wild = false, tempo = false, baseBpm = 92, style = 'pop', changes = 0;
    const draw = () => clamp(Number(random()) || 0, 0, 1 - Number.EPSILON);
    const pick = values => values[Math.floor(draw() * values.length)];
    function configure(options = {}) {
        if ('enabled' in options)
            enabled = !!options.enabled;
        if ('every' in options)
            every = clamp(Math.round(Number(options.every) || 8), 1, 32);
        if ('wild' in options)
            wild = !!options.wild;
        if ('tempo' in options)
            tempo = !!options.tempo;
        if ('bpm' in options)
            baseBpm = clamp(Number(options.bpm) || 92, 40, 200);
        if (styles.includes(options.style))
            style = options.style;
    }
    function next(force = false) {
        if (!enabled && !force)
            return null;
        let chosen = style;
        if (force)
            chosen = pick(styles.filter(s => s !== style));
        else {
            let p = draw();
            for (const entry of arrangementTransition(style, every, wild)) {
                p -= entry.probability;
                if (p < 0) {
                    chosen = entry.id;
                    break;
                }
            }
        }
        if (chosen === style)
            return null;
        style = chosen;
        changes++;
        const recipe = presets[style], pool = wild ? Object.values(presets) : [recipe];
        const choose = field => pick([...new Set(pool.flatMap(p => p[field]))]);
        const accompaniment = { style, rhythm: choose('rhythms'), pattern: choose('patterns'), instrument: choose('instruments'), bassInstrument: choose('bass'), bassLine: choose('lines'), feel: .35 + draw() * .55, variation: .35 + draw() * .6 };
        if (tempo)
            accompaniment.bpm = clamp(Math.round(baseBpm * (.88 + draw() * .24)), 40, 200);
        return { accompaniment, solo: { style: choose('solo'), instrument: pick(style === 'jazz' ? ['epiano', 'reed-lead', 'piano'] : style === 'rock' ? ['electric-guitar', 'synth-lead', 'organ'] : ['piano', 'bell', 'harp', 'synth-lead']), rhythm: 'auto', pattern: pick(['motif', 'arc', 'answer', 'arpeggio']), density: .3 + draw() * .5 }, changes };
    }
    return Object.freeze({ configure, tick: () => next(false), shuffle: () => next(true), getState: () => ({ enabled, every, wild, tempo, style, changes }) });
}
