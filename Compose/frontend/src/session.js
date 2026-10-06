/** Performance state around the joint Transformer timeline.
 *
 * The Composer writes chords, accompaniment rhythm, bass and melody ahead of the
 * playhead; the chart shows exactly those bars. At every bar boundary the next
 * generated bar is frozen, rendered to audio events and scheduled on the audio
 * clock. Parameter, scene and key changes regenerate only bars that have not been
 * scheduled; an edited future chord is written into the timeline as a constraint
 * and everything after it is regenerated.
 */
import { Composer, METERS, mod12 } from './composer.js';
import { renderBar, performanceNotes } from './render.js';
import {ORCHESTRA_GROUP_IDS, DEFAULT_ORCHESTRA_GROUPS} from './orchestration.js';
import {INSTRUMENT_IDS, INSTRUMENT_ROLES, normalizeInstrumentBoard, nativeInstrumentBoard, routeInstrumentBar, activeInstrumentIds} from './instrument-board.js';
import { analyzeGroupRoles, V2_LANES } from './roles.js';
import { defaults, SCENES, snapshotScene, normalizeScene } from './scenes.js';
import { styleOf } from './instruments.js';
import { Transport } from './transport.js';
import { chordEntry, chordLabel } from './voicing.js';
import { getChord, QUALITIES } from '../vendor/lib/chord-vocabulary.js';
import { keyNeighbors, keyPitches } from '../vendor/lib/tonality.js';

export const EDIT_GUARD_SECONDS = .6;   // a bar about to be scheduled can no longer be edited
const REGENERATING = new Set(['harmonyT', 'melodyT', 'density', 'style', 'meter', 'mode', 'changeMode', 'keyWalk', 'keyEvery', 'randomScenes', 'randomEvery']);

export class Session {
    constructor(audio, { random = Math.random, onChange = () => { }, saved = {}, composerOptions = {}, composerClass = Composer, arranger = null } = {}) {
        Object.assign(this, { audio, random, onChange, saved: saved || {}, arranger });
        this.state = defaults();
        this.pendingScene = null; this.pendingSceneBar = null; this.pendingBpm = null; this.pendingKey = null; this.pendingKeyBar = null;
        this.editIntent = null; this.passStart = 0; this.voicing = []; this.syncFallbacks = 0; this.lastComplete = -1;
        this.arranged = new Map(); this.arrangerTimer = null;
        this.roleBars = new Map(); this.roleCache = null;   // display-only group roles of scheduled bars
        this.soundingScene = this.state.scene; this.soundingMode = this.state.mode; this.soundingUid = null;
        this.composer = new composerClass({ random, planBar: (index, previous) => this.planBar(index, previous), onProgress: () => this.progress(), ...composerOptions });
        this.transport = new Transport({
            prepare: this.composer.isV2 ? async bar => { const ready=await this.composer.prefetch(bar===0?8:bar+1); if(!ready)throw this.composer.error || new Error('Generation cancelled'); } : null,
            isReady: this.composer.isV2 ? bar => this.composer.barComplete(bar) : null,
            audio, boundary: arg => this.boundary(arg),
            onChange: (message, error) => { if (message === 'interrupted' || message === 'error') this.afterStop(); onChange(message, error); }
        });
        if(this.composer.isV2)this.state.instrumentBoard=nativeInstrumentBoard(this.state.instrumentBoard);
        this.newTimeline();
        if(this.composer.isV2)this.setInstrumentBoard(this.state.instrumentBoard);
    }

    async init() { this.prefetchChart(); }
    notify() { this.onChange(); }
    progress() {
        const n = this.composer.completeBars();
        if (n === this.lastComplete) return;
        if(n<this.lastComplete)for(const key of this.arranged.keys())if(key>=n)this.arranged.delete(key);
        this.lastComplete=n;this.prepareArrangement();this.notify();
    }

