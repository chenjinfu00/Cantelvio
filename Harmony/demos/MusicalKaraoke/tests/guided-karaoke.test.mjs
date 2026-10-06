import test from "node:test";
import assert from "node:assert/strict";
import { pitchClass } from "../public/shared/music-data.js";
import { GuidedRunGate, SequentialReveal } from "../public/karaoke/guided-state.js";
import {
  CHROMATIC_LABELS, FIFTH_PCS, PERIOD_VECTORS, TONNETZ_CELL,
  translatedCell, HARMONIC_CHORDS, CHORD_SHAPES, CLASSIC_VOICINGS
} from "../public/karaoke/karaoke-data.js";

test("a cancelled or stale run can never complete a guided step", () => {
  const gate = new GuidedRunGate();
  const first = gate.begin("choir", 0);
  assert.equal(gate.begin("choir", 0), null, "rapid second start must be rejected");
  gate.cancel();
  assert.equal(gate.finish(first, "choir", 0, true), false, "stop must invalidate natural-end callbacks");
  const second = gate.begin("choir", 0);
  assert.equal(gate.finish(second, "choir", 1, true), false, "a callback cannot unlock another step");
  assert.equal(gate.finish(second, "choir", 0, false), false, "errors never count as completion");
});

test("sequential examples unlock one at a time and replays cannot skip", () => {
  const reveal = new SequentialReveal(8);
  assert.equal(reveal.unlocked, 1);
  assert.equal(reveal.complete(1), false);
  assert.equal(reveal.complete(0), true);
  assert.equal(reveal.unlocked, 2);
  assert.equal(reveal.complete(0), false, "replay must not unlock another example");
  for (let i = 1; i < 8; i++) assert.equal(reveal.complete(i), true);
  assert.equal(reveal.done, true);
});

test("the Tonnetz cell is an exact 12-note period and both translations preserve pitch", () => {
  assert.equal(CHROMATIC_LABELS.length, 12);
  assert.deepEqual([...new Set(TONNETZ_CELL.map(({ pc }) => pc))].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
  assert.deepEqual(FIFTH_PCS, Array.from({ length: 12 }, (_, i) => (7 * i) % 12));
  assert.equal(Math.abs(PERIOD_VECTORS[0][0] * PERIOD_VECTORS[1][1] - PERIOD_VECTORS[0][1] * PERIOD_VECTORS[1][0]), 12);
  for (const [a, b] of [[1, 0], [0, 1], [-1, 1]]) {
    for (const note of translatedCell(a, b)) assert.equal(pitchClass([note.i, note.j]), note.pc);
  }
});

test("harmonic examples use local Tonnetz shapes and classic voicings are compact ascending pitches", () => {
  for (const name of HARMONIC_CHORDS) {
    const shape = CHORD_SHAPES[name];
    assert.ok(shape.coords.length >= 3);
    const [i0, j0] = shape.coords[0];
    assert.ok(shape.coords.every(([i, j]) => Math.max(Math.abs(i - i0), Math.abs(j - j0)) <= 2), `${name} is not local`);
    const voicing = CLASSIC_VOICINGS[name];
    assert.ok(voicing.every((midi, index) => index === 0 || midi > voicing[index - 1]), `${name} must ascend`);
    assert.ok(voicing.at(-1) - voicing[0] <= 10, `${name} must stay compact`);
  }
});
