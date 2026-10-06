import test from "node:test";
import assert from "node:assert/strict";

import {
  CHORD_SHAPES,
  EDGE_DIRECTIONS,
  FIFTH_ORDER,
  PERIOD_CELL,
  PERIOD_VECTORS,
  circlePositions,
  planeViewportNotes,
  periodAddress,
  pitchClass,
  translatedCell,
  transposeFifthsMidis
} from "../public/tonnetz/learn.js";

test("the period cell contains all 12 pitch classes exactly once", () => {
  assert.equal(PERIOD_CELL.length, 12);
  assert.deepEqual([...new Set(PERIOD_CELL.map(({ pc }) => pc))].sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, pc) => pc));
});

test("period addresses partition the plane into translated 4 by 3 cells", () => {
  for (let i = -15; i <= 15; i += 1) {
    for (let j = -15; j <= 15; j += 1) {
      const { a, b, localI, localJ } = periodAddress(i, j);
      assert.equal(localI + 4 * b, i);
      assert.equal(localJ + 3 * a - b, j);
      assert.ok(localI >= 0 && localI < 4);
      assert.ok(localJ >= 0 && localJ < 3);
      assert.equal(pitchClass([localI, localJ]), pitchClass([i, j]));
    }
  }
});

test("edge directions encode the labeled Tonnetz intervals", () => {
  assert.equal(pitchClass(EDGE_DIRECTIONS.fifth), 7);
  assert.equal(pitchClass(EDGE_DIRECTIONS.majorThird), 4);
  assert.equal(pitchClass(EDGE_DIRECTIONS.minorThird), 3);
});

test("the plane viewport is filled yet stays below the unusable node count", () => {
  const notes = planeViewportNotes();
  assert.ok(notes.length >= 120);
  assert.ok(notes.length < 200);
  assert.ok(Math.min(...notes.map(({ x }) => x)) < 40);
  assert.ok(Math.max(...notes.map(({ x }) => x)) > 820);
  assert.ok(Math.min(...notes.map(({ y }) => y)) < 40);
  assert.ok(Math.max(...notes.map(({ y }) => y)) > 500);
  assert.deepEqual([...new Set(notes.map(({ pc }) => pc))].sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, pc) => pc));
});

test("both period vectors preserve pitch class at every representative", () => {
  for (const [di, dj] of PERIOD_VECTORS) {
    for (const { i, j, pc } of PERIOD_CELL) {
      assert.equal(pitchClass([i + di, j + dj]), pc);
    }
  }
  for (const [a, b] of [[-2, 3], [4, -1], [7, 5]]) {
    assert.deepEqual(translatedCell(a, b).map(({ pc }) => pc), PERIOD_CELL.map(({ pc }) => pc));
  }
});

test("the fifth traversal visits every pitch class and reuses circle coordinates", () => {
  assert.equal(new Set(FIFTH_ORDER).size, 12);
  FIFTH_ORDER.forEach((pc, step) => assert.equal(pc, (step * 7) % 12));
  assert.deepEqual(circlePositions(), circlePositions());
});

test("every chord coordinate maps to its declared sounding pitch class", () => {
  const expectedIds = ["C", "Cmaj7", "Cmaj9", "C7", "Cm", "Cm7", "Cm9", "Cdim7", "Caug", "Cdim", "Csus2", "Csus4"];
  assert.deepEqual(CHORD_SHAPES.map(({ id }) => id), expectedIds);
  for (const chord of CHORD_SHAPES) {
    const geometryPcs = chord.coords.map(pitchClass).sort((a, b) => a - b);
    const soundingPcs = chord.midis.map((midi) => ((midi % 12) + 12) % 12).sort((a, b) => a - b);
    assert.deepEqual(geometryPcs, soundingPcs, chord.id);
  }
});

test("moving a shape by one fifth transposes actual notes by seven semitones", () => {
  const cMajor = CHORD_SHAPES[0];
  assert.deepEqual(transposeFifthsMidis(cMajor.midis, 1), [67, 71, 74]);
  assert.deepEqual(transposeFifthsMidis(cMajor.midis, -1), [53, 57, 60]);
});