    arrangementActive() {
        return !!this.arranger && this.state.instrumentBoard.learnedArrangement &&
            ORCHESTRA_GROUP_IDS.some(id=>this.state.instrumentBoard.lanes[id].enabled);
    }
    prepareArrangement() {
        if(!this.arrangementActive()||this.arrangerTimer)return;
        const c=this.composer;
        let bar;
        for(let i=c.lockedBars;i<c.completeBars();i++)if(!this.arranged.has(i)){bar=i;break;}
        if(bar===undefined)return;
        const timeline=c.timeline,revision=c.revision;
        this.arrangerTimer=globalThis.setTimeout(()=>{
            this.arrangerTimer=null;
            if(!this.arrangementActive()||c.timeline!==timeline||c.revision!==revision||bar<c.lockedBars){
                this.prepareArrangement();return;
            }
            const record=c.bars[bar],notes=performanceNotes(c,bar);
            const logits=notes.length?this.arranger.classify(notes,record.signature,record.beats):[];
            this.arranged.set(bar,new Map(notes.slice(0,64).map((note,i)=>[note.key,logits[i]])));
            this.prepareArrangement();
        },0);
        this.arrangerTimer?.unref?.();
    }
    refreshArrangement() {
        if(!this.arrangementActive()){
            if(this.arrangerTimer)globalThis.clearTimeout(this.arrangerTimer);
            this.arrangerTimer=null;this.arranged.clear();
        }else this.prepareArrangement();
    }

    // ------------------------------------------------------------- timeline and bar plans
    newTimeline(chord = null, key = this.state.key) {
        if(this.arrangerTimer)globalThis.clearTimeout(this.arrangerTimer);
        this.arrangerTimer=null;
        key = { ...key };
        chord = chord ? { ...chord } : { root: key.tonic, q: key.mode === 'minor' ? 1 : 0 };
        this.passStart = 0; this.voicing = []; this.lastComplete = -1; this.arranged.clear();
        this.roleBars.clear(); this.roleCache = null;
        // Seed the melody with a chord tone near G4: from a silent first step the art-song
        // condition tends to open with a long piano introduction.
        const tones = QUALITIES[chord.q].intervals.map(i => mod12(chord.root + i)), melody = [...Array(17).keys()].map(n => 60 + n).filter(n => tones.includes(mod12(n))).sort((a, b) => Math.abs(a - 67) - Math.abs(b - 67))[0];
        this.composer.reset({ key, chord, melody });
        this.lastHeard = { chord, key };
        this.soundingUid = `${this.composer.timeline}:0`;
    }

    sceneFields(id) { return normalizeScene(this.saved[id] || SCENES.find(s => s.id === id), id); }

