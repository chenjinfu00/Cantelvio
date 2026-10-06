/** Turn one generated bar into audio events.
 * The joint model decides when the accompaniment articulates (R: one note or
 * several), which chord sounds (H), and the bass and melody pitches (B, M). This
 * With a paired expression sidecar, exact notes and notated dynamics replace
 * the legacy coarse voicing rules. This module never calls the model. */
import { R_ONE, R_MULTI, R_HOLD } from './composer.js';
import { voiceChord } from './voicing.js';
import { INSTRUMENTS, BASS_INSTRUMENTS, MELODY_INSTRUMENTS, SUSTAINED, engineOf } from './instruments.js';

const SWING = [0, 1 / 3, 2 / 3, 5 / 6];
const ARPEGGIO = { 1: [0], 2: [0, 1], 3: [0, 2, 1, 2], 4: [0, 2, 1, 3] };
const VELOCITY = { harmony: [.58, .52, .47, .44], bass: [.72, .66, .6, .56], melody: [.68, .62, .58, .54] };
const GAP = .012;

/** Deterministic humanisation, independent of the generator's random stream. */
export function hash01(a, b, c) {
    let n = Math.imul(a | 0, 0x9E3779B1) ^ Math.imul(b | 0, 0x85EBCA77) ^ Math.imul(c | 0, 0xC2B2AE3D);
    n = Math.imul(n ^ (n >>> 16), 0x7FEB352D); n = Math.imul(n ^ (n >>> 15), 0x846CA68B); n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
}

export function stepClock(bpm, swing) {
    const beat = 60 / bpm;
    return pos => { const whole = Math.floor(pos / 4), f = pos % 4; return (whole + (swing ? SWING[f] : f / 4)) * beat; };
}

/** Model-written exact notes in a completed bar, stable keys for forecast/route. */
export function exactNotes(composer,index){
    const bar=composer.bars[index],steps=composer.barSteps(index),out=[],seen=new Set();
    if(!bar||!composer.expression)return out;
    for(let pos=0;pos<bar.barlen;pos++)for(const [slot,raw] of (steps[pos]?.expression||[]).entries()){
        const note=composer.expression.decode(raw);
        if(!Number.isFinite(note.subQuarter)||!Number.isFinite(note.durQuarter)||note.durQuarter<=0)continue;
        const onsetQuarter=pos/4+note.subQuarter;
        if(onsetQuarter>=bar.beats)continue;
        const identity=`${note.role}:${note.pitch}:${Math.round(onsetQuarter*1000)}`;
        if(seen.has(identity))continue;
        seen.add(identity);
        out.push({...note,key:`${steps[pos].g}:${slot}`,onsetQuarter,durationQuarter:note.durQuarter});
    }
    return out;
}

/** Notes actually heard from the continued backbone plus expression timing.
 * The sidecar's independent absolute-pitch head is retained for inspection but
 * must not replace the backbone's H/B/M music: its validation pitch losses are
 * still high. This keeps model-written non-chord bass/melody notes, while chord
 * attacks use the H voicing and all roles can borrow fractional timing/dynamics.
 */
