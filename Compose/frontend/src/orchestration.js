/** Optional six-group accompaniment for the existing R/H/B/M timeline.
 * The group assignment is deterministic and untrained; the notes and chords
 * still come from the joint model. A learned arranger can replace this layer
 * without replacing the user's preferred joint-model checkpoint. */
import {hash01} from './render.js';

export const ORCHESTRA_GROUPS = Object.freeze([
  {id: 'woodwinds', en: 'Woodwinds', zh: '木管', instrument: 'reed-lead'},
  {id: 'brass', en: 'Brass', zh: '铜管', instrument: 'brass'},
  {id: 'percussion', en: 'Percussion', zh: '打击乐', instrument: 'percussion'},
  {id: 'keys', en: 'Harp / keys', zh: '竖琴／键盘', instrument: 'pluck'},
  {id: 'high_strings', en: 'High strings', zh: '高音弦乐', instrument: 'strings'},
  {id: 'low_strings', en: 'Low strings', zh: '低音弦乐', instrument: 'strings'},
]);
export const ORCHESTRA_GROUP_IDS = Object.freeze(ORCHESTRA_GROUPS.map(group => group.id));
export const DEFAULT_ORCHESTRA_GROUPS = Object.freeze(Object.fromEntries(
  ORCHESTRA_GROUP_IDS.map(id => [id, id.endsWith('strings') ? 'on' : 'auto'])));
const CHANCE = {woodwinds: .48, brass: .38, percussion: .62, keys: .60, high_strings: .82, low_strings: .82};

/** Route the model-written lines and chord voicings into six group note events.
 * `on` permits playing but does not force a new note; `off` excludes the group. */
export function routeJointBar(plan, groups, seed, barIndex) {
  const enabled = Object.fromEntries(ORCHESTRA_GROUP_IDS.map((id, i) => [id, groups[id] !== 'off' &&
    (groups[id] === 'on' || hash01(seed, barIndex, i + 91) < CHANCE[id])]));
  if (!Object.values(enabled).some(Boolean)) {
    const available = ORCHESTRA_GROUP_IDS.find(id => groups[id] !== 'off');
    if (available) enabled[available] = true;
  }
  const result = [];
  const add = (group, event, pitch = event.midi, velocity = event.velocity, drum = false, beat = event.beat) => {
    if (!enabled[group] || !Number.isFinite(pitch)) return;
    result.push({group, pitch: Math.max(0, Math.min(127, Math.round(pitch))), quarter: beat,
      duration: drum ? .18 : Math.max(.1, event.duration * plan.bpm / 60),
      velocity: Math.max(1, Math.min(127, Math.round(velocity * 110))), drum});
  };
  const melody = plan.events.filter(e => e.role === 'melody');
  const harmony = plan.events.filter(e => e.role === 'harmony');
  const bass = plan.events.filter(e => e.role === 'bass');
  for (const event of bass) {
    add('low_strings', event, event.midi < 36 ? event.midi + 12 : event.midi, event.velocity * .92);
    if (Math.abs(event.beat - Math.round(event.beat)) < .02 && Math.round(event.beat) % 2 === 0)
      add('brass', event, Math.max(43, event.midi + 12), event.velocity * .46);
  }
  for (const event of melody) {
    add('high_strings', event, event.midi, event.velocity * .79);
    if (barIndex % 2 === 0 || groups.woodwinds === 'on') add('woodwinds', event, event.midi, event.velocity * .68);
  }
  for (const event of harmony) {
    add('keys', event, event.midi, event.velocity * .59);
    if (Math.abs(event.beat - Math.round(event.beat)) < .02 && Math.round(event.beat) % 2 === 0)
      add('brass', event, event.midi < 52 ? event.midi + 12 : event.midi, event.velocity * .44);
  }
  const chordOnsets = [...new Set(harmony.map(e => Math.round(e.beat * 4) / 4))];
  for (const beat of chordOnsets) add('percussion', {midi: 42, velocity: .3, duration: .12, beat}, 42, .23, true);
  for (let beat = 0; beat < plan.beats; beat++) {
    const pitch = beat === 0 ? 36 : 38;
    add('percussion', {midi: pitch, velocity: .42, duration: .12, beat}, pitch, beat === 0 ? .42 : .25, true);
  }
  if (!melody.length && harmony.length) {
    const top = harmony.filter((e, i) => i === 0 || e.beat !== harmony[i - 1].beat)
      .map(e => harmony.filter(x => x.beat === e.beat).at(-1));
    for (const event of top) {
      add('high_strings', event, event.midi, event.velocity * .65);
      if (barIndex % 2 === 0) add('woodwinds', event, event.midi, event.velocity * .50);
    }
  }
  return result;
}

/** Convert the same group notes to the performance console's audio-event clock. */
export function liveOrchestraEvents(plan, groups, seed, barIndex) {
  const seconds = 60 / plan.bpm;
  return routeJointBar(plan, groups, seed, barIndex).map(note => ({
    role: note.group, instrument: ORCHESTRA_GROUPS.find(group => group.id === note.group).instrument,
    midi: note.pitch, time: note.quarter * seconds, duration: note.duration * seconds,
    velocity: note.velocity / 127, drum: note.drum,
  }));
}