    planBar(index, previous) {
        const s = this.state, c = this.composer;
        const upcoming = previous && previous.index >= c.lockedBars && previous.cond.scene !== s.scene;
        const firstOfPass = !previous || previous.index < c.lockedBars || (index === this.passStart && !upcoming);
        const pending = this.pendingScene && index >= this.pendingSceneBar;
        let scene, fields, sceneSwitch = null;
        if (firstOfPass) {
            scene = pending ? this.pendingScene : s.scene;
            fields = pending ? this.sceneFields(this.pendingScene) : snapshotScene(s);
            if (pending && index === this.pendingSceneBar) sceneSwitch = this.pendingScene;
        } else if (this.pendingScene && index === this.pendingSceneBar) {
            scene = this.pendingScene; fields = this.sceneFields(scene); sceneSwitch = scene;
        } else {
            scene = previous.cond.scene; fields = previous.cond.fields;
            if (s.randomScenes && this.random() < 1 / Math.max(1, s.randomEvery)) {
                const choices = SCENES.filter(x => x.id !== scene);
                scene = choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))].id;
                fields = this.sceneFields(scene); sceneSwitch = scene;
            }
        }
        const style = styleOf(fields.style);
        const cond = {
            scene, fields, style: style.id, domain: style.domain, styleId: style.styleId, harmonyT: fields.harmonyT, melodyT: fields.melodyT,
            density: fields.density, beats: Number(fields.meter) || 4, mode: s.mode, changeMode: s.changeMode || 'bar'
        };
        let key = previous ? previous.key : { ...s.key }, keyAge = 0, forceTonic = false;
        if (previous && this.pendingKey && index === this.pendingKeyBar) { key = { ...this.pendingKey }; forceTonic = true; }
        else if (previous && s.keyWalk && cond.mode !== 'hold') {
            keyAge = previous.keyAge + 1;
            if (keyAge >= s.keyEvery) { key = this.walkKey(previous); keyAge = 0; }
        }
        return { cond, key, keyAge, sceneSwitch, forceTonic };
    }

    /** Neighbouring key, favouring common tones with the chord that ends the previous bar. */
    walkKey(previous) {
        const last = this.composer.steps[previous.start + previous.barlen - 1];
        const pcs = QUALITIES[last.chord.q].intervals.map(i => mod12(last.chord.root + i));
        const candidates = keyNeighbors(previous.key).map(item => {
            const scale = keyPitches(item.key), common = pcs.filter(pc => scale.includes(pc)).length / pcs.length;
            return { ...item, weight: item.weight * (.6 + .4 * common) };
        });
        let draw = Math.min(Math.max(Number(this.random()) || 0, 0), 1 - Number.EPSILON) * candidates.reduce((n, c) => n + c.weight, 0);
        for (const c of candidates) { draw -= c.weight; if (draw < 0) return { ...c.key }; }
        return { ...candidates.at(-1).key };
    }

    /** First bar that parameter changes and edits may still rewrite: its scheduling must be
     * far enough away for the rewrite (window rebuild included) to finish at the measured
     * generation speed, so a boundary never has to wait for the model. */
    firstEditableBar() {
        const c = this.composer;
        if (!this.transport.running || !Number.isFinite(this.transport.nextAt)) return c.lockedBars;
        const now = this.audio.context?.currentTime ?? 0, seconds = 60 / (this.pendingBpm ?? this.state.bpm);
        let boundaryAt = this.transport.nextAt - .1;
        for (let b = c.lockedBars; b < c.lockedBars + 8; b++) {
            const bar = c.bars[b], start = bar ? bar.start : c.steps.length;
            const need = Math.max(EDIT_GUARD_SECONDS, 2 * c.positionsToRegenerate(start) * c.stats.msPerPosition / 1000 + .05);
            if (boundaryAt - now >= need) return b;
            boundaryAt += (bar ? bar.beats : (METERS[this.state.meter] || METERS[4]).beats) * seconds;
        }
        return c.lockedBars + 8;
    }

    regenerate() {
        const from = this.firstEditableBar();
        this.passStart = from;
        this.composer.regenerateFromBar(from);
        this.editIntent = null;
        this.prefetchChart();
    }

    prefetchChart() {
        const c = this.composer, current = this.transport.frame?.bar ?? 0, baseBar = Math.floor(current / 4) * 4;
        return c.prefetch(Math.max(baseBar + 8, c.lockedBars + 2));
    }

    // ------------------------------------------------------------- transport boundary
    boundary({ bar, first, start = null }) {
        const c = this.composer;
        if (bar !== c.lockedBars) throw new Error(`Bar ${bar + 1} is out of order`);
        if (!c.barComplete(bar)) { this.syncFallbacks++; this.inBoundary=true;try{c.ensureBar(bar);}finally{this.inBoundary=false;} }
        const record = c.bars[bar];
        if (record.sceneSwitch) {
            this.applyScene(record.sceneSwitch, start ?? this.audio.context?.currentTime ?? 0);
            if (this.pendingScene === record.sceneSwitch && bar === this.pendingSceneBar) this.pendingScene = null;
        }
        if (this.pendingScene && bar >= this.pendingSceneBar) this.pendingScene = null;
        if (this.pendingBpm !== null) { this.state.bpm = this.pendingBpm; this.pendingBpm = null; }
        if (this.pendingKey && bar >= this.pendingKeyBar) this.pendingKey = null;
        c.lock(bar);
        const bpm = this.state.bpm, priorVoicing = this.voicing;
        const plan = renderBar({ composer: c, index: bar, state: { ...this.state, bassOn: true, melodyOn: true }, bpm, nextBpm: this.pendingBpm ?? bpm, voicing: priorVoicing });
        this.voicing = plan.voicing;
        const learned=this.arranged.get(bar);
        if(c.isV2&&this.state.instrumentBoard.learnedArrangement)plan.learnedArrangement=true;
        if(learned&&this.state.instrumentBoard.learnedArrangement){for(const event of plan.events)event.groupLogits=learned.get(event.sourceKey);plan.learnedArrangement=true;}
        plan.events = routeInstrumentBar(plan, this.state.instrumentBoard, this.state, bar);
        if (this.state.instrumentBoard.nativeGroups) {
            this.roleBars.set(bar, this.roleBar(bar, activeInstrumentIds(this.state.instrumentBoard, bar)));
            for (const k of this.roleBars.keys()) if (k < bar - 4) this.roleBars.delete(k);
        }
        const spans = this.barSpans(bar), seconds = 60 / bpm;
        const commit = span => { this.soundingUid = span.uid; this.lastHeard = { chord: span.chord, key: { ...record.key } }; this.soundingMode = record.cond.mode; };
        plan.onStart = () => {
            this.soundingScene = record.cond.scene; this.state.key = { ...record.key }; commit(spans[0]);
            this.notify(); this.prefetchChart();
        };
        plan.transitions = spans.slice(1).map(span => ({ time: span.startBeat * seconds, onStart: () => { commit(span); this.notify(); } }));
        plan.timeline = spans.map(({ uid, label, startBeat, lengthBeats, continuation }) => ({ uid, label, startBeat, lengthBeats, continuation }));
        plan.bar = bar; plan.first = first;
        if (start === null) { plan.onStart(); for (const t of plan.transitions) t.onStart(); }
        this.notify();
        this.prefetchChart();
        return plan;
    }

    // ------------------------------------------------------------- group roles (display only)
    /** Pitched notes of one bar for the role status bars: quarter-note times with
     * the renderer's 8-quarter duration cap, plus the groups routed to audio. */
    roleBar(index, active) {
        const c = this.composer;
        const notes = performanceNotes(c, index).filter(n => n.group && Number.isFinite(n.pitch) && n.durationQuarter > 0).map(n => ({
            group: n.group, voice: n.voice ?? null, lane: c.isV2 ? V2_LANES[n.role] : undefined, pitch: n.pitch,
            start: n.onsetQuarter, end: n.onsetQuarter + Math.min(8, n.durationQuarter), velocity: n.velocity
        }));
        return { beats: c.bars[index].beats, notes, active: new Set(active) };
    }
    /** Roles of each group in the bar now sounding (before playback: the next bar),
     * read from the notes the groups play. A group switched off since scheduling is
     * silenced, so it is left out. Display only: never touches notes or scheduling. */
    roleView() {
        const board = this.state.instrumentBoard, c = this.composer;
        if (!board.nativeGroups) return null;
        const frame = this.transport.frame, now = !!(frame && this.transport.running && this.roleBars.has(frame.bar));
        const bar = now ? frame.bar : c.lockedBars;
        if (!now && !c.barComplete(bar)) return { bar, now, ready: false, groups: {} };
        const enabled = ORCHESTRA_GROUP_IDS.filter(id => board.lanes[id]?.enabled).join();
        const routed = now ? '' : [...activeInstrumentIds(board, bar)].join();
        const key = [c.timeline, now ? 'now' : c.revision, bar, enabled, routed].join('|');
        if (this.roleCache?.key === key) return this.roleCache.view;
        const entries = new Map(this.roleBars);
        if (!now) entries.set(bar, this.roleBar(bar, activeInstrumentIds(board, bar)));
        const audible = (entry, id) => entry.active.has(id) && !!board.lanes[id]?.enabled;
        const analyse = (index, previous) => {
            const entry = entries.get(index);
            if (!entry) return null;
            const notes = entry.notes.filter(n => audible(entry, n.group));
            let shift = 0;
            for (let k = 1; k <= 3; k++) {   // previous bar as context; older bars only if still sounding
                const earlier = entries.get(index - k);
                if (!earlier) break;
                shift -= earlier.beats;
                for (const n of earlier.notes) if (audible(earlier, n.group) && (k === 1 || n.end + shift > 0))
                    notes.push({ ...n, start: n.start + shift, end: n.end + shift });
            }
            return analyzeGroupRoles({ notes, beats: entry.beats, groups: ORCHESTRA_GROUP_IDS, previous });
        };
        const entry = entries.get(bar), result = analyse(bar, analyse(bar - 1, null));
        const view = { bar, now, ready: true, groups: Object.fromEntries(ORCHESTRA_GROUP_IDS.map(id => [id, {
            enabled: !!board.lanes[id]?.enabled, active: audible(entry, id), ...result.groups[id] }])) };
        this.roleCache = { key, view };
        return view;
    }

    // ------------------------------------------------------------- chart
    barSpans(index) {
        const c = this.composer, spans = c.chordSpans(index);
        if (!spans) return null;
        const bar = c.bars[index];
        return spans.map(span => {
            const bassPc = span.onsetBass, entry = chordEntry(span.chord.root, span.chord.q, bassPc);
            return {
                uid: `${c.timeline}:${span.step}`, step: span.step, onset: span.onset, chord: { ...span.chord }, bassPc, id: entry.id,
                label: chordLabel(span.chord.root, span.chord.q, entry.inversion ? bassPc : null, span.key),
                startBeat: (span.step - bar.start) / 4, lengthBeats: span.length / 4, continuation: span.continuation
            };
        });
    }

    chartView() {
        const c = this.composer, running = this.transport.running, frame = this.transport.frame;
        const current = frame?.bar ?? 0, baseBar = Math.floor(current / 4) * 4, editableFrom = this.firstEditableBar();
        const rows = [];
        for (let b = baseBar; b < baseBar + 8; b++) {
            const spans = this.barSpans(b);
            if (!spans) { const meter = c.bars[b] || METERS[this.state.meter] || METERS[4]; rows.push({ bar: b, meter: meter.beats, signature: meter.signature, segments: [], pending: true }); continue; }
            rows.push({
                bar: b, meter: c.bars[b].beats, signature: c.bars[b].signature, pending: false,
                rhythm: performanceNotes(c,b).map(note=>({onset:note.onsetQuarter,role:note.role,ratio:note.ratioText,dynamic:note.dynamicText})),
                segments: spans.map(span => ({
                    ...span, scheduled: b < c.lockedBars, sounding: running && frame?.bar === b && this.soundingUid === span.uid,
                    editable: span.step > 0 && b >= editableFrom && b >= c.lockedBars
                }))
            });
        }
        return { baseBar, rows, editableFrom, revision: c.revision, timeline: c.timeline, lockedBars: c.lockedBars };
    }

    // ------------------------------------------------------------- editing
    findSpan(uid) {
        const [timeline, step] = String(uid).split(':').map(Number), c = this.composer;
        if (timeline !== c.timeline || !Number.isInteger(step) || !c.steps[step]) return null;
        return this.barSpans(c.steps[step].bar)?.find(s => s.step === step) || null;
    }
    isScheduled(uid) { const span = this.findSpan(uid); return !!span && this.composer.steps[span.step].bar < this.composer.lockedBars; }
    editContext(uid) {
        const span = this.findSpan(uid), c = this.composer;
        if (!span || span.step < 1) return null;
        const bar = c.steps[span.step].bar;
        if (bar < c.lockedBars || bar < this.firstEditableBar()) return null;
        const key = { ...c.steps[span.step].key };
        const candidates = c.candidates(span.step).map(x => ({ ...x, id: chordEntry(x.root, x.q, null).id, label: chordLabel(x.root, x.q, null, key) }));
        return { span, slot: { id: span.id, uid }, candidates, key };
    }
    edit(uid) {
        const context = this.editContext(uid);
        if (!context) return null;
        this.editIntent = { uid, step: context.span.step, revision: this.composer.revision, timeline: this.composer.timeline };
        return this.editIntent;
    }
    commitEdit(id) {
        const intent = this.editIntent, c = this.composer, chord = getChord(id);
        this.editIntent = null;
        let ok = false;
        if (intent && chord && intent.revision === c.revision && intent.timeline === c.timeline && this.editContext(intent.uid))
            ok = c.edit(intent.step, { root: chord.root, q: chord.qualityIndex }, chord.bass);
        if (ok) this.prefetchChart();
        this.notify();
        return ok;
    }

    // ------------------------------------------------------------- controls
    applyScene(id, at = null) {
        Object.assign(this.state, structuredClone(this.sceneFields(id)));
        this.state.scene = id;
        this.audio.setMix(this.state.mix, this.state.mutes, at ?? this.audio.context?.currentTime);
        if (at === null) { this.soundingScene = id; this.pendingScene = null; this.regenerate(); this.notify(); }
    }
    selectScene(id) {
        this.editIntent = null;
        if (!SCENES.some(s => s.id === id)) return;
        if (this.transport.running) {
            if (this.pendingScene === id) this.pendingScene = null;
            else { this.pendingScene = id; this.pendingSceneBar = this.firstEditableBar(); }
            this.regenerate();
            this.notify();
        } else this.applyScene(id);
    }
    saveScene(id) { this.saved[id] = snapshotScene(this.state); this.state.scene = id; this.notify(); }
    setParam(name, value) {
        if (name === 'bpm') {
            value = Math.max(40, Math.min(200, Number(value) || 92));
            if (this.transport.running) this.pendingBpm = value; else this.state.bpm = value;
        } else {
            this.state[name] = value;
            if (name === 'bassOn') { this.state.instrumentBoard.lanes.bass.enabled = !!value; if (!value) this.audio.stopGroup('bass'); }
            if (REGENERATING.has(name)) this.regenerate();
        }
        this.notify();
    }
    setMelody(on) { this.state.melodyOn = !!on; this.state.instrumentBoard.lanes.melody.enabled = !!on; if (!on) this.audio.stopGroup('melody'); this.notify(); }
    setKey(key) {
        this.editIntent = null;
        if (this.transport.running) {
            this.pendingKey = { ...key }; this.pendingKeyBar = this.firstEditableBar();
            this.regenerate();
        } else this.commitKey(key);
        this.notify();
    }
    commitKey(key) { this.state.key = { ...key }; this.pendingKey = null; this.newTimeline(null, key); this.prefetchChart(); }
    mix(role, value) { this.state.mix[role] = value; this.audio.setRoleMix(role, this.state.mix[role], this.state.mutes[role]); this.notify(); }
    mute(role) { this.state.mutes[role] = !this.state.mutes[role]; this.audio.setRoleMix(role, this.state.mix[role], this.state.mutes[role]); this.notify(); }
    setOrchestraEnabled(on) {
        const allOff = ORCHESTRA_GROUP_IDS.every(id => this.state.orchestra.groups[id] === 'off');
        for (const id of ORCHESTRA_GROUP_IDS) {
            const mode = on ? (allOff ? DEFAULT_ORCHESTRA_GROUPS[id] : this.state.orchestra.groups[id]) : 'off';
            this.state.instrumentBoard.lanes[id].enabled = mode !== 'off';
            this.state.instrumentBoard.lanes[id].walk = mode === 'auto';
            if (!on) this.audio.stopGroup(id);
        }
        this.syncOrchestra();
        this.audio.setOrchestra?.(this.state.orchestra);
        this.refreshArrangement();
        this.notify();
    }
    setOrchestraGroup(id, value) {
        if (!ORCHESTRA_GROUP_IDS.includes(id) || !['auto', 'on', 'off'].includes(value)) return false;
        this.state.instrumentBoard.lanes[id].enabled = value !== 'off';
        this.state.instrumentBoard.lanes[id].walk = value === 'auto';
        if (value === 'off') this.audio.stopGroup(id);
        this.syncOrchestra();
        this.audio.setOrchestra?.(this.state.orchestra);
        this.refreshArrangement();
        this.notify();
        return true;
    }
    setOrchestraMix(value) {
        this.state.orchestra.mix = Math.max(0, Math.min(1, Number(value) || 0));
        this.state.instrumentBoard.orchestraMix = this.state.orchestra.mix;
        this.audio.setOrchestra?.(this.state.orchestra);
        this.notify();
    }
    syncOrchestra() {
        for (const id of ORCHESTRA_GROUP_IDS) {
            const lane = this.state.instrumentBoard.lanes[id];
            this.state.orchestra.groups[id] = !lane.enabled ? 'off' : lane.walk ? 'auto' : 'on';
        }
        this.state.orchestra.enabled = ORCHESTRA_GROUP_IDS.some(id => this.state.orchestra.groups[id] !== 'off');
        this.state.orchestra.levels = Object.fromEntries(ORCHESTRA_GROUP_IDS.map(id => [id, this.state.instrumentBoard.lanes[id].level]));
    }
    setInstrumentBoard(raw) {
        this.state.instrumentBoard = this.composer.isV2 ? nativeInstrumentBoard(raw) : normalizeInstrumentBoard(raw);
        this.state.orchestra.mix = this.state.instrumentBoard.orchestraMix;
        this.state.bassOn = this.state.instrumentBoard.lanes.bass.enabled;
        this.state.melodyOn = this.state.instrumentBoard.lanes.melody.enabled;
        this.syncOrchestra();
        this.audio.setOrchestra?.(this.state.orchestra);
        this.refreshArrangement();
        this.notify();
    }
    setInstrumentMode(id, mode) {
        if (!INSTRUMENT_IDS.includes(id) || !['on', 'auto', 'off'].includes(mode)) return false;
        this.state.instrumentBoard.lanes[id].enabled = mode !== 'off';
        this.state.instrumentBoard.lanes[id].walk = mode === 'auto';
        if (mode === 'off') this.audio.stopGroup(id);
        if (id === 'bass') this.state.bassOn = mode !== 'off';
        if (id === 'melody') this.state.melodyOn = mode !== 'off';
        if (ORCHESTRA_GROUP_IDS.includes(id)) { this.syncOrchestra(); this.audio.setOrchestra?.(this.state.orchestra); this.refreshArrangement(); }
        this.notify();
        return true;
    }
    setInstrumentEnabled(id, enabled) {
        if (!INSTRUMENT_IDS.includes(id)) return false;
        this.state.instrumentBoard.lanes[id].enabled = !!enabled;
        if (!enabled) this.audio.stopGroup(id);
        if (id === 'bass') this.state.bassOn = !!enabled;
        if (id === 'melody') this.state.melodyOn = !!enabled;
        if (ORCHESTRA_GROUP_IDS.includes(id)) { this.syncOrchestra(); this.audio.setOrchestra?.(this.state.orchestra); this.refreshArrangement(); }
        this.notify();
        return true;
    }
    setInstrumentLaneWalk(id, walk) {
        if (!INSTRUMENT_IDS.includes(id)) return false;
        this.state.instrumentBoard.lanes[id].walk = !!walk;
        if (ORCHESTRA_GROUP_IDS.includes(id)) { this.syncOrchestra(); this.audio.setOrchestra?.(this.state.orchestra); }
        this.notify();
        return true;
    }
    setInstrumentRole(id, role) {
        if (!INSTRUMENT_IDS.includes(id) || !INSTRUMENT_ROLES.some(option => option.id === role)) return false;
        this.state.instrumentBoard.lanes[id].role = role;
        this.notify();
        return true;
    }
    setInstrumentLevel(id, value) {
        if (!INSTRUMENT_IDS.includes(id)) return false;
        const level = Math.max(0, Math.min(1, Number(value) || 0));
        if (ORCHESTRA_GROUP_IDS.includes(id)) {
            this.state.instrumentBoard.lanes[id].level = level;
            this.syncOrchestra(); this.audio.setOrchestra?.(this.state.orchestra);
        } else this.mix(id, level);
        this.notify();
        return true;
    }
    setInstrumentWalk(on) { this.state.instrumentBoard.walk = !!on; this.notify(); }
    setLearnedArrangement(on) { this.state.instrumentBoard.learnedArrangement = !!on; this.refreshArrangement(); this.notify(); }
    setInstrumentWalkEvery(value) {
        if (![1, 2, 4, 8, 16, 32].includes(Number(value))) return false;
        this.state.instrumentBoard.every = Number(value); this.notify(); return true;
    }

    /** Candidate A/B is an explicit new take, never a mid-bar model splice. */
    selectModel(model) {
        if (this.transport.running || this.transport.starting) return false;
        this.composer.replaceModel(model);
        this.newTimeline();
        this.prefetchChart();
        this.notify();
        return true;
    }

    // ------------------------------------------------------------- stop / restart
    stop() { this.transport.stop(); this.afterStop(); }
    afterStop() {
        this.composer.stop();
        const key = this.pendingKey ? { ...this.pendingKey } : { ...this.lastHeard.key };
        const chord = this.pendingKey ? null : this.lastHeard.chord;
        if (this.pendingBpm !== null) { this.state.bpm = this.pendingBpm; this.pendingBpm = null; }
        this.pendingScene = null; this.pendingKey = null; this.editIntent = null;
        this.state.key = key; this.soundingScene = this.state.scene;
        this.newTimeline(chord, key);
        this.notify();
        this.prefetchChart();
    }
}
