// Quality order is the training-token contract: qualityIndex * 12 + relative root.
export const ROOT_NAMES = Object.freeze(["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]);
export const mod12 = value => ((value % 12) + 12) % 12;
export const QUALITIES = Object.freeze([{ "id": "maj", "suffix": "", "intervals": [0, 4, 7], "group": "triad" }, { "id": "min", "suffix": "m", "intervals": [0, 3, 7], "group": "triad" }, { "id": "dim", "suffix": "dim", "intervals": [0, 3, 6], "group": "triad" }, { "id": "aug", "suffix": "aug", "intervals": [0, 4, 8], "group": "triad" }, { "id": "sus2", "suffix": "sus2", "intervals": [0, 2, 7], "group": "triad" }, { "id": "sus4", "suffix": "sus4", "intervals": [0, 5, 7], "group": "triad" }, { "id": "power", "suffix": "5", "intervals": [0, 7], "group": "triad" }, { "id": "six", "suffix": "6", "intervals": [0, 4, 7, 9], "group": "sixth" }, { "id": "min6", "suffix": "m6", "intervals": [0, 3, 7, 9], "group": "sixth" }, { "id": "six9", "suffix": "6/9", "intervals": [0, 4, 7, 9, 2], "group": "sixth" }, { "id": "dom7", "suffix": "7", "intervals": [0, 4, 7, 10], "group": "seventh" }, { "id": "maj7", "suffix": "maj7", "intervals": [0, 4, 7, 11], "group": "seventh" }, { "id": "min7", "suffix": "m7", "intervals": [0, 3, 7, 10], "group": "seventh" }, { "id": "minmaj7", "suffix": "mMaj7", "intervals": [0, 3, 7, 11], "group": "seventh" }, { "id": "dim7", "suffix": "dim7", "intervals": [0, 3, 6, 9], "group": "seventh" }, { "id": "half", "suffix": "ø7", "intervals": [0, 3, 6, 10], "group": "seventh" }, { "id": "sus7", "suffix": "7sus4", "intervals": [0, 5, 7, 10], "group": "seventh" }, { "id": "sus27", "suffix": "7sus2", "intervals": [0, 2, 7, 10], "group": "seventh" }, { "id": "add9", "suffix": "add9", "intervals": [0, 4, 7, 2], "group": "extension" }, { "id": "minadd9", "suffix": "madd9", "intervals": [0, 3, 7, 2], "group": "extension" }, { "id": "add11", "suffix": "add11", "intervals": [0, 4, 7, 5], "group": "extension" }, { "id": "dom9", "suffix": "9", "intervals": [0, 4, 7, 10, 2], "group": "extension" }, { "id": "maj9", "suffix": "maj9", "intervals": [0, 4, 7, 11, 2], "group": "extension" }, { "id": "min9", "suffix": "m9", "intervals": [0, 3, 7, 10, 2], "group": "extension" }, { "id": "dom11", "suffix": "11", "intervals": [0, 4, 7, 10, 2, 5], "group": "extension" }, { "id": "min11", "suffix": "m11", "intervals": [0, 3, 7, 10, 2, 5], "group": "extension" }, { "id": "dom13", "suffix": "13", "intervals": [0, 4, 7, 10, 2, 5, 9], "group": "extension" }, { "id": "maj13", "suffix": "maj13", "intervals": [0, 4, 7, 11, 2, 5, 9], "group": "extension" }, { "id": "min13", "suffix": "m13", "intervals": [0, 3, 7, 10, 2, 5, 9], "group": "extension" }, { "id": "dom7b5", "suffix": "7♭5", "intervals": [0, 4, 6, 10], "group": "altered" }, { "id": "dom7s5", "suffix": "7♯5", "intervals": [0, 4, 8, 10], "group": "altered" }, { "id": "dom7b9", "suffix": "7♭9", "intervals": [0, 4, 7, 10, 1], "group": "altered" }, { "id": "dom7s9", "suffix": "7♯9", "intervals": [0, 4, 7, 10, 3], "group": "altered" }, { "id": "dom7s11", "suffix": "7♯11", "intervals": [0, 4, 7, 10, 6], "group": "altered" }, { "id": "dom7b13", "suffix": "7♭13", "intervals": [0, 4, 7, 10, 8], "group": "altered" }, { "id": "dom9s11", "suffix": "9♯11", "intervals": [0, 4, 7, 10, 2, 6], "group": "altered" }, { "id": "dom13b9", "suffix": "13♭9", "intervals": [0, 4, 7, 10, 1, 9], "group": "altered" }, { "id": "maj7s11", "suffix": "maj7♯11", "intervals": [0, 4, 7, 11, 6], "group": "altered" }, { "id": "maj9s11", "suffix": "maj9♯11", "intervals": [0, 4, 7, 11, 2, 6], "group": "altered" }, { "id": "minmaj9", "suffix": "mMaj9", "intervals": [0, 3, 7, 11, 2], "group": "extension" }].map(q => Object.freeze({ ...q, intervals: Object.freeze(q.intervals) })));
// Spell chord tones by their diatonic role (A major has C♯, not D♭).
function spellTone(root, quality, interval) {
    const letters = ["C", "D", "E", "F", "G", "A", "B"], naturals = [0, 2, 4, 5, 7, 9, 11];
    let step = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6][interval];
    if (interval === 3 && quality.id === "dom7s9")
        step = 1;
    if (interval === 6 && /s11/.test(quality.id))
        step = 3;
    if (interval === 8 && ["aug", "dom7s5"].includes(quality.id))
        step = 4;
    if (interval === 9 && quality.id === "dim7")
        step = 6;
    const letter = (letters.indexOf(ROOT_NAMES[root][0]) + step) % 7;
    let alteration = mod12(root + interval - naturals[letter]);
    if (alteration > 6)
        alteration -= 12;
    return letters[letter] + (alteration > 0 ? "♯".repeat(alteration) : "♭".repeat(-alteration));
}
export const BASE_CHORDS = Object.freeze(QUALITIES.flatMap((quality, qualityIndex) => ROOT_NAMES.map((name, root) => Object.freeze({
    id: name + quality.suffix, label: name + quality.suffix, root, quality: quality.id, qualityIndex,
    baseIndex: qualityIndex * 12 + root, family: quality.group, noteNames: Object.freeze(quality.intervals.map(pc => spellTone(root, quality, pc))), pcs: Object.freeze(quality.intervals.map(pc => mod12(pc + root)))
}))));
export const CHORD_VOCAB = Object.freeze(BASE_CHORDS.flatMap(base => base.pcs.map((bass, inversion) => Object.freeze({
    ...base, id: inversion ? `${base.id}/${ROOT_NAMES[bass]}` : base.id,
    label: inversion ? `${base.id}/${base.noteNames[inversion]}` : base.id, bass, inversion
}))));
export const CHORD_BY_ID = new Map(CHORD_VOCAB.map(c => [c.id, c]));
const CHORD_BY_LABEL = new Map(CHORD_VOCAB.map(c => [c.label, c]));
export function getChord(id) {
    if (typeof id !== "string")
        return undefined;
    if (CHORD_BY_LABEL.has(id))
        return CHORD_BY_LABEL.get(id);
    if (CHORD_BY_ID.has(id))
        return CHORD_BY_ID.get(id);
    const aliases = { "C♯": "D♭", "D♯": "E♭", "G♭": "F♯", "G♯": "A♭", "A♯": "B♭", "Db": "D♭", "Eb": "E♭", "Gb": "F♯", "Ab": "A♭", "Bb": "B♭", "C#": "D♭", "F#": "F♯" };
    for (const [from, to] of Object.entries(aliases))
        if (id.startsWith(from))
            return CHORD_BY_ID.get(to + id.slice(from.length));
    return undefined;
}
export function transposeChord(id, semitones) {
    const c = getChord(id);
    if (!c)
        throw new RangeError(`Unknown chord: ${id}`);
    const base = BASE_CHORDS[c.qualityIndex * 12 + mod12(c.root + semitones)];
    return c.inversion ? `${base.id}/${ROOT_NAMES[base.pcs[c.inversion]]}` : base.id;
}
export function romanFor(id, key = { tonic: 0, mode: "major" }) {
    const c = getChord(id);
    if (!c)
        return "";
    const degree = mod12(c.root - key.tonic);
    const degrees = key.mode === "minor" ? ["I", "♭II", "II", "III", "♯III", "IV", "♯IV", "V", "VI", "♯VI", "VII", "♯VII"] : ["I", "♭II", "II", "♭III", "III", "IV", "♯IV", "V", "♭VI", "VI", "♭VII", "VII"];
    let roman = degrees[degree];
    if (/^(min|dim|half)/.test(c.quality))
        roman = roman.toLowerCase();
    const q = QUALITIES[c.qualityIndex];
    const suffix = q.id === "maj" || q.id === "min" ? "" : q.suffix.replace(/^m(?!aj)/, "").replace("dim", "°");
    if (!c.inversion)
        return roman + suffix;
    if (["maj", "min", "dim", "aug"].includes(q.id))
        return roman + suffix + ["", "6", "64"][c.inversion];
    if (["dom7", "maj7", "min7", "minmaj7", "dim7", "half", "dom7b5", "dom7s5"].includes(q.id)) {
        return roman + suffix.replace("7", ["", "65", "43", "42"][c.inversion]);
    }
    // Added-note and extended chords use an explicit bass, avoiding ambiguous figured bass.
    return roman + suffix + "/" + c.noteNames[c.inversion];
}
