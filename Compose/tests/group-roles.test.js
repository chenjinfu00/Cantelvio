import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeGroupRoles, roleLabel} from '../frontend/src/roles.js';
import {V2Composer} from '../frontend/src/v2-composer.js';
import {Session} from '../frontend/src/session.js';

const GROUPS = ['woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings'];
const note = (group, pitch, start, length, extra = {}) => ({group, pitch, start, end: start + length, velocity: .7, ...extra});
const line = (group, pitches, step, from = 0, extra = {}) => pitches.map((p, i) => note(group, p, from + i * step, step, extra));
const chord = (group, pitches, start, length, extra = {}) => pitches.map(p => note(group, p, start, length, extra));
const labels = (result, id, language = 'en') => result.groups[id].roles.map(r => roleLabel(r, language));

test('classic texture: melody on top, chords, bass and percussion', () => {
  const notes = [
    ...line('high_strings', [72, 74, 76, 77], 1), ...line('high_strings', [71, 72, 74, 72], 1, -4),
    ...chord('keys', [60, 64, 67], 0, 2), ...chord('keys', [60, 65, 69], 2, 2),
    note('low_strings', 36, 0, 4), note('low_strings', 43, -4, 4),
    ...line('percussion', [38, 38, 38, 38], 1),
  ];
  const result = analyzeGroupRoles({notes, beats: 4, groups: GROUPS});
  assert.deepEqual(labels(result, 'high_strings'), ['Melody 1']);
  assert.deepEqual(labels(result, 'keys'), ['Harmony']);
  assert.deepEqual(labels(result, 'low_strings'), ['Bass']);
  assert.deepEqual(labels(result, 'percussion'), ['Rhythm']);
  assert.equal(result.groups.brass.sounding, false);
  assert.deepEqual(result.groups.brass.roles, []);
  assert.equal(result.leadGroup, 'high_strings');
});

test('a countermelody becomes Melody 2 and a third line Melody 3', () => {
  const notes = [
    ...line('high_strings', [79, 77, 76, 74], 1), ...line('high_strings', [72, 74, 76, 77], 1, -4),
    ...line('woodwinds', [64, 65, 67, 65, 64, 62, 60, 62], .5), ...line('woodwinds', [60, 62, 64, 62], 1, -4),
    ...line('brass', [55, 57, 59, 60], 1), ...line('brass', [55, 53, 52, 53], 1, -4),
    note('low_strings', 36, 0, 4), note('low_strings', 41, -4, 4),
  ];
  const result = analyzeGroupRoles({notes, beats: 4, groups: GROUPS});
  assert.deepEqual(labels(result, 'high_strings'), ['Melody 1']);
  assert.deepEqual(labels(result, 'woodwinds'), ['Melody 2']);
  assert.deepEqual(labels(result, 'brass'), ['Melody 3']);
  assert.deepEqual(labels(result, 'low_strings', 'zh'), ['低音']);
});

test('octave doubling shares the melody number', () => {
  const tune = [72, 74, 76, 74];
  const notes = [
    ...line('high_strings', tune, 1), ...line('high_strings', [71, 72, 74, 72], 1, -4),
    ...line('woodwinds', tune.map(p => p - 12), 1), ...line('woodwinds', [59, 60, 62, 60], 1, -4),
    ...chord('keys', [48, 52, 55], 0, 4),
  ];
  const result = analyzeGroupRoles({notes, beats: 4, groups: GROUPS});
  assert.deepEqual(labels(result, 'high_strings'), ['Melody 1']);
  assert.deepEqual(labels(result, 'woodwinds'), ['Melody 1']);
});

test('one group can hold several roles', () => {
  const notes = [
    // keys: melody on top with sustained chords underneath (one part, two voices)
    ...line('keys', [76, 77, 79, 77], 1, 0, {voice: 'rh'}), ...line('keys', [74, 76, 77, 76], 1, -4, {voice: 'rh'}),
    ...chord('keys', [60, 64, 67], 0, 4, {voice: 'lh'}),
    // brass: the same chord repeated in steady eighths
    ...[0, .5, 1, 1.5, 2, 2.5, 3, 3.5].flatMap(t => chord('brass', [55, 60], t, .4)),
    note('low_strings', 36, 0, 4),
  ];
  const result = analyzeGroupRoles({notes, beats: 4, groups: GROUPS});
  assert.deepEqual(labels(result, 'keys'), ['Melody 1', 'Harmony']);
  assert.deepEqual(labels(result, 'brass'), ['Harmony', 'Rhythm']);
  assert.deepEqual(labels(result, 'low_strings'), ['Bass']);
  assert.deepEqual(labels(result, 'keys', 'zh'), ['旋律 1', '和声']);
});

test('two melodic voices inside one group are Melody 1 and Melody 2', () => {
  const notes = [
    ...line('woodwinds', [79, 77, 76, 77], 1, 0, {voice: 'flute'}), ...line('woodwinds', [76, 77, 79, 77], 1, -4, {voice: 'flute'}),
    ...line('woodwinds', [64, 62, 60, 62, 64, 65, 67, 65], .5, 0, {voice: 'clarinet'}),
    ...chord('keys', [48, 55], 0, 4),
  ];
  const result = analyzeGroupRoles({notes, beats: 4, groups: GROUPS});
  assert.deepEqual(labels(result, 'woodwinds'), ['Melody 1', 'Melody 2']);
});

