import test from "node:test";
import assert from "node:assert/strict";
import { CHORDS, pitchClass } from "../public/shared/music-data.js";
import {
  CELL_REPRESENTATIVES, FIFTH_ORDER, FIXED_CHORD_GRID, PERIOD_VECTORS,
  edgeLegendSVG, fixedChordSVG, ringSVG, tonnetzCellSVG, translatedCell
} from "../public/karaoke/karaoke-geometry.js";

function ringPositions(svg) {
  return new Map([...svg.matchAll(/class="tone-node" data-pc="(\d+)" transform="translate\(([-\d.]+) ([-\d.]+)\)"/g)]
    .map((match) => [Number(match[1]), [Number(match[2]), Number(match[3])]]));
}

test("chromatic and fifth stages keep the same twelve nodes on one circle", () => {
  const chromatic = ringSVG();
  const fifths = ringSVG({ fifths: true });
  const first = ringPositions(chromatic), second = ringPositions(fifths);
  assert.equal(first.size, 12);
  assert.deepEqual(second, first);
  const links = [...fifths.matchAll(/class="fifth-link" data-fifth-step="(\d+)" data-from-pc="(\d+)" data-to-pc="(\d+)"/g)]
    .map((match) => ({ step: Number(match[1]), from: Number(match[2]), to: Number(match[3]) }));
  assert.equal(links.length, 12);
  links.forEach(({ step, from, to }) => {
    assert.equal(from, FIFTH_ORDER[step]);
    assert.equal(to, (from + 7) % 12);
  });
  assert.equal((fifths.match(/class="karaoke-ring/g) || []).length, 1, "there must not be a second fifths circle");
});

test("the one-cell view uses twelve unique representatives of (7i+4j) mod 12", () => {
  assert.equal(CELL_REPRESENTATIVES.length, 12);
  assert.deepEqual([...new Set(CELL_REPRESENTATIVES.map(({ pc }) => pc))].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
  CELL_REPRESENTATIVES.forEach(({ i, j, pc }) => assert.equal(pc, pitchClass([i, j])));
  const svg = tonnetzCellSVG();
  assert.equal((svg.match(/class="cell-note origin-cell"/g) || []).length, 12);
  assert.equal((svg.match(/class="cell-note/g) || []).length, 12);
});

test("expanded cells form a dense rectangular two-dimensional tiling without node overlap", () => {
  const determinant = PERIOD_VECTORS[0][0] * PERIOD_VECTORS[1][1] - PERIOD_VECTORS[0][1] * PERIOD_VECTORS[1][0];
  assert.equal(Math.abs(determinant), 12);
  for (const [a, b] of [[1, 0], [0, 1], [-2, 1]]) {
    translatedCell(a, b).forEach(({ i, j, pc }) => assert.equal(pitchClass([i, j]), pc));
  }
  const svg = tonnetzCellSVG(true);
  const copies = new Set([...svg.matchAll(/data-copy-a="(-?\d+)" data-copy-b="(-?\d+)"/g)].map((match) => `${match[1]},${match[2]}`));
  assert.equal(copies.size, 77);
  assert.deepEqual(new Set([...copies].map((copy) => copy.split(",")[0])), new Set(["-5", "-4", "-3", "-2", "-1", "0", "1", "2", "3", "4", "5"]));
  assert.deepEqual(new Set([...copies].map((copy) => copy.split(",")[1])), new Set(["-3", "-2", "-1", "0", "1", "2", "3"]));
  const nodes = [...svg.matchAll(/data-x="([-\d.]+)" data-y="([-\d.]+)" data-radius="([\d.]+)"/g)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]), radius: Number(match[3]) }));
  assert.equal(nodes.length, 77 * 12);
  let minimum = Infinity;
  for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
    minimum = Math.min(minimum, Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y));
  }
  assert.ok(minimum >= nodes[0].radius * 2, `node spacing ${minimum} must exceed diameter ${nodes[0].radius * 2}`);
  // Every 80-pixel tile of the panel has a nearby lattice point, including all corners.
  for (let x = 0; x <= 1140; x += 60) for (let y = 0; y <= 520; y += 40) {
    assert.ok(nodes.some(note => Math.hypot(note.x-x, note.y-y) < 55), `uncovered panel point ${x},${y}`);
  }
  assert.equal((svg.match(/class="cell-note origin-cell"/g) || []).length, 12);
});

test("all eight chord shapes share one labeled grid and one coordinate frame", () => {
  const expectedViewBox = 'viewBox="0 0 1100 560"';
  for (const chord of CHORDS) {
    const svg = fixedChordSVG(chord);
    assert.match(svg, new RegExp(expectedViewBox));
    assert.equal((svg.match(/class="fixed-key/g) || []).length, FIXED_CHORD_GRID.length);
    assert.equal((svg.match(/class="fixed-key is-highlight/g) || []).length, chord.coords.length);
    for (const [i, j] of chord.coords) assert.match(svg, new RegExp(`class="fixed-key is-highlight[^"]*" data-i="${i}" data-j="${j}"`));
    assert.equal((svg.match(/<text /g) || []).length, FIXED_CHORD_GRID.length, "every white hexagon must keep its note label");
  }
});

test("the playable edge legend encodes fifth, major third, and minor third accurately", () => {
  const svg = edgeLegendSVG();
  const entries = [...svg.matchAll(/data-interval="([^"]+)" data-semitones="(\d+)" data-from-midi="(\d+)" data-to-midi="(\d+)"/g)]
    .map((match) => [match[1], Number(match[2]), Number(match[4]) - Number(match[3])]);
  assert.deepEqual(entries, [["fifth", 7, 7], ["major-third", 4, 4], ["minor-third", 3, 3]]);
  assert.equal((svg.match(/role="button"/g) || []).length, 3);
});
