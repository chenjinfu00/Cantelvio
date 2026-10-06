import test from 'node:test';
import assert from 'node:assert/strict';
import {JointOrchestraBridge, JOINT_GROUPS, routeJointBar} from '../frontend/orchestra/joint-bridge.js';

test('six-group routing never emits a disabled group, including all-auto fallback', () => {
  const plan = {bpm: 96, beats: 4, events: [
    {role: 'harmony', midi: 60, time: 0, duration: .5, velocity: .7, beat: 0},
    {role: 'bass', midi: 36, time: 0, duration: .5, velocity: .7, beat: 0},
    {role: 'melody', midi: 67, time: 0, duration: .5, velocity: .7, beat: 0},
  ]};
  for (const group of JOINT_GROUPS) {
    const switches = Object.fromEntries(JOINT_GROUPS.map(id => [id, id === group ? 'on' : 'off']));
    const notes = routeJointBar(plan, switches, 1, 0);
    assert.ok(notes.length > 0, group);
    assert.ok(notes.every(note => note.group === group), group);
  }
  const auto = Object.fromEntries(JOINT_GROUPS.map(id => [id, id === 'keys' ? 'auto' : 'off']));
  for (let bar = 0; bar < 50; bar++) {
    assert.ok(routeJointBar(plan, auto, 918, bar).every(note => note.group === 'keys'));
  }
});

test('joint bridge continues from the same model timeline and exposes real chord spans', async () => {
  const settings = {seed: 316, style: 'lieder', changeMode: 'free'};
  const options = {tempo: 96, groups: Object.fromEntries(JOINT_GROUPS.map(id => [id, 'on']))};
  const a = new JointOrchestraBridge(settings);
  const b = new JointOrchestraBridge(settings);
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const first = await a.next(4, options);
    const second = await a.next(4, options);
    const combined = await b.next(8, options);
    assert.equal(first.firstBar, 0);
    assert.equal(second.firstBar, 4);
    assert.equal(first.totalQuarters, 16);
    assert.equal(second.harmony.length, 4);
    assert.deepEqual([...first.harmony, ...second.harmony], combined.harmony);
    assert.deepEqual([...first.notes, ...second.notes.map(n => ({...n, quarter: n.quarter + 16}))], combined.notes);
    for (const bar of [...first.harmony, ...second.harmony]) {
      assert.ok(bar.length > 0);
      assert.equal(bar.reduce((sum, span) => sum + span.lengthBeats, 0), 4);
      assert.ok(bar.every(span => span.name));
    }
  } finally { clearInterval(keepAlive); }
});
