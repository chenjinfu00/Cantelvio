import { walkingBass, bassLanding } from './walking-bass.js';
import { createMelodyPerformer } from './improvisation.js';
const freezeEntries = entries => Object.freeze(entries.map(entry => Object.freeze({ ...entry, name: Object.freeze(entry.name) })));
export const RHYTHMS = freezeEntries([
    { id: 'quarter', name: { en: 'Quarter notes', zh: '四分音符' }, beatsPerBar: 4 },
    { id: 'eighth', name: { en: 'Eighth notes', zh: '八分音符' }, beatsPerBar: 4 },
    { id: 'syncopated', name: { en: 'Syncopated', zh: '切分节奏' }, beatsPerBar: 4 },
    { id: 'swing', name: { en: 'Swing eighths', zh: '摇摆八分' }, beatsPerBar: 4 },
    { id: 'waltz', name: { en: 'Triple meter (3/4)', zh: '三拍子（3/4）' }, beatsPerBar: 3 }
]);
export const PATTERNS = freezeEntries([
    { id: 'rock-strum', name: { en: 'Rock strumming', zh: '摇滚扫弦' } },
    { id: 'comping', name: { en: 'Rhythmic comping', zh: '节奏和弦织体' } },
    { id: 'ascending', name: { en: 'Ascending', zh: '上行' } },
    { id: 'descending', name: { en: 'Descending', zh: '下行' } },
    { id: 'updown', name: { en: 'Up and down', zh: '往返' } },
    { id: 'alberti', name: { en: 'Alberti figure', zh: '阿尔贝蒂音型' } },
    { id: 'block', name: { en: 'Block chords', zh: '柱式和弦' } },
    { id: 'bass-chord', name: { en: 'Alternating hands', zh: '双手交替' } }
]);
export const INSTRUMENTS = freezeEntries([
    { id: 'electric-guitar', name: { en: 'Electric guitar', zh: '电吉他' }, engine: 'electric-guitar' },
    { id: 'piano', name: { en: 'Acoustic piano', zh: '原声钢琴' }, engine: 'piano' },
    { id: 'epiano', name: { en: 'Electric piano', zh: '电钢琴' }, engine: 'epiano' },
    { id: 'organ', name: { en: 'Organ', zh: '风琴' }, engine: 'organ' },
    { id: 'harp', name: { en: 'Harp / pluck', zh: '竖琴／拨弦' }, engine: 'pluck' },
    { id: 'synth-lead', name: { en: 'Warm synth', zh: '温暖合成音' }, engine: 'synth-lead' },
    { id: 'strings', name: { en: 'Strings', zh: '弦乐' }, engine: 'strings' },
    { id: 'bell', name: { en: 'Bell', zh: '钟琴' }, engine: 'bell' },
    { id: 'pad', name: { en: 'Soft pad', zh: '柔和铺底' }, engine: 'pad' }
]);
export const BASS_INSTRUMENTS = freezeEntries([
    { id: 'electric-bass', name: { en: 'Electric bass', zh: '电贝斯' }, engine: 'electric-bass' },
    { id: 'synth-bass', name: { en: 'Warm synth bass', zh: '温暖合成贝斯' }, engine: 'synth-bass' },
    { id: 'piano', name: { en: 'Piano left hand', zh: '钢琴左手' }, engine: 'piano' },
    { id: 'off', name: { en: 'Off', zh: '关闭' }, engine: null }
]);
export const BASS_LINES = freezeEntries([
    { id: 'root-fifth', name: { en: 'Root & fifth', zh: '根音与五度' } },
    { id: 'driving', name: { en: 'Driving eighths', zh: '推进八分低音' } },
    { id: 'walking', name: { en: 'Walking bass', zh: '行进低音' } },
    { id: 'pedal', name: { en: 'Held bass', zh: '持续低音' } }
]);
export const STYLES = freezeEntries([
    { id: 'pop', name: { en: 'Pop', zh: '流行' }, rhythm: 'syncopated', pattern: 'comping', instrument: 'piano', bassInstrument: 'electric-bass', bassLine: 'root-fifth' },
    { id: 'rock', name: { en: 'Rock', zh: '摇滚' }, rhythm: 'eighth', pattern: 'rock-strum', instrument: 'electric-guitar', bassInstrument: 'electric-bass', bassLine: 'driving' },
    { id: 'jazz', name: { en: 'Jazz', zh: '爵士' }, rhythm: 'swing', pattern: 'comping', instrument: 'epiano', bassInstrument: 'electric-bass', bassLine: 'walking' },
    { id: 'classical', name: { en: 'Classical', zh: '古典' }, rhythm: 'eighth', pattern: 'alberti', instrument: 'piano', bassInstrument: 'piano', bassLine: 'root-fifth' }
]);
const RHYTHM_MAP = new Map(RHYTHMS.map(e => [e.id, e]));
const PATTERN_MAP = new Map(PATTERNS.map(e => [e.id, e]));
const STYLE_MAP = new Map(STYLES.map(e => [e.id, e]));
const INSTRUMENT_MAP = new Map(INSTRUMENTS.map(e => [e.id, e]));
const BASS_MAP = new Map(BASS_INSTRUMENTS.map(e => [e.id, e]));
const BASS_LINE_MAP = new Map(BASS_LINES.map(e => [e.id, e]));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const pc = n => ((n % 12) + 12) % 12;
const normalizedValue = (value, fallback, min = 0, max = 1) => Number.isFinite(Number(value)) ? clamp(Number(value), min, max) : fallback;
function normalizeChord(midis) {
    return Array.isArray(midis) ? [...new Set(midis.map(Number).filter(n => Number.isFinite(n) && n >= 0 && n <= 127).map(Math.round))].sort((a, b) => a - b) : [];
}
function resolvedOptions(options = {}) {
    const style = STYLE_MAP.get(options.style) || STYLES[0];
    const rhythm = RHYTHM_MAP.get(options.rhythm) || RHYTHM_MAP.get(style.rhythm);
    return { bpm: clamp(Number(options.bpm) || 92, 40, 200), volume: normalizedValue(options.volume, .62), style, rhythm,
        pattern: PATTERN_MAP.get(options.pattern) || PATTERN_MAP.get(style.pattern),
        instrument: INSTRUMENT_MAP.get(options.instrument) || INSTRUMENT_MAP.get(style.instrument),
        bassInstrument: BASS_MAP.get(options.bassInstrument) || BASS_MAP.get(style.bassInstrument),
        bassLine: BASS_LINE_MAP.get(options.bassLine) || BASS_LINE_MAP.get(style.bassLine),
        bassVolume: normalizedValue(options.bassVolume, .8), feel: normalizedValue(options.feel, .65), variation: normalizedValue(options.variation, .65),
        beatsPerBar: rhythm.beatsPerBar };
}
function rhythmSlots(rhythm) {
    switch (rhythm.id) {
        case 'quarter': return Array.from({ length: 4 }, (_, i) => ({ beat: i, accent: i === 0 ? 1 : .74 }));
        case 'eighth': return Array.from({ length: 8 }, (_, i) => ({ beat: i / 2, accent: i === 0 ? 1 : i % 2 ? .62 : .82 }));
        case 'swing': return Array.from({ length: 8 }, (_, i) => ({ beat: Math.floor(i / 2) + (i % 2 ? 2 / 3 : 0), accent: i === 0 ? 1 : i % 2 ? .63 : .83 }));
        case 'waltz': return Array.from({ length: 6 }, (_, i) => ({ beat: i / 2, accent: i === 0 ? 1 : i % 2 ? .55 : .73 }));
        default: return [{ beat: 0, accent: 1 }, { beat: .75, accent: .64 }, { beat: 1.5, accent: .86 }, { beat: 2.5, accent: .77 }, { beat: 3.25, accent: .87 }];
    }
}
function sequenceIndex(pattern, index, length) {
    if (length < 2)
        return 0;
    if (pattern === 'descending')
        return length - 1 - index % length;
    if (pattern === 'updown') {
        const p = index % (length * 2 - 2);
        return p < length ? p : length * 2 - 2 - p;
    }
    if (pattern === 'alberti')
        return [0, length - 1, Math.min(1, length - 1), length - 1][index % 4];
    return index % length;
}
// Stable randomness changes the performance, never the chosen harmonic future.
function noise(seed, bar, slot, voice = 0) {
    let n = (seed + Math.imul(bar + 1, 374761393) + Math.imul(slot + 1, 668265263) + Math.imul(voice + 1, 1274126177)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function nearestPitch(pitchClass, reference, low = 36, high = 55) {
    const values = [];
    for (let n = low; n <= high; n++)
        if (pc(n) === pitchClass)
            values.push(n);
    return values.sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference) || a - b)[0];
}
function upperVoicing(chord, root, style, phase, variation) {
    let upper = [...new Set(chord.map(n => { while (n < 55)
            n += 12; while (n > 79)
            n -= 12; return n; }))].sort((a, b) => a - b);
    if (upper.length > 4) {
        const priority = n => { const interval = pc(n - root); return interval === 0 ? (pc(chord[0]) === root ? 2 : 10) : [3, 4, 10, 11].includes(interval) ? 9 : interval === 7 ? 1 : 7; };
        upper = upper.sort((a, b) => priority(b) - priority(a) || a - b).slice(0, variation > .8 ? 5 : 4).sort((a, b) => a - b);
    }
    if (variation > .35 && phase === 2 && style !== 'classical' && upper[0] + 12 <= 79) {
        upper = [...upper.slice(1), upper[0] + 12].sort((a, b) => a - b);
    }
    return [...new Set(upper)];
}
function bassEvents(chord, nextChord, resolved, bar, variation, key) {
    if (resolved.bassInstrument.id === 'off' || resolved.bassVolume === 0)
        return [];
    const beats = resolved.beatsPerBar, bass = bassLanding(chord[0]), target = bassLanding(nextChord[0] ?? chord[0]);
    const tones = [...new Set(chord.map(pc))];
    const fifth = nearestPitch(tones.includes(pc(chord[0] + 7)) ? pc(chord[0] + 7) : tones.at(-1), bass + 5);
    const phase = variation > 0 ? bar % 4 : 0;
    if (resolved.bassLine.id === 'pedal')
        return [{ beat: 0, midi: bass, length: beats - .08, accent: 1 }];
    if (resolved.bassLine.id === 'driving') {
        return Array.from({ length: beats * 2 }, (_, i) => ({ beat: i / 2, midi: i === beats * 2 - 1 && phase === 3 ? fifth : bass, length: i % 2 ? .3 : .42, accent: i === 0 ? 1 : i % 2 ? .58 : .86 }));
    }
    if (resolved.bassLine.id === 'walking') return walkingBass(chord,nextChord,{beats,key,bar:phase});
    if (resolved.style.id === 'classical' || beats === 3)
        return [{ beat: 0, midi: bass, length: beats === 3 ? 1.25 : 1.55, accent: 1 }, { beat: beats === 3 ? 2 : 2, midi: fifth, length: .8, accent: .68 }];
    const turn = tones.map(p => nearestPitch(p, target)).sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || (phase % 2 ? a - b : b - a))[0];
    const rhythms = [[[0, bass, 1.3, 1], [1.5, fifth, .38, .64], [2, bass, 1.12, .92], [3.5, turn, .38, .68]], [[0, bass, 1.65, 1], [2, fifth, .85, .8], [3.25, bass, .52, .69]], [[0, bass, .8, 1], [1.5, bass, .32, .62], [2, fifth, 1.05, .84], [3.5, turn, .36, .71]], [[0, bass, 1.4, 1], [2, fifth, .58, .78], [3, turn, .38, .74], [3.5, bass, .32, .6]]];
    return rhythms[phase].map(([beat, midi, length, accent]) => ({ beat, midi, length, accent }));
}
/** One musically varied bar. All times are bounded to this bar; the harmonic queue is read-only. */
export function buildBarEvents(midis, options = {}) {
    const chord = normalizeChord(midis);
    if (!chord.length)
        return [];
    const r = resolvedOptions(options), secondsPerBeat = 60 / r.bpm, barDuration = secondsPerBeat * r.beatsPerBar;
    const bar = Math.max(0, Math.floor(options.bar || 0)), seed = options.seed ?? 41977, phase = r.variation > .15 ? bar % 4 : 0;
    const root = Number.isFinite(options.root) ? pc(options.root) : pc(chord[0]);
    const upper = upperVoicing(chord, root, r.style.id, phase, r.variation), slots = rhythmSlots(r.rhythm), events = [];
    const add = (midi, beat, length, velocity, role, index, instrument, rolled = 0) => {
        const drift = beat === 0 && role === 'bass' ? 0 : (noise(seed, bar, index, role === 'bass' ? 13 : 31) - .5) * .024 * r.feel;
        const pocket = role === 'bass' ? 0 : (r.style.id === 'jazz' ? .012 : .004) * r.feel;
        const time = clamp(beat * secondsPerBeat + drift + pocket + rolled, 0, barDuration - .025);
        const phraseLift = [.98, .92, 1.04, .95][phase];
        const expressive = 1 + (noise(seed, bar, index, midi) - .5) * .18 * r.feel;
        const duration = Math.min(barDuration - time - .008, Math.max(.05, length * secondsPerBeat * (1 + (noise(seed, bar, index, 7) - .5) * .12 * r.feel)));
        events.push(Object.freeze({ beat, time, duration, durationBeats: duration / secondsPerBeat, midi, velocity: clamp(velocity * expressive * phraseLift, .08, .96), role, noteIndex: index, instrument, beatsPerBar: r.beatsPerBar, barDuration }));
    };
    slots.forEach((slot, i) => {
        let notes = upper;
        if (r.pattern.id === 'rock-strum') {
            // Alternate muted short strokes with open backbeats; preserve the chord's third/seventh.
            const masks = [[0, 1, 2, 3, 4, 6, 7], [0, 2, 3, 4, 5, 6], [0, 1, 2, 4, 5, 6, 7], [0, 2, 3, 4, 6]];
            if (!masks[phase].includes(i))
                return;
            if (i % 2)
                notes = upper.slice(-Math.min(3, upper.length));
        }
        else if (r.pattern.id === 'comping') {
            const masks = r.style.id === 'jazz' ? [[0, 3, 6], [1, 4, 7], [0, 2, 5], [1, 3, 6, 7]] : [[0, 2, 4, 6], [0, 1, 3, 6], [0, 2, 3, 5, 7], [0, 2, 4, 7]];
            if (!masks[phase].includes(i))
                return;
        }
        else if (r.pattern.id === 'bass-chord') {
            if (i % 2 === 0) {
                if (r.bassInstrument.id !== 'off')
                    return;
                notes = [upper[0]];
            }
        }
        else if (r.pattern.id !== 'block')
            notes = [upper[sequenceIndex(r.pattern.id, i, upper.length)]];
        if (r.variation > .45 && phase === 3 && r.style.id === 'classical' && i === slots.length - 1)
            return;
        const available = (slots[i + 1]?.beat ?? r.beatsPerBar) - slot.beat;
        const articulation = r.pattern.id === 'rock-strum' ? (i % 2 ? .3 : i % 4 === 2 ? .88 : .52) : r.style.id === 'jazz' ? .55 : r.style.id === 'classical' ? .88 : .7;
        const duration = available * articulation;
        const direction = (r.pattern.id === 'rock-strum' ? i % 2 : phase % 2) ? [...notes].reverse() : notes;
        direction.forEach((midi, v) => add(midi, slot.beat, duration, slot.accent * (r.style.id === 'jazz' ? .63 : .7) / Math.sqrt(notes.length), notes.length > 1 ? 'chord' : 'note', i * 9 + v, r.instrument.engine, v * (r.pattern.id === 'rock-strum' ? .012 : .007) * r.feel));
    });
    for (const [i, event] of bassEvents(chord, normalizeChord(options.nextChord), r, bar, r.variation, options.key).entries())
        add(event.midi, event.beat, event.length, event.accent * .83, 'bass', i, r.bassInstrument.engine);
    return events.sort((a, b) => a.time - b.time || a.midi - b.midi);
}
export function createAccompaniment({ audio, onBar = () => null, getNextChord = () => [], getChordRoot = () => null, getKey = () => ({tonic:0,mode:"major"}), getSoloOptions = () => ({}), getChordId = () => null, onMelodyPhrase = () => {}, beforeBar = () => {}, onBarStart = () => { }, onBeat = () => { }, onState = () => { }, clock = globalThis } = {}) {
    if (!audio || typeof audio.ensureReady !== "function" || typeof audio.playNote !== "function") {
        throw new TypeError("createAccompaniment requires a TonnetzAudio-compatible audio object");
    }
    let config = {
        bpm: 92,
        volume: 0.62,
        style: "pop",
        rhythmOverride: null,
        patternOverride: null,
        instrumentOverride: null,
        bassInstrumentOverride: null,
        bassLineOverride: null,
        bassVolume: .8,
        feel: .65,
        variation: .65,
        soloEnabled: false, soloVolume: .45
    };
    let playing = false;
    let chord = [];
    let barIndex = 0;
    let generation = 0;
    let inBarCallback = false;
    let transport = null;
    let previousSoloMidi = null;
    const melodyPerformer = createMelodyPerformer();
    const resetMelody = () => { melodyPerformer.reset(); previousSoloMidi=null; try { onMelodyPhrase(null); } catch (_) {} };
    let soloGeneration = 0;
    const timers = new Set();
    const nowMs = () => {
        if (typeof clock.now === "function")
            return Number(clock.now());
        if (typeof clock.performance?.now === "function")
            return Number(clock.performance.now());
        return Date.now();
    };
    const schedule = (callback, delay) => {
        let handle;
        handle = clock.setTimeout(() => {
            timers.delete(handle);
            callback();
        }, Math.max(0, delay));
        timers.add(handle);
        return handle;
    };
    const clearTimers = () => {
        timers.forEach((handle) => clock.clearTimeout(handle));
        timers.clear();
    };
    const effective = () => {
        const style = STYLE_MAP.get(config.style) || STYLES[0];
        return resolvedOptions({
            bpm: config.bpm,
            volume: config.volume,
            style: style.id,
            rhythm: config.rhythmOverride || style.rhythm,
            pattern: config.patternOverride || style.pattern,
            instrument: config.instrumentOverride || style.instrument,
            bassInstrument: config.bassInstrumentOverride || style.bassInstrument,
            bassLine: config.bassLineOverride || style.bassLine,
            bassVolume: config.bassVolume, feel: config.feel, variation: config.variation
        });
    };
    const getState = () => {
        const resolved = effective();
        return Object.freeze({
            playing,
            bpm: resolved.bpm,
            rhythm: resolved.rhythm.id,
            pattern: resolved.pattern.id,
            style: resolved.style.id,
            instrument: resolved.instrument.id,
            volume: resolved.volume,
            bassInstrument: resolved.bassInstrument.id, bassLine: resolved.bassLine.id,
            bassVolume: resolved.bassVolume, feel: resolved.feel, variation: resolved.variation,
            beatsPerBar: resolved.beatsPerBar, soloEnabled: config.soloEnabled, soloVolume: config.soloVolume
        });
    };
    const notifyState = () => {
        try {
            onState(getState());
        }
        catch (_) { /* UI callbacks must not stop playback. */ }
    };
    // Expose the sounding bar, not pending tempo/meter changes in config.
    const getTransport = () => {
        const bar = transport || { bar: 0, startMs: 0, durationMs: 0, bpm: effective().bpm, beatsPerBar: effective().beatsPerBar };
        return Object.freeze({ ...bar, playing, progress: playing && bar.durationMs > 0
                ? clamp((nowMs() - bar.startMs) / bar.durationMs, 0, 1) : 0 });
    };
    const contextIsRunning = () => {
        const context = audio.getContext?.();
        return !context || context.state === "running";
    };
    const halt = ({ stopAudio = true, notify = true } = {}) => {
        generation += 1;
        clearTimers();
        playing = false;
        transport = null;
        resetMelody();
        if (stopAudio) {
            audio.stopGroup?.("accompaniment");
            audio.stopGroup?.("accompaniment-bass");
            audio.stopGroup?.("auto-solo");
        }
        if (notify)
            notifyState();
    };
    const scheduleBar = (token, expectedStart, { skipOnBar = false } = {}) => {
        if (!playing || token !== generation)
            return;
        if (!contextIsRunning()) {
            halt();
            return;
        }
        if (!skipOnBar) { try { beforeBar({bar:barIndex}); } catch (_) {} }
        const resolved = effective();
        const beatMs = 60000 / resolved.bpm;
        const barMs = beatMs * resolved.beatsPerBar;
        const observedNow = nowMs();
        const barStart = observedNow - expectedStart > Math.min(250, beatMs * 0.75) ? observedNow : expectedStart;
        if (!skipOnBar) {
            try {
                inBarCallback = true;
                const returnedChord = normalizeChord(onBar({ bar: barIndex, chord: [...chord], state: getState() }));
                if (returnedChord.length)
                    chord = returnedChord;
            }
            catch (_) {
                // Keep the previous chord if model or UI code fails at a boundary.
            }
            finally {
                inBarCallback = false;
            }
        }
        const soundingChord = [...chord];
        transport = { bar: barIndex, startMs: barStart, durationMs: barMs, bpm: resolved.bpm, beatsPerBar: resolved.beatsPerBar };
        try {
            onBarStart(getTransport());
        }
        catch (_) { /* UI cannot interrupt audio. */ }
        const events = buildBarEvents(soundingChord, {
            bpm: resolved.bpm,
            volume: resolved.volume,
            style: resolved.style.id,
            rhythm: resolved.rhythm.id,
            pattern: resolved.pattern.id,
            instrument: resolved.instrument.id,
            bassInstrument: resolved.bassInstrument.id, bassLine: resolved.bassLine.id,
            bassVolume: resolved.bassVolume, feel: resolved.feel, variation: resolved.variation,
            bar: barIndex, nextChord: getNextChord(), root: getChordRoot(), key: getKey()
        });
        const barSoloGeneration = soloGeneration;
        const solo = melodyPerformer.plan(soundingChord,{...getSoloOptions(),enabled:config.soloEnabled,bar:barIndex,bpm:resolved.bpm,beatsPerBar:resolved.beatsPerBar,feel:resolved.feel,key:getKey(),nextChord:getNextChord(),previousMidi:previousSoloMidi,chordId:getChordId()});
        try { onMelodyPhrase(solo.feedback); } catch (_) {}
        previousSoloMidi=solo.lastMidi;
        events.push(...solo.events);
        audio.setGroupVolume?.("auto-solo",config.soloVolume);
        const lateLimit = Math.min(180, beatMs * 0.45);
        events.forEach((event) => {
            const due = barStart + event.time * 1000;
            schedule(() => {
                if (!playing || token !== generation || !contextIsRunning())
                    return;
                if (nowMs() - due > lateLimit)
                    return;
                if (event.role === "bass" && (effective().bassInstrument.id === "off" || effective().bassVolume === 0))
                    return;
                if (event.role === "solo" && (!config.soloEnabled || barSoloGeneration !== soloGeneration)) return;
                audio.playNote(event.midi, {
                    instrument: event.instrument,
                    velocity: event.velocity,
                    duration: event.duration,
                    group: event.role === "solo" ? "auto-solo" : event.role === "bass" ? "accompaniment-bass" : "accompaniment",
                    when: Number.isFinite(audio.getContext?.()?.currentTime) ? audio.getContext().currentTime + Math.max(0, due - nowMs()) / 1000 : undefined
                });
            }, due - nowMs() - 40);
        });
        for (let beat = 0; beat < resolved.beatsPerBar; beat += 1) {
            const due = barStart + beat * beatMs;
            schedule(() => {
                if (!playing || token !== generation || nowMs() - due > lateLimit)
                    return;
                try {
                    onBeat({ beat, beatsPerBar: resolved.beatsPerBar, bar: barIndex });
                }
                catch (_) { /* UI only. */ }
            }, due - nowMs());
        }
        const nextStart = barStart + barMs;
        const completedBar = barIndex;
        schedule(() => {
            if (!playing || token !== generation)
                return;
            barIndex = completedBar + 1;
            scheduleBar(token, nextStart);
        }, nextStart - nowMs());
    };
    const start = async (midis) => {
        const nextChord = normalizeChord(midis);
        const token = generation + 1;
        halt({ notify: false });
        generation = token;
        chord = nextChord;
        barIndex = 0;
        previousSoloMidi = null;
        if (!chord.length) {
            notifyState();
            return false;
        }
        let ready = false;
        try {
            ready = await audio.ensureReady();
        }
        catch (_) {
            ready = false;
        }
        if (token !== generation)
            return false;
        if (!ready || !contextIsRunning()) {
            playing = false;
            notifyState();
            return false;
        }
        playing = true;
        audio.setGroupVolume?.("accompaniment", effective().volume);
        audio.setGroupVolume?.("accompaniment-bass", effective().volume * effective().bassVolume);
        notifyState();
        scheduleBar(token, nowMs(), { skipOnBar: true });
        return true;
    };
    const stop = () => halt();
    const setChord = (midis) => {
        const next = normalizeChord(midis);
        if (next.length)
            chord = next;
        if (playing && next.length && !inBarCallback) {
            generation += 1;
            clearTimers();
            audio.stopGroup?.("accompaniment");
            audio.stopGroup?.("accompaniment-bass");
            audio.stopGroup?.("auto-solo");
            resetMelody();
            scheduleBar(generation, nowMs(), { skipOnBar: true });
        }
        return [...chord];
    };
    const update = (options = {}) => {
        const has = (key) => Object.prototype.hasOwnProperty.call(options, key);
        if (has("bpm"))
            config.bpm = clamp(Number(options.bpm) || 92, 40, 200);
        if (STYLE_MAP.has(options.style))
            config.style = options.style;
        if (has("rhythm"))
            config.rhythmOverride = RHYTHM_MAP.has(options.rhythm) ? options.rhythm : null;
        if (has("pattern"))
            config.patternOverride = PATTERN_MAP.has(options.pattern) ? options.pattern : null;
        if (has("instrument"))
            config.instrumentOverride = INSTRUMENT_MAP.has(options.instrument) ? options.instrument : null;
        if (has("bassInstrument"))
            config.bassInstrumentOverride = BASS_MAP.has(options.bassInstrument) ? options.bassInstrument : null;
        if (has("bassLine"))
            config.bassLineOverride = BASS_LINE_MAP.has(options.bassLine) ? options.bassLine : null;
        for (const key of ["bassVolume", "feel", "variation"])
            if (has(key))
                config[key] = normalizedValue(options[key], config[key]);
        if (has("soloEnabled")) {
            if(config.soloEnabled!==!!options.soloEnabled)soloGeneration++;
            config.soloEnabled=!!options.soloEnabled;
            if(!config.soloEnabled){audio.stopGroup?.("auto-solo");resetMelody();}
        }
        if (has("soloVolume")) config.soloVolume=normalizedValue(options.soloVolume,config.soloVolume);
        if (has("volume"))
            config.volume = clamp(Number(options.volume) || 0, 0, 1);
        if (playing) {
            audio.setGroupVolume?.("accompaniment", effective().volume);
            audio.setGroupVolume?.("accompaniment-bass", effective().volume * effective().bassVolume);
            if (effective().bassInstrument.id === "off")
                audio.stopGroup?.("accompaniment-bass");
            audio.setGroupVolume?.("auto-solo",config.soloVolume);
        }
        notifyState();
        return getState();
    };
    const eventTarget = typeof window !== "undefined" ? window : null;
    eventTarget?.addEventListener("tonnetz:panic", () => halt({ stopAudio: false }));
    eventTarget?.addEventListener("tonnetz:audio-state", (event) => {
        if (playing && event.detail?.state !== "running")
            halt();
    });
    return Object.freeze({ start, stop, setChord, update, getState, getTransport });
}