export function performanceNotes(composer,index){
    if(composer.isV2)return composer.getExactNotes(index);
    const bar=composer.bars[index],steps=composer.barSteps(index);
    if(!bar||!composer.expression||!composer.barComplete(index))return [];
    const byStep=Array.from({length:bar.barlen},()=>[[],[],[]]);
    for(const note of exactNotes(composer,index)){
        const pos=Math.floor(note.onsetQuarter*4);
        if(pos>=0&&pos<bar.barlen)byStep[pos][note.role]?.push(note);
    }
    const out=[];
    const make=(role,pitch,onsetQuarter,durationQuarter,detail,key)=>{
        if(!(pitch>=0&&pitch<=127&&durationQuarter>0&&onsetQuarter<bar.beats))return;
        out.push({role,pitch,onsetQuarter,durationQuarter,key,
            ratioText:detail?.ratioText??'none',dynamicText:detail?.dynamicText??'unknown',
            accent:detail?.accent??0,wedge:detail?.wedge??0});
    };
    let voicing=[];
    const previous=composer.barSteps(index-1).at(-1)?.chord;
    if(previous)voicing=voiceChord(previous.root,previous.q);
    let chordKey=null,arp=0;
    for(let pos=0;pos<bar.barlen;pos++){
        const step=steps[pos],key=step.chord.root*64+step.chord.q;
        if(key!==chordKey){voicing=voiceChord(step.chord.root,step.chord.q,voicing);chordKey=key;arp=0;}
        const attack=step.R===R_ONE||step.R===R_MULTI||(step.R===R_HOLD&&(pos===0||step.change));
        if(attack){
            let end=pos+1;
            while(end<bar.barlen&&steps[end].R===R_HOLD&&!steps[end].change)end++;
            if(step.R===R_ONE){let next=pos+1;while(next<bar.barlen&&!steps[next].change)next++;end=Math.max(end,next);}
            const detail=byStep[pos][0][0],onset=pos/4+(detail?.subQuarter??0);
            const structuralEnd=end/4;
            const duration=Math.min(detail?.durQuarter??(structuralEnd-onset),structuralEnd-onset);
            const played=step.R===R_ONE?[voicing[ARPEGGIO[Math.min(4,voicing.length)][arp++%ARPEGGIO[Math.min(4,voicing.length)].length]%voicing.length]]:voicing;
            for(let i=0;i<played.length;i++)make(0,played[i],onset,duration,detail,`coarse:${step.g}:H:${i}`);
        }
        for(const [role,pitchKey,onKey,stream] of [[1,'bass','bassOn','B'],[2,'mel','melOn','M']]){
            const pitch=step[pitchKey];
            if(pitch<0)continue;
            const release=(composer.releaseAfter(stream,step.g)-bar.start)/4;
            // A sidecar onset while B/M is only holding often duplicates a
            // sustained note. Keep explicit coarse attacks and genuine
            // fractional tuplet articulations, not every independent guess.
            const details=step[onKey]?byStep[pos][role]:byStep[pos][role].filter(note=>note.ratioText!=='none'&&note.subQuarter>0);
            if(details.length){
                for(const detail of details){
                    const duration=Math.min(detail.durQuarter,release-detail.onsetQuarter);
                    make(role,pitch,detail.onsetQuarter,duration,detail,detail.key);
                }
            }else if(step[onKey])make(role,pitch,pos/4,release-pos/4,null,`coarse:${step.g}:${stream}`);
        }
    }
    out.sort((a,b)=>a.onsetQuarter-b.onsetQuarter||a.pitch-b.pitch);
    return out;
}

