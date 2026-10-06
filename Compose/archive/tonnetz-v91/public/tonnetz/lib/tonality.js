import { ROOT_NAMES, getChord, mod12 } from './chord-vocabulary.js';
export const DEFAULT_KEY = Object.freeze({ tonic: 0, mode: 'major' });
export const KEYS = Object.freeze(['major', 'minor'].flatMap(mode => ROOT_NAMES.map((_, tonic) => Object.freeze({ tonic, mode }))));
export function resolveKey(key = DEFAULT_KEY) {
    if (!Number.isInteger(key.tonic) || key.tonic < 0 || key.tonic > 11 || !['major', 'minor'].includes(key.mode))
        throw new RangeError('Choose one of the 24 major/minor keys');
    return { tonic: key.tonic, mode: key.mode };
}
export function keyLabel(key, language = 'en') { return `${ROOT_NAMES[key.tonic]}${language === 'zh-CN' ? (key.mode === 'minor' ? ' 小调' : ' 大调') : (key.mode === 'minor' ? ' minor' : ' major')}`; }
export function keyPitches(key) { return (key.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map(n => mod12(n + key.tonic)); }
export function keyNeighbors(key) {
    const { tonic, mode } = resolveKey(key);
    return [
        { key: { tonic, mode }, weight: .30 },
        { key: { tonic: mod12(tonic + 7), mode }, weight: .22 },
        { key: { tonic: mod12(tonic + 5), mode }, weight: .22 },
        { key: { tonic: mod12(tonic + (mode === 'major' ? 9 : 3)), mode: mode === 'major' ? 'minor' : 'major' }, weight: .21 },
        { key: { tonic, mode: mode === 'major' ? 'minor' : 'major' }, weight: .05 }
    ];
}
// A second clock measured in generated chord changes. Rendering and wall time never advance it.
export function advanceTonality({ key = DEFAULT_KEY, keyAge = 0, keyWalk = false, keyEvery = 8 } = {}, chordId, random = Math.random) {
    key = resolveKey(key);
    if (!keyWalk)
        return { key, keyAge: 0 };
    if (!Number.isInteger(keyEvery) || keyEvery < 1 || !Number.isInteger(keyAge) || keyAge < 0)
        throw new RangeError("Invalid key-walk interval or age");
    const age = keyAge + 1;
    if (age < keyEvery)
        return { key, keyAge: age };
    const pcs = getChord(chordId)?.pcs || [];
    const candidates = keyNeighbors(key).map(item => {
        const scale = keyPitches(item.key), common = pcs.filter(pc => scale.includes(pc)).length / Math.max(1, pcs.length);
        return { ...item, weight: item.weight * (.6 + .4 * common) };
    });
    const total = candidates.reduce((n, c) => n + c.weight, 0);
    const raw = Number(random());
    if (!Number.isFinite(raw) || raw < 0 || raw > 1)
        throw new RangeError('Invalid key-walk random draw');
    let draw = Math.min(raw, 1 - Number.EPSILON) * total;
    for (const c of candidates) {
        draw -= c.weight;
        if (draw < 0)
            return { key: { ...c.key }, keyAge: 0 };
    }
    return { key: { ...candidates.at(-1).key }, keyAge: 0 };
}
