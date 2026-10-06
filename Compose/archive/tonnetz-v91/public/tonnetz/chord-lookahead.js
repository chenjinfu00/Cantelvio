import { advanceTonality, resolveKey } from './lib/tonality.js';
// Entries have stable identities: a dialog can never overwrite a chord that has already sounded.
export function createChordLookahead({ predict, sample, randomKey = Math.random }) {
    let mode = 'hold', serial = 0, current = { id: 'C', uid: 0, step: 0, key: resolveKey(), keyAge: 0 };
    let future = [], sequence = ['C'], tailStep = 0, history = ['C'], virtualHistory = ['C'], options = {}, tonal = { key: resolveKey(), keyAge: 0 };
    const push = (list, id) => { if (list.at(-1) !== id)
        list.push(id); return list.slice(-32); };
    const copy = e => ({ ...e, key: { ...e.key } });
    function append() {
        let entry = { ...copy(current), uid: ++serial };
        if (mode === 'progression') {
            tailStep = (tailStep + 1) % sequence.length;
            entry = { ...entry, id: sequence[tailStep], step: tailStep };
        }
        else if (mode === 'generate') {
            tonal = advanceTonality({ ...options, ...tonal }, virtualHistory.at(-1), randomKey);
            const id = sample(predict([...virtualHistory], { ...options, key: tonal.key }).distribution);
            entry = { id, uid: entry.uid, step: null, key: { ...tonal.key }, keyAge: tonal.keyAge };
            virtualHistory = push(virtualHistory, id);
        }
        future.push(entry);
    }
    function reset(input) {
        mode = input.mode;
        options = { ...input.options };
        current = { id: input.current, uid: ++serial, step: input.step || 0, key: resolveKey(options.key), keyAge: options.keyAge || 0 };
        sequence = input.sequence?.length ? [...input.sequence] : [input.current];
        tailStep = current.step;
        history = push([...(input.history || [])], current.id);
        virtualHistory = [...history];
        tonal = { key: { ...current.key }, keyAge: current.keyAge };
        future = [];
        while (future.length < 3)
            append();
        return view();
    }
    function advance() {
        if (!future.length)
            return copy(current);
        current = future.shift();
        history = push(history, current.id);
        append();
        return copy(current);
    }
    function contextFor(uid) {
        const index = future.findIndex(e => e.uid === Number(uid));
        if (index < 0)
            return null;
        let prefix = [...history];
        for (const e of future.slice(0, index))
            prefix = push(prefix, e.id);
        return { index: index + 1, entry: copy(future[index]), history: prefix, options: { ...options, key: { ...future[index].key } } };
    }
    function replaceFuture(uid, id) {
        const context = contextFor(uid);
        if (!context || typeof id !== 'string' || !id.trim())
            return false;
        const index = context.index - 1;
        // Earlier advertised entries are immutable; this one is a one-time intervention.
        future = future.slice(0, index + 1);
        future[index] = { ...future[index], id, step: null, edited: true };
        mode = 'generate';
        virtualHistory = push(context.history, id);
        tonal = { key: { ...future[index].key }, keyAge: future[index].keyAge };
        while (future.length < 3)
            append();
        return view();
    }
    function view() { return [current, ...future].map(copy); }
    return Object.freeze({ reset, advance, view, contextFor, replaceFuture });
}