export function renderBar({ composer, index, state, bpm = state.bpm, nextBpm = bpm, voicing = [] }) {
    const bar = composer.bars[index], steps = composer.barSteps(index), n = bar.barlen;
    const swing = state.groove === 'swing', time = stepClock(bpm, swing), later = stepClock(nextBpm, swing);
    const duration = n / 4 * 60 / bpm;
    const at = rel => rel <= n ? (rel === n ? duration : time(rel)) : duration + later(rel - n);
    const feel = Math.max(0, Math.min(1, Number(state.feel) || 0));
    const human = (g, salt) => hash01(composer.timeline, g, salt) - .5;
    const events = [];
    const push = (role, instrument, g, pos, midi, endRel, velocity) => {
        const start = Math.max(0, time(pos) + (pos ? human(g, 11 + midi) * .012 * feel : 0));
        const length = at(endRel) - start - GAP;
        if (!(length > .02)) return;
        events.push({ role, midi, time: start, duration: length, velocity: Math.max(.08, Math.min(1, velocity * (1 + human(g, 29 + midi) * .16 * feel))), instrument, beat: pos / 4 });
    };
    if(composer.expression){
        // Exact score onset/duration are quarter-note fractions from the trained
        // sidecar. Never multiply by the tuplet ratio a second time: it is a
        // notation label, while sub/dur already encode the performed timing.
        const instruments=[engineOf(INSTRUMENTS,state.chordInstrument),
            engineOf(BASS_INSTRUMENTS,state.bassInstrument),engineOf(MELODY_INSTRUMENTS,state.melodyInstrument)];
        const roles=['harmony','bass','melody'];
        const dynamicLevel={pppp:.20,ppp:.27,pp:.35,p:.43,mp:.52,mf:.63,f:.73,ff:.84,fff:.92,ffff:.98,sf:.80,sfz:.86,sffz:.91,fp:.62,rfz:.76};
        for(const note of performanceNotes(composer,index)){
            const role=roles[note.role];
            if(!role)continue;
            const onset=note.onsetQuarter;
            const midi=note.pitch+(!composer.isV2&&role==='melody'&&state.melodyRegister==='high'?12:0);
            if(midi<0||midi>127)continue;
            const start=onset*60/bpm;
            const endQuarter=onset+Math.min(8,note.durationQuarter);
            const end=endQuarter<=bar.beats?endQuarter*60/bpm:duration+(endQuarter-bar.beats)*60/nextBpm;
            const noteDuration=Math.max(.025,end-start-GAP);
            const learned=note.velocity??dynamicLevel[note.dynamicText]??VELOCITY[role][steps[Math.min(steps.length-1,Math.floor(onset*4))].level];
            const accented=learned*(note.accent===2?1.17:note.accent===1?1.08:1);
            const velocity=Math.max(.08,Math.min(1,.6*(1-feel)+accented*feel));
            events.push({role,midi,time:start,duration:noteDuration,velocity,instrument:instruments[note.role],
                beat:onset,ratio:note.ratioText,dynamic:note.dynamicText,accent:note.accent,wedge:note.wedge,sourceKey:note.key,groupLogits:note.groupLogits,nativeGroup:composer.isV2?note.group:null,modelPitch:note.pitch,exactPitch:!!composer.isV2});
        }
        let last=null,notes=voicing;
        for(const step of steps){const key=step.chord.root*64+step.chord.q;if(last!==key){notes=voiceChord(step.chord.root,step.chord.q,notes);last=key;}}
        events.sort((a,b)=>a.time-b.time||a.midi-b.midi);
        return {events,duration,beats:bar.beats,signature:bar.signature,voicing:notes,stepTime:time};
    }
    // Accompaniment: voice the active chord at the rhythm stream's onsets.
    const chordEngine = engineOf(INSTRUMENTS, state.chordInstrument), pedal = !SUSTAINED.has(chordEngine);
    let current = null, notes = voicing, arp = 0;
    for (let pos = 0; pos < n; pos++) {
        const st = steps[pos], key = st.chord.root * 64 + st.chord.q;
        if (key !== current) { notes = voiceChord(st.chord.root, st.chord.q, notes); current = key; arp = 0; }
        const attack = st.R === R_ONE || st.R === R_MULTI || (st.R === R_HOLD && (pos === 0 || st.change));
        if (!attack) continue;
        let end = pos + 1;
        while (end < n && steps[end].R === R_HOLD && !steps[end].change) end++;
        if (st.R === R_ONE && pedal) { let p = pos + 1; while (p < n && !steps[p].change) p++; end = Math.max(end, p); }
        const velocity = VELOCITY.harmony[st.level] * (st.R === R_HOLD ? .72 : 1);
        const played = st.R === R_ONE ? [notes[ARPEGGIO[Math.min(4, notes.length)][arp++ % ARPEGGIO[Math.min(4, notes.length)].length] % notes.length]] : notes;
        for (const midi of played) push('harmony', chordEngine, st.g, pos, midi, end, velocity);
    }
    // Bass and melody: the model's own pitches; a note may continue into the next bar.
    const lines = [['bass', 'B', 'bass', 'bassOn', engineOf(BASS_INSTRUMENTS, state.bassInstrument), 0, state.bassOn !== false],
        ['melody', 'M', 'mel', 'melOn', engineOf(MELODY_INSTRUMENTS, state.melodyInstrument), state.melodyRegister === 'high' ? 12 : 0, !!state.melodyOn]];
    for (const [role, stream, pitch, on, engine, shift, enabled] of lines) {
        if (!enabled) continue;
        for (let pos = 0; pos < n; pos++) {
            const st = steps[pos];
            if (!st[on]) continue;
            const release = composer.releaseAfter(stream, st.g) - bar.start;
            push(role, engine, st.g, pos, st[pitch] + shift, release, VELOCITY[role][st.level]);
        }
    }
    events.sort((a, b) => a.time - b.time || a.midi - b.midi);
    return { events, duration, beats: bar.beats, voicing: notes, stepTime: time };
}