test('v2 sampling lanes break ties toward the melody line, without lanes the texture decides', () => {
  // A melody-lane woodwind line under high harmony-lane chord tones.
  const notes = [
    ...line('woodwinds', [67, 69, 71, 72], 1, 0, {lane: 'melody'}), ...line('woodwinds', [64, 65, 67, 69], 1, -4, {lane: 'melody'}),
    ...line('keys', [76, 79, 84, 79], 1, 0, {lane: 'harmony'}), ...line('keys', [76, 72, 79, 84], 1, -4, {lane: 'harmony'}),
    note('low_strings', 36, 0, 4, {lane: 'bass'}),
  ];
  const withLanes = analyzeGroupRoles({notes, beats: 4, groups: GROUPS});
  assert.deepEqual(labels(withLanes, 'woodwinds'), ['Melody 1']);
  assert.deepEqual(labels(withLanes, 'keys'), ['Harmony']);
  const textureOnly = analyzeGroupRoles({notes: notes.map(({lane, ...n}) => n), beats: 4, groups: GROUPS});
  assert.deepEqual(labels(textureOnly, 'keys'), ['Melody 1']);
  assert.deepEqual(labels(textureOnly, 'woodwinds'), ['Melody 2']);
});

test('carried-over sound counts, silence and invalid notes do not', () => {
  const notes = [note('keys', 60, -2, 4), note('keys', 64, -2, 4), note('brass', 70, -4, 2), {group: 'woodwinds', pitch: null, start: 0, end: 1}];
  const result = analyzeGroupRoles({notes, beats: 3, groups: GROUPS});
  assert.equal(result.groups.keys.sounding, true);
  assert.equal(result.groups.brass.sounding, false);
  assert.equal(result.groups.woodwinds.sounding, false);
  assert.deepEqual(analyzeGroupRoles({notes: [], beats: 4, groups: GROUPS}).leadGroup, null);
});

// Session wiring with a fake v2 server: roles follow the audible bar and switches.
function fixture() {
  const fetcher = async (url, request) => {
    if (url.endsWith('stop')) return {ok: true, json: async () => ({stopped: true})};
    const o = JSON.parse(request.body), i = o.index;
    const melody = [72, 74, 76, 77].map((p, k) => ({pitch: p + (i % 2), onsetQuarter: k, durationQuarter: 1, role: 2, group: 'woodwinds', voice: 'console-melody/1/1'}));
    const harmony = [60, 64, 67].map(p => ({pitch: p, onsetQuarter: 0, durationQuarter: 4, role: 0, group: 'keys', voice: 'console-harmony/1/1'}));
    const bass = [{pitch: 36, onsetQuarter: 0, durationQuarter: 4, role: 1, group: 'low_strings', voice: 'console-bass/1/1'}];
    const notes = [...melody, ...harmony, ...bass].map((n, k) => ({velocity: .6, ratioText: 'none', dynamicText: 'mf', accent: 0, wedge: 0, key: `${i}:${k}`, ...n}));
    const spans = [{offset: 0, ...o.chord, change: true, candidates: []}];
    return {ok: true, json: async () => ({session: 'b'.repeat(8) + '-bbbb-bbbb-bbbb-' + 'b'.repeat(12), index: i, notes, spans})};
  };
  const audio = {context: {currentTime: 0, state: 'running'}, panic() {}, setMix() {}, setOrchestra() {}, stopGroup() {}, setRoleMix() {}};
  return new Session(audio, {composerClass: V2Composer, composerOptions: {fetcher, random: () => .5}});
}

test('session role view previews the next bar, then follows the bar being heard', async () => {
  const session = fixture();
  await session.prefetchChart();
  const preview = session.roleView();
  assert.equal(preview.now, false);
  assert.equal(preview.bar, 0);
  assert.deepEqual(preview.groups.woodwinds.roles, [{role: 'melody', rank: 1}]);
  assert.deepEqual(preview.groups.keys.roles, [{role: 'harmony'}]);
  assert.deepEqual(preview.groups.low_strings.roles, [{role: 'bass'}]);
  assert.equal(preview.groups.brass.enabled, false);

  session.boundary({bar: 0, first: true});
  session.boundary({bar: 1, first: false});
  session.transport.running = true;
  session.transport.frame = {bar: 0, start: 0, duration: 2.6, beats: 4};
  const heard = session.roleView();
  assert.equal(heard.now, true);
  assert.equal(heard.bar, 0);
  session.transport.frame = {bar: 1, start: 2.6, duration: 2.6, beats: 4};
  assert.equal(session.roleView().bar, 1);
  assert.equal(session.roleView(), session.roleView(), 'cached between renders');

  // Switching a group off silences it at once; the status reflects that.
  session.setInstrumentEnabled('woodwinds', false);
  const muted = session.roleView();
  assert.equal(muted.groups.woodwinds.enabled, false);
  assert.equal(muted.groups.woodwinds.sounding, false);
  // A group switched on mid-bar was not scheduled for this bar: it rests until the next.
  session.setInstrumentEnabled('brass', true);
  assert.equal(session.roleView().groups.brass.active, false);
  session.transport.running = false; session.transport.frame = null;
  session.stop();
  assert.equal(session.roleBars.size, 0);
});
